'use strict';

// Checks the Slack canvas every half hour and keeps the presentation bubbles (schedule.js has the
// rules), the way EtlTracker keeps eTL's.
//
// Each check downloads the canvas, finds your turns, and compares them with the last check's: a
// turn that appeared or went gets a 순서 변경 bubble for 3 days. The reminders (D-7, D-3, D-1, 당일)
// are made afresh from the last check's turns whenever the bubbles are drawn, so a check that
// fails doesn't lose one; closing a reminder hides it until the next one takes over. A token Slack
// turns down, or a table that no longer has its 날짜 and 상태 columns, gets a bubble saying so, and
// the last turns found keep their reminders meanwhile. All of it lives in one state file
// (userData/slack-state.json), written atomically:
//   { version: 1, canvasId, name, title, turns: [turn] | null, items: [bubble item],
//     hidden: { id: until }, lastChecked: ms | null }
//
// Nothing happens before start(): no file is read or written, no timer set, no request sent.

const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { SlackAuthError } = require('./client');
const { ScheduleFormatError, changeItems, nextChangeAt, parseSchedule, reminderItems, turnsOf } = require('./schedule');
const { compareSessions } = require('../transcript');

const STATE_VERSION = 1;
const DEFAULT_INTERVAL_MS = 30 * 60 * 1000;
const MAX_ITEMS = 20;
const MAX_TIMEOUT_MS = 2 ** 31 - 1;             // setTimeout's limit
const TOKEN_ID = 'slack:token';
const FORMAT_ID = 'slack:format';

function statusItem(id, { status, badge, title, project, url, now }) {
  return { id, kind: 'slack', status, badge, title, project, detail: project, url, since: now, expiresAt: Infinity };
}

class SlackTracker extends EventEmitter {
  // createClient(): a client (client.js) or null without a token. config(): { canvasId, url, name }
  // as set now, or null when it isn't all set.
  constructor({
    createClient, config, stateFile, intervalMs = DEFAULT_INTERVAL_MS, now = Date.now,
    timers = { setInterval, clearInterval, setTimeout, clearTimeout },
  } = {}) {
    super();
    this.createClient = createClient;
    this.config = config;
    this.stateFile = stateFile;
    this.intervalMs = intervalMs;
    this.now = now;
    this.timers = timers;
    this.running = false;
    this.generation = 0;           // bumped by stop() and the *Changed() calls: older checks' results are dropped
    this.inflight = null;
    this.interval = null;
    this.wakeTimer = null;
    this.unauthorized = false;     // Slack turned the token down: no requests until a new one is registered
    this.state = this.emptyState();
    this.lastError = null;
    this.lastEmitted = null;
  }

  emptyState() {
    return { canvasId: null, name: null, title: '', turns: null, items: [], hidden: {}, lastChecked: null };
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.load();
    this.publish(true);
    this.interval = this.timers.setInterval(() => {
      this.checkNow().catch((err) => this.fail(err));
    }, this.intervalMs);
    this.checkNow().catch((err) => this.fail(err));
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    this.generation++;
    this.inflight = null;
    this.timers.clearInterval(this.interval);
    this.timers.clearTimeout(this.wakeTimer);
    this.interval = null;
    this.wakeTimer = null;
    this.lastEmitted = null;
    this.emit('change', []);
  }

  // Check now, or join the check already under way.
  checkNow() {
    if (!this.running) return Promise.resolve();
    if (!this.inflight) {
      const p = this.check(this.generation).finally(() => {
        if (this.inflight === p) this.inflight = null;
      });
      this.inflight = p;
    }
    return this.inflight;
  }

  // A new token, canvas or name: check again (a different canvas or name starts a new baseline,
  // in load() and check()).
  settingsChanged() {
    this.unauthorized = false;
    if (!this.running) return Promise.resolve();
    this.state.items = this.state.items.filter((it) => it.id !== TOKEN_ID);
    this.generation++;
    this.inflight = null;
    this.save();
    this.publish();
    return this.checkNow();
  }

  dismiss(id) {
    if (!this.running || !String(id).startsWith('slack:')) return;
    const now = this.now();
    if (String(id).startsWith('slack:remind:')) {   // until the next reminder takes over
      const shown = this.reminders(now).find((it) => it.id === id);
      if (!shown) return;
      this.state.hidden = { ...this.liveHidden(now), [id]: shown.expiresAt };
    } else {
      const before = this.state.items.length;
      this.state.items = this.state.items.filter((it) => it.id !== id);
      if (this.state.items.length === before) return;
    }
    this.save();
    this.publish(true);
  }

  dismissedSnapshot() {
    return {};
  }

  // The turns found by the last check that read the table: [turn] (schedule.js), soonest first.
  turns() {
    return this.state.turns || [];
  }

  status() {
    return { lastChecked: this.state.lastChecked, error: this.lastError };
  }

  reminders(now) {
    const cfg = this.config() || {};
    return reminderItems(this.state.turns, now, { hidden: this.state.hidden, url: cfg.url || null, title: this.state.title });
  }

  liveHidden(now) {
    return Object.fromEntries(Object.entries(this.state.hidden).filter(([, until]) => until > now));
  }

  // ---------------------------------------------------------------- checking

