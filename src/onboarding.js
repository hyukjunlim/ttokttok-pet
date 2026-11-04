'use strict';

// Getting started: a window that walks a new user through the setup, a step at a time (the mode,
// Claude's live usage, SNU eTL, TodoMate, Slack, the web chats extension, the phone), then has them
// try the pet itself on practice items: a bubble next to the floating pet, or two sessions at the
// top of the sidebar.
// It opens on the first start, and from the tray menu. The steps act through main.js (`actions`);
// the page (renderer/onboarding.*) gets what it shows from `state()`.

const path = require('node:path');
const { BrowserWindow, clipboard, nativeTheme } = require('electron');

const PRACTICE_PET = 'practice:bubble';
const PRACTICE_ROWS = ['practice:answer', 'practice:read'];
// What each mode's practice asks for, in the page's order (renderer/onboarding.js).
const TRIES = {
  pet: ['click', 'dismiss', 'hide', 'menu'],
  folder: ['click', 'step', 'rowMenu', 'hide', 'menu'],
};
const ACTIONS = new Set([
  'mode', 'usage', 'etl', 'todomate', 'slack', 'web', 'extensionFolder', 'phone', 'phoneCheck', 'phoneServe', 'phoneCode', 'phoneOpen',
  'copy', 'doc', 'practice', 'refresh', 'close',
]);
const MAX_COPY = 500;
// The only pages the phone step opens: Tailscale's download page and its admin console (where
// HTTPS certificates are turned on), or a link of Tailscale's own from what it said.
const TAILSCALE_LINK = /^https:\/\/(login\.)?tailscale\.com\/[^\s]*$/;

class GettingStarted {
  // state(): what the page shows (see main.js). actions: { mode(m), usage(keys), etl(), todomate(),
  // slack(), web(on), extensionFolder(), phone(on), phoneCheck(), phoneServe(), phoneCode(),
  // phoneOpen(url), doc(name) },
  // each may return a promise; changed(): the practice items came
  // or went, so the pet and the sidebar draw again; closed(): the window was closed.
  constructor({ state, actions, changed, closed = () => {}, log = () => {} }) {
    Object.assign(this, { stateOf: state, actions, changed, closed, log });
    this.win = null;
    this.practice = null;   // { mode, tried: Set, gone: Set, hidden, steps: Set }
  }

  get isOpen() {
    return Boolean(this.win && !this.win.isDestroyed());
  }

