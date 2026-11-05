'use strict';

// The phone companion: what the sidebar shows, on your phone, and a notification when a session
// turns Ready, Needs you or Error or a new eTL bubble comes (CONSTRAINTS.md, Phone companion). Off
// by default; while it's off the pet listens on nothing and sends nothing.
//
// Turning it on starts the web server (server.js) on 127.0.0.1. The phone reaches it through
// Tailscale Serve on the user's own tailnet, which the pet sets up only when asked (Pair a phone…).
// A phone pairs with a six-digit code the pet shows; it keeps a cookie for that, and the pet keeps
// only the cookie's hash. Notifications go by Web Push (webpush.js), encrypted for that phone.
//
// <userData>/phone.json: { vapid: { publicKey, privateKey }, devices: [{ id, name, tokenHash,
// createdAt, subscription }] }

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { execFile } = require('node:child_process');
const { createPhoneServer } = require('./server');
const { phoneView, opensOf, openOfKind } = require('./view');
const { pushEvents, LABELS, NOTICE_SOURCES } = require('./notify');
const { Pusher, generateVapidKeys, validSubscription } = require('./webpush');

const DEFAULT_PORT = 47823;
const CODE_TTL_MS = 10 * 60_000;
const CODE_TRIES = 5;
const MAX_DEVICES = 8;
const REBUILD_MS = 250;
const CLOCK_MS = 60_000;          // the list is looked at again this often, for what buzzes by the clock
const SAMPLE_MS = 10 * 60_000;    // how long a sample eTL notice stays on the phone
const MAX_LINK = 1000;            // a longer address stays out of a notification, which has 4 KB
const SUBJECT = 'https://github.com/hyukjunlim/ttokttok-pet';
const TAILSCALE_DOWNLOAD = 'https://tailscale.com/download';
const clip = (s, n) => (String(s || '').length > n ? `${String(s).slice(0, n - 1)}…` : String(s || ''));
const hash = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

class PhoneFeature extends EventEmitter {
  // electron: { dialog, shell, clipboard }. snapshot(): { hosts, notices, usage, chatUrl } for view.js.
  // sampleNotice(): { title, project, url } for a sample eTL notice (an upcoming assignment's).
  // icon(size): PNG bytes. request (https.request) and port (0: any free one) are for tests.
  constructor({
    electron, settings, userData, log = () => {}, snapshot = () => ({}), icon = () => null,
    sampleNotice = () => ({ title: 'eTL', project: '', url: 'https://myetl.snu.ac.kr/' }),
    execFileFn = execFile, env = process.env, now = Date.now, request, port = null,
  }) {
    super();
    Object.assign(this, { electron, settings, log, snapshot, icon, sampleNotice, execFileFn, env, now, request, fixedPort: port });
    this.samples = [];           // sample eTL notices on the phone, each until its `until`
    this.sampleTimer = null;
    this.setup = { tailscale: null, busy: null, error: null };   // Getting started's Phone step (setupState)
    this.file = path.join(userData, 'phone.json');
    this.server = null;
    this.listening = null;       // the port it listens on, once it does
    this.code = null;            // { code, until, tries } while a phone may pair
    this.view = { etag: '"0"', body: '{"hosts":[],"notices":[],"usage":[]}' };
    this.opens = new Map();      // what a tap on each of the view's rows opens (view.js's opensOf)
    this.rebuildTimer = null;
    this.memory = null;          // notify.js's, from the last list of sessions
    this.saved = null;           // phone.json, once read
    this.sender = null;          // the Pusher, once there's a key
  }

  // phone.json, read the first time it's needed; nothing is written until there's something to keep.
  get store() {
    if (!this.saved) this.saved = this.#load();
    return this.saved;
  }

  // The VAPID key pair, made the first time the phone companion runs.
  get pusher() {
    if (!this.store.vapid) {
      this.store.vapid = generateVapidKeys();
      this.#save();
    }
    if (!this.sender) this.sender = new Pusher({ keys: this.store.vapid, subject: SUBJECT, ...(this.request && { request: this.request }), now: this.now });
    return this.sender;
  }

  get enabled() {
    return this.settings.get('phone') === true;
  }

  get port() {
    if (this.fixedPort != null) return this.fixedPort;
    const p = Number(this.settings.get('phonePort'));
    return Number.isInteger(p) && p > 1024 && p < 65536 ? p : DEFAULT_PORT;
  }

  get devices() {
    return this.store.devices;
  }