  async check(gen) {
    const stale = () => gen !== this.generation || !this.running;
    if (this.unauthorized) {
      this.publish();
      return;
    }
    const cfg = this.config();
    let client;
    try {
      client = cfg && this.createClient();
    } catch (err) {
      this.setStatus(err?.message || String(err));
      return;
    }
    if (!cfg || !client) {
      this.setStatus('Slack 토큰, 캔버스 링크와 이름을 모두 등록해 주세요.');
      this.publish();
      return;
    }

    let markdown;
    try {
      markdown = await client.canvasMarkdown(cfg.canvasId);
    } catch (err) {
      if (stale()) return;
      if (err instanceof SlackAuthError) {
        this.unauthorized = true;
        this.putStatusItem(statusItem(TOKEN_ID, {
          status: 'waiting', badge: '토큰 확인', title: 'Slack 토큰을 다시 등록해 주세요',
          project: err.message, url: null, now: this.now(),
        }));
      }
      this.setStatus(err?.message || String(err));
      this.save();
      this.publish();
      return;
    }
    if (stale()) return;

    const now = this.now();
    let schedule;
    try {
      schedule = parseSchedule(markdown);
    } catch (err) {
      if (!(err instanceof ScheduleFormatError)) throw err;
      this.putStatusItem(statusItem(FORMAT_ID, {
        status: 'failed', badge: '표 확인 필요', title: '발표 순서 표의 형식이 바뀌었습니다',
        project: '날짜·상태 열을 찾지 못해, 마지막으로 읽은 순서로 알려 드립니다', url: cfg.url, now,
      }));
      this.setStatus(err.message);
      this.save();
      this.publish();
      return;
    }

    const turns = turnsOf(schedule, cfg.name);
    const sameBaseline = this.state.turns && this.state.canvasId === cfg.canvasId && this.state.name === cfg.name;
    const alerts = sameBaseline ? changeItems(this.state.turns, turns, now, { url: cfg.url, title: schedule.title }) : [];
    const kept = this.state.items.filter((it) => it.id !== TOKEN_ID && it.id !== FORMAT_ID && !(it.expiresAt <= now));
    this.state = {
      ...this.state,
      canvasId: cfg.canvasId,
      name: cfg.name,
      title: schedule.title,
      turns,
      items: [...alerts, ...kept].slice(0, MAX_ITEMS),
      hidden: sameBaseline ? this.liveHidden(now) : {},
      lastChecked: now,
    };
    this.save();
    this.setStatus(null);
    this.publish();
  }

  putStatusItem(item) {
    this.state.items = [item, ...this.state.items.filter((it) => it.id !== item.id)];
  }

  setStatus(error) {
    this.lastError = error;
    this.emit('status', this.status());
  }

  // Send the visible bubbles if they changed, and wake up when the next one comes or goes.
  publish(force = false) {
    if (!this.running) return;
    const now = this.now();
    const live = this.state.items.filter((it) => !(it.expiresAt <= now));
    if (live.length !== this.state.items.length) {
      this.state.items = live;
      this.state.hidden = this.liveHidden(now);
      this.save();
    }
    const shown = [...live, ...this.reminders(now)].sort(compareSessions);
    const key = JSON.stringify(shown);
    if (force || key !== this.lastEmitted) {
      this.lastEmitted = key;
      this.emit('change', shown);
    }
    this.timers.clearTimeout(this.wakeTimer);
    this.wakeTimer = null;
    const next = Math.min(
      nextChangeAt(this.state.turns, now),
      ...shown.map((it) => it.expiresAt).filter(Number.isFinite),
      ...Object.values(this.state.hidden),
    );
    if (Number.isFinite(next)) {
      this.wakeTimer = this.timers.setTimeout(() => {
        this.wakeTimer = null;
        this.publish();
      }, Math.min(Math.max(next - now, 0) + 1000, MAX_TIMEOUT_MS));
    }
  }

  // ---------------------------------------------------------------- the state file

  load() {
    let j = null;
    try {
      j = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
    } catch {
      // none yet, or unreadable: the first check sets a new baseline
    }
    const s = this.emptyState();
    if (j && typeof j === 'object' && j.version === STATE_VERSION) {
      s.canvasId = typeof j.canvasId === 'string' ? j.canvasId : null;
      s.name = typeof j.name === 'string' ? j.name : null;
      s.title = typeof j.title === 'string' ? j.title : '';
      s.turns = Array.isArray(j.turns) ? j.turns.filter((t) => t && typeof t.key === 'string' && Number.isFinite(t.endAt)) : null;
      s.items = Array.isArray(j.items)
        ? j.items.filter((it) => it && typeof it.id === 'string' && it.id.startsWith('slack:') && it.kind === 'slack')
          .map((it) => ({ ...it, expiresAt: it.expiresAt ?? Infinity }))
        : [];
      s.hidden = j.hidden && typeof j.hidden === 'object'
        ? Object.fromEntries(Object.entries(j.hidden).filter(([id, until]) => id.startsWith('slack:remind:') && Number.isFinite(until)))
        : {};
      s.lastChecked = Number.isFinite(j.lastChecked) ? j.lastChecked : null;
    }
    this.state = s;
  }

  save() {
    if (!this.running) return;
    // Infinity isn't JSON: a bubble that stays until it's dealt with is saved without expiresAt.
    const items = this.state.items.map((it) => (Number.isFinite(it.expiresAt) ? it : { ...it, expiresAt: undefined }));
    const data = JSON.stringify({ version: STATE_VERSION, ...this.state, items });
    const tmp = `${this.stateFile}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
      fs.writeFileSync(tmp, data, 'utf8');
      fs.renameSync(tmp, this.stateFile);
    } catch (err) {
      this.fail(err);
    }
  }

  // A failed check or save is reported, not thrown: nobody listening mustn't crash the pet.
  fail(err) {
    if (this.listenerCount('error')) this.emit('error', err);
  }
}

module.exports = { SlackTracker };