  open() {
    if (this.isOpen) {
      if (this.win.isMinimized()) this.win.restore();
      this.win.show();
      this.win.focus();
      return;
    }
    const win = new BrowserWindow({
      width: 680,
      height: 500,
      minWidth: 520,
      minHeight: 440,
      useContentSize: true,
      title: 'Getting started · Ttokttok Pet',
      icon: path.join(__dirname, '..', 'assets', 'icon.png'),
      autoHideMenuBar: true,
      maximizable: false,
      fullscreenable: false,
      show: false,
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#282623' : '#fffdfa',
      webPreferences: {
        preload: path.join(__dirname, 'onboarding-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
      },
    });
    win.removeMenu();
    this.win = win;
    const wc = win.webContents;
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    wc.on('will-navigate', (e) => e.preventDefault());
    wc.on('will-attach-webview', (e) => e.preventDefault());
    wc.ipc.on('onboarding:act', (event, name, arg) => {
      if (event.sender !== wc || !ACTIONS.has(name)) return;
      this.#act(name, arg);
    });
    wc.ipc.on('onboarding:ready', (event) => {
      if (event.sender === wc) this.send();
    });
    win.once('ready-to-show', () => {
      if (win.isDestroyed()) return;
      win.show();
      win.focus();
    });
    win.on('closed', () => {
      if (this.win === win) this.win = null;
      this.setPractice(null);
      this.closed();
    });
    win.loadURL('pet://app/ui/onboarding.html').catch((err) => this.log('getting started:', err.message));
  }

  // After the mode changes the sidebar docks and the apps are maximized beside it; this window
  // comes back on top.
  raise() {
    if (this.isOpen) this.win.focus();
  }

  send() {
    if (!this.isOpen) return;
    this.win.webContents.send('onboarding:state', { ...this.stateOf(), practice: this.#practiceState() });
  }

  // ---------------------------------------------------------------- practice

  // `mode` 'pet' or 'folder' starts it (again, from nothing tried), null ends it.
  setPractice(mode) {
    const was = this.practice;
    this.practice = mode ? { mode, since: Date.now(), tried: new Set(), gone: new Set(), hidden: false, steps: new Set() } : null;
    if (was || mode) this.changed();
    this.send();
  }

  // The practice bubble, for the floating pet's list; [] when there's none.
  petItems() {
    if (this.practice?.mode !== 'pet' || this.practice.gone.has(PRACTICE_PET)) return [];
    return [{ id: PRACTICE_PET, kind: 'practice', status: 'waiting', badge: 'Practice', title: 'Click me', project: '', since: this.practice.since }];
  }

  // The practice sessions, as a heading at the top of the sidebar's tree (folder-tree.js's form,
  // drawn as the web chats' are); null when there are none.
  folderHost() {
    if (this.practice?.mode !== 'folder') return null;
    const now = this.practice.since;
    const rows = [
      { id: PRACTICE_ROWS[0], app: 'claude', title: 'Answer me', status: 'waiting' },
      { id: PRACTICE_ROWS[1], app: 'claude', title: 'Read me', status: 'review' },
    ].filter((r) => !this.practice.gone.has(r.id))
      .map((r) => ({ ...r, siteName: 'Practice', detail: '', since: now, lastActivityAt: now }));
    if (!rows.length) return null;
    return { key: 'practice', kind: 'chat', label: 'Practice', folders: [], loose: rows, attention: rows.length, busy: 0, latest: now };
  }

  isPractice(id) {
    return typeof id === 'string' && id.startsWith('practice:');
  }

  // Something the practice asks for was done: 'click', 'dismiss', 'menu', 'rowMenu', or 'step'
  // with the direction (+1, -1; both make it count).
  tried(what, direction) {
    const p = this.practice;
    if (!p) return;
    if (what === 'step') {
      p.steps.add(direction > 0 ? 'next' : 'previous');
      if (p.steps.size < 2) return;
    }
    if (!TRIES[p.mode].includes(what) || p.tried.has(what)) return;
    p.tried.add(what);
    this.send();
  }

  // The pet, or the sidebar, was hidden and shown again.
  visibilityChanged(visible) {
    const p = this.practice;
    if (!p) return;
    if (!visible) p.hidden = true;
    else if (p.hidden) this.tried('hide');
  }

  // A practice item marked done, or hidden: it goes.
  remove(id) {
    if (!this.practice || !this.isPractice(id)) return;
    this.practice.gone.add(id);
    this.changed();
  }

  #practiceState() {
    const p = this.practice;
    return p ? { mode: p.mode, tried: [...p.tried] } : null;
  }

  // ---------------------------------------------------------------- the page's requests

  #act(name, arg) {
    const run = (promise) => Promise.resolve(promise).catch((err) => this.log(`getting started ${name}:`, err?.message || err)).finally(() => this.send());
    switch (name) {
      case 'mode':
        if (arg === 'pet' || arg === 'folder') run(this.actions.mode(arg));
        return;
      case 'usage':
        if (Array.isArray(arg) && arg.every((k) => typeof k === 'string')) run(this.actions.usage(arg));
        return;
      case 'etl':
        run(this.actions.etl());
        return;
      case 'todomate':
        run(this.actions.todomate());
        return;
      case 'slack':
        run(this.actions.slack());
        return;
      case 'web':
        run(this.actions.web(arg === true));
        return;
      case 'extensionFolder':
        run(this.actions.extensionFolder());
        return;
      case 'phone':
        run(this.actions.phone(arg === true));
        return;
      case 'phoneCheck':
        run(this.actions.phoneCheck());
        return;
      case 'phoneServe':
        run(this.actions.phoneServe());
        return;
      case 'phoneCode':
        run(this.actions.phoneCode());
        return;
      case 'phoneOpen':
        if (typeof arg === 'string' && TAILSCALE_LINK.test(arg)) run(this.actions.phoneOpen(arg));
        return;
      case 'copy':
        if (typeof arg === 'string' && arg.length <= MAX_COPY) clipboard.writeText(arg);
        return;
      case 'doc':
        if (typeof arg === 'string') run(this.actions.doc(arg));
        return;
      case 'practice':
        this.setPractice(arg === 'pet' || arg === 'folder' ? arg : null);
        return;
      case 'refresh':
        this.send();
        return;
      case 'close':
        this.win?.close();
        return;
      default:
    }
  }
}

module.exports = { GettingStarted, PRACTICE_PET, PRACTICE_ROWS, TAILSCALE_LINK, TRIES };