  // At launch: picks up where the last run left off.
  async start() {
    if (this.enabled) await this.#listen();
  }

  stop() {
    clearInterval(this.clock);
    this.clock = null;
    this.last = null;
    clearTimeout(this.rebuildTimer);
    this.rebuildTimer = null;
    clearTimeout(this.sampleTimer);
    this.sampleTimer = null;
    this.samples = [];
    const server = this.server;
    this.server = null;
    this.listening = null;
    this.memory = null;
    this.opens = new Map();
    this.code = null;
    server?.close();
    server?.closeAllConnections?.();
  }

  // `quiet`: without the pairing dialogs (Getting started shows those steps itself).
  async setEnabled(on, { quiet = false } = {}) {
    this.settings.set({ phone: on });
    if (!on) {
      this.stop();
      this.emit('setup');
      return;
    }
    await this.#listen();
    this.emit('setup');
    if (!quiet) await this.showPairing();
  }

  // ---------------------------------------------------------------- Getting started's Phone step

  // Where the setup stands, for the step's page (onboarding.js): whether it's on and serving,
  // Tailscale as last checked ({ installed, running, name, served }), what's under way ('check' or
  // 'serve'), what Tailscale said when Serve didn't start, the pairing code while it's good, and
  // how many phones are paired and take notifications.
  setupState() {
    const ts = this.setup.tailscale;
    const code = this.code && this.now() < this.code.until ? this.code.code : null;
    return {
      on: this.enabled,
      serving: this.listening != null,
      port: this.port,
      tailscale: ts,
      address: ts?.name ? `https://${ts.name}/` : null,
      busy: this.setup.busy,
      error: this.setup.error,
      code,
      paired: this.devices.length,
      notifying: this.devices.filter((d) => d.subscription).length,
    };
  }

  async checkSetup() {
    if (this.setup.busy) return;
    this.setup.busy = 'check';
    this.emit('setup');
    try {
      this.setup.tailscale = await this.tailscale().catch(() => ({ installed: false, running: false, name: null, served: false }));
    } finally {
      this.setup.busy = null;
      this.emit('setup');
    }
  }

  // Serve for the step: what Tailscale says when it doesn't start (say, to turn HTTPS on for the
  // tailnet first) is kept for the page to show.
  async serveForSetup() {
    if (this.setup.busy) return;
    this.setup.busy = 'serve';
    this.setup.error = null;
    this.emit('setup');
    try {
      await this.serve();
    } catch (err) {
      this.setup.error = clip(err.message, 600);
    } finally {
      this.setup.busy = null;
    }
    await this.checkSetup();
  }

  // A fresh pairing code for the step, in place of any earlier one.
  codeForSetup() {
    const code = this.newCode();
    this.emit('setup');
    return code;
  }

  // The tree, the notices or the weekly limits changed: the page gets them on its next look.
  changed() {
    if (!this.server || this.rebuildTimer) return;
    this.rebuildTimer = setTimeout(() => {
      this.rebuildTimer = null;
      this.#rebuild();
    }, REBUILD_MS);
  }

  // main.js's merged list of sessions: notifications for what turned Ready, Needs you or Error,
  // and for eTL's, Slack's and TodoMate's notices (notify.js). `hidden`: the sessions hidden from
  // the sidebar (id -> when), which don't buzz, and neither does what's turned off under Phone →
  // Notifications. Looked at again every minute (CLOCK_MS), for TodoMate's schedule items, which
  // buzz by the clock. A tap on a notification opens what a tap on its row opens.
  observe(sessions, hidden = {}) {
    if (!this.server) return;
    this.last = { sessions, hidden };
    if (!this.clock) {
      this.clock = setInterval(() => this.observe(this.last.sessions, this.last.hidden), CLOCK_MS);
      this.clock.unref?.();
    }
    const statuses = this.settings.get('phoneSessionPush') ?? {};
    const notices = this.settings.get('phoneNoticePush') ?? {};
    const muted = (s) => Object.hasOwn(hidden, s.id)
      || (Object.hasOwn(NOTICE_SOURCES, s.kind) ? notices[s.kind] === false : statuses[s.status] === false);
    const { memory, events } = pushEvents(this.memory, sessions, this.now(), muted);
    this.memory = memory;
    if (!events.length) return;
    this.#rebuild();   // the rows as they are now, for what each notification opens
    for (const e of events) {
      this.#notify({ title: clip(e.title, 120), body: clip(e.body, 160), tag: e.tag, id: e.id, open: this.#openOf(e.id, e.kind) });
    }
  }

  // ---------------------------------------------------------------- what server.js asks

  api() {
    return {
      pair: (p) => this.#pair(p),
      device: (token) => (token ? this.devices.find((d) => d.tokenHash === hash(token)) ?? null : null),
      state: () => this.view,
      vapidKey: () => this.pusher.keys.publicKey,
      subscribe: (device, sub) => {
        if (!validSubscription(sub)) return false;
        device.subscription = { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } };
        this.#save();
        this.emit('setup');
        return true;
      },
      unsubscribe: (device) => {
        device.subscription = null;
        this.#save();
        this.emit('setup');
      },
      testPush: (device) => this.#push(device, { title: 'Ttokttok Pet', body: 'Notifications work on this phone.', tag: 'test', id: null }),
      unpair: (device) => this.forget(device.id),
    };
  }

  // Tray → Phone → "Send a sample eTL notice": a 테스트 notice in the phone's list for a while, and a
  // notification for it, to try the way into LearningX without waiting for eTL to have news.
  showSample() {
    if (!this.server) return null;
    const s = this.sampleNotice();
    const id = `etl:sample:${this.now()}`;
    this.samples = [...this.samples, {
      id, kind: 'etl', status: 'review', badge: '테스트', title: s.title || 'eTL', project: s.project || '', url: s.url, until: this.now() + SAMPLE_MS,
    }];
    this.#rebuild();
    clearTimeout(this.sampleTimer);
    this.sampleTimer = setTimeout(() => {
      this.sampleTimer = null;
      this.samples = this.samples.filter((x) => x.until > this.now());
      this.#rebuild();
    }, SAMPLE_MS + 1000);
    this.sampleTimer.unref?.();
    this.#notify({ title: clip(`테스트 · ${s.title || 'eTL'}`, 120), body: 'Tap to open it in LearningX.', tag: id, id, open: this.#openOf(id, 'etl') });
    return id;
  }

  forget(id = null) {
    this.store.devices = id ? this.devices.filter((d) => d.id !== id) : [];
    this.#save();
    this.emit('setup');
  }

  // ---------------------------------------------------------------- pairing and Tailscale

  newCode() {
    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    this.code = { code, until: this.now() + CODE_TTL_MS, tries: 0 };
    return code;
  }

  #pair({ code, name }) {
    const c = this.code;
    if (!c || this.now() > c.until) return null;
    const given = Buffer.from(String(code).replace(/\D/g, ''));
    const ok = given.length === 6 && crypto.timingSafeEqual(given, Buffer.from(c.code));
    if (!ok) {
      if (++c.tries >= CODE_TRIES) this.code = null;
      return null;
    }
    this.code = null;                     // one phone per code
    const token = crypto.randomBytes(32).toString('base64url');
    const device = { id: crypto.randomUUID(), name: clip(name.trim() || 'Phone', 40), tokenHash: hash(token), createdAt: this.now(), subscription: null };
    this.store.devices = [...this.devices, device].slice(-MAX_DEVICES);
    this.#save();
    this.emit('paired', device);
    this.emit('setup');
    return token;
  }

  // Where Tailscale is, its state and this PC's name on the tailnet, and whether Serve already
  // sends the tailnet's https to this port: { installed, running, name, served }.
  async tailscale() {
    const exe = await this.#tailscaleExe();
    if (!exe) return { installed: false, running: false, name: null, served: false };
    let status = null;
    try {
      status = JSON.parse(await this.#run(exe, ['status', '--json']));
    } catch {
      // not signed in, or the service isn't running
    }
    const name = typeof status?.Self?.DNSName === 'string' ? status.Self.DNSName.replace(/\.$/, '') : null;
    let served = false;
    try {
      served = (await this.#run(exe, ['serve', 'status', '--json'])).includes(`127.0.0.1:${this.port}`);
    } catch {
      // no Serve set up
    }
    return { installed: true, running: status?.BackendState === 'Running', name, served };
  }

  // tailscale serve --bg: https://<name>.ts.net/ on the tailnet goes to the pet's port, and stays so
  // across restarts. The first time, Tailscale may ask to turn HTTPS on for the tailnet; what it
  // says comes back as the error.
  async serve() {
    const exe = await this.#tailscaleExe();
    if (!exe) throw new Error('Tailscale is not installed');
    return this.#run(exe, ['serve', '--bg', `http://127.0.0.1:${this.port}`]);
  }

  // The tray's "Pair a phone…": the address and a fresh code, and Tailscale's setup if it's needed.
  async showPairing() {
    if (!this.enabled) return;
    const { dialog, shell, clipboard } = this.electron;
    const ts = await this.tailscale().catch(() => ({ installed: false }));
    if (!ts.installed || !ts.running || !ts.name) {
      const { response } = await dialog.showMessageBox({
        type: 'info',
        title: 'Ttokttok Pet',
        message: ts.installed ? 'Sign in to Tailscale on this PC' : 'The phone reaches this PC through Tailscale',
        detail: 'Install Tailscale on this PC and on your phone, and sign in to both with the same account. '
          + 'Only your own devices can reach the pet that way; nothing is open to the internet. '
          + `Then choose Pair a phone… again.\n\nOn this PC itself the page is at http://127.0.0.1:${this.port}/`,
        buttons: ['Open tailscale.com/download', 'Close'],
        defaultId: 0,
        cancelId: 1,
      });
      if (response === 0) shell.openExternal(TAILSCALE_DOWNLOAD);
      return;
    }
    if (!ts.served) {
      const { response } = await dialog.showMessageBox({
        type: 'question',
        title: 'Ttokttok Pet',
        message: `Let your tailnet reach the pet at https://${ts.name}/?`,
        detail: `This runs "tailscale serve --bg http://127.0.0.1:${this.port}". Only devices signed in to your tailnet can open it; `
          + 'it stays set up until you turn it off with "tailscale serve reset".',
        buttons: ['Set it up', 'Cancel'],
        defaultId: 0,
        cancelId: 1,
      });
      if (response !== 0) return;
      try {
        await this.serve();
      } catch (err) {
        await dialog.showMessageBox({
          type: 'warning', title: 'Ttokttok Pet', message: 'Tailscale Serve didn\'t start', detail: clip(err.message, 900), buttons: ['Close'],
        });
        return;
      }
    }
    const url = `https://${ts.name}/`;
    const code = this.newCode();
    const { response } = await dialog.showMessageBox({
      type: 'info',
      title: 'Ttokttok Pet',
      message: `Pairing code: ${code.slice(0, 3)} ${code.slice(3)}`,
      detail: `On your phone, with Tailscale on, open\n${url}\nand enter the code. It works once, for the next 10 minutes.\n\n`
        + 'Then add the page to the Home Screen (on an iPhone that is needed for notifications) and turn notifications on there.',
      buttons: ['Copy the address', 'Close'],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) clipboard.writeText(url);
  }

  // The tray menu's "Phone" submenu.
  menu() {
    const on = this.enabled;
    const subscribed = this.devices.filter((d) => d.subscription);
    const items = [
      {
        label: 'Show the sidebar on my phone, with notifications',
        type: 'checkbox',
        checked: on,
        click: (mi) => this.setEnabled(mi.checked).catch((err) => this.log('phone:', err.message)),
      },
      { label: 'Pair a phone…', enabled: on, click: () => this.showPairing().catch((err) => this.log('phone:', err.message)) },
      { label: 'Notifications', enabled: on, submenu: this.#pushMenu() },
      {
        label: 'Send a test notification',
        enabled: on && subscribed.length > 0,
        click: () => this.#notify({ title: 'Ttokttok Pet', body: 'Notifications work on this phone.', tag: 'test', id: null }),
      },
      { label: 'Send a sample eTL notice', enabled: on && this.devices.length > 0, click: () => this.showSample() },
    ];
    if (this.devices.length) {
      items.push({ type: 'separator' }, {
        label: `Paired phones (${this.devices.length})`,
        submenu: [
          ...this.devices.map((d) => ({ label: `Forget ${d.name}${d.subscription ? '' : ' (notifications off)'}`, click: () => this.forget(d.id) })),
          { type: 'separator' },
          { label: 'Forget them all', click: () => this.forget() },
        ],
      });
    }
    if (on && this.listening == null) items.push({ type: 'separator' }, { label: `Port ${this.port} is taken; nothing is served`, enabled: false });
    return { label: 'Phone', submenu: items };
  }

  // What buzzes the phone: each session status, and each source of notices (notify.js).
  #pushMenu() {
    const item = (key, value, label) => ({
      label,
      type: 'checkbox',
      checked: this.settings.get(key)?.[value] !== false,
      click: (mi) => this.settings.set({ [key]: { ...this.settings.get(key), [value]: mi.checked } }),
    });
    return [
      item('phoneSessionPush', 'review', `Session: ${LABELS.review} (a turn finished)`),
      item('phoneSessionPush', 'waiting', `Session: ${LABELS.waiting} (waiting for your answer or approval)`),
      item('phoneSessionPush', 'failed', `Session: ${LABELS.failed}`),
      { type: 'separator' },
      item('phoneNoticePush', 'etl', 'eTL: new notices, assignments, grades, 마감 임박'),
      item('phoneNoticePush', 'slack', 'Slack 발표: D-Day every day at 06:00, 순서 변경'),
      item('phoneNoticePush', 'todomate', '투두메이트: D-Day at 06:00, schedule 15 min before'),
    ];
  }

  // ---------------------------------------------------------------- inside

  #rebuild() {
    let view;
    try {
      const snap = this.snapshot();
      const samples = this.samples.filter((x) => x.until > this.now());
      view = phoneView({ ...snap, notices: [...samples, ...(snap.notices || [])] });
    } catch (err) {
      this.log('phone view:', err.message);
      return;
    }
    const body = JSON.stringify(view);
    this.view = { etag: `"${crypto.createHash('sha1').update(body).digest('base64url')}"`, body };
    this.opens = opensOf(view);
  }

  // What a notification for `id` opens: its row's app and page, else its kind's app.
  #openOf(id, kind) {
    const open = this.opens.get(id) ?? openOfKind(kind);
    return open && open.url.length <= MAX_LINK ? open : null;
  }

  #notify(message) {
    for (const d of this.devices) {
      if (d.subscription) this.#push(d, message).catch((err) => this.log('phone push:', err.message));
    }
  }

  async #push(device, message) {
    if (!device.subscription) throw new Error('notifications are off on this phone');
    const r = await this.pusher.send(device.subscription, message, { topic: message.tag });
    if (r.gone) {
      device.subscription = null;
      this.#save();
      this.log(`phone push: ${device.name} no longer takes notifications`);
    } else if (r.status >= 400) {
      this.log(`phone push: ${device.name}: the push service answered ${r.status}`);
    }
    return r;
  }

  async #listen() {
    if (this.server) return;
    const server = createPhoneServer({ api: this.api(), icon: this.icon, log: this.log });
    this.server = server;
    await new Promise((resolve) => {
      server.once('error', (err) => {
        this.log(`phone server: ${err.message}`);
        if (this.server === server) this.server = null;
        resolve();
      });
      server.listen(this.port, '127.0.0.1', () => {
        this.listening = server.address().port;
        this.log(`phone: serving on 127.0.0.1:${this.listening}`);
        resolve();
      });
    });
    if (this.server) this.#rebuild();
  }

  async #tailscaleExe() {
    const candidates = [
      'tailscale',
      ...[this.env.ProgramFiles, this.env['ProgramFiles(x86)']].filter(Boolean).map((d) => path.join(d, 'Tailscale', 'tailscale.exe')),
    ];
    for (const exe of candidates) {
      if (exe !== 'tailscale' && !fs.existsSync(exe)) continue;
      try {
        await this.#run(exe, ['version']);
        return exe;
      } catch {
        // not this one
      }
    }
    return null;
  }

  #run(exe, args) {
    return new Promise((resolve, reject) => {
      this.execFileFn(exe, args, { windowsHide: true, timeout: 20_000 }, (err, stdout, stderr) => {
        if (err) reject(new Error(String(stderr || stdout || err.message).trim()));
        else resolve(String(stdout));
      });
    });
  }

  #load() {
    let saved = null;
    try {
      saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      // first run
    }
    const vapid = typeof saved?.vapid?.publicKey === 'string' && typeof saved?.vapid?.privateKey === 'string' ? saved.vapid : null;
    const devices = Array.isArray(saved?.devices)
      ? saved.devices.filter((d) => d && typeof d.id === 'string' && typeof d.tokenHash === 'string')
        .map((d) => ({ ...d, subscription: validSubscription(d.subscription) ? d.subscription : null }))
      : [];
    return { vapid, devices };
  }

  #save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(this.store, null, 2)}\n`);
      fs.renameSync(tmp, this.file);
    } catch (err) {
      this.log('phone store:', err.message);
    }
  }
}

module.exports = { PhoneFeature, DEFAULT_PORT };
