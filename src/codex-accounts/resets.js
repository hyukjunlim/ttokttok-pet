'use strict';

// Rate-limit resets that are lost unless used before they expire: a D-Day bubble every morning for
// each account that holds one. Codex's come from its app-server with each account's usage
// (manager.js resetCreditsOf). Claude's can't be read, so the user enters them in the Accounts
// window's Claude tab (kind, count, expiry) and they're kept in settings (`claudeResets`).
//
// From SHOW_FROM_HOUR (KST) each morning, one bubble per account, for its soonest-expiring reset,
// and how many more that account holds:
//   D-3  Codex 홍길동 · Weekly reset
//        11/16(월) 15:00 만료 · 외 1개
// When that one is used or expires, the bubble moves on to the next one; with none left it goes.
// Clicking it clears it until the next morning, as TodoMate's countdowns do. Its id carries the
// account and the day, so the phone gets one push per account each morning (phone/notify.js), and
// a reset used during the day changes the bubble without another push.
//
// Left out: a reset without a known expiry (it can't be counted down; it still counts in 외 N개),
// and a Codex account whose monitoring is paused (its reading no longer follows what's used).

const { randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { SHOW_FROM_HOUR, addDays, countdownDay, daysBetween, dLabel, kstParts, weekdayOf } = require('../todomate/schedule');

const KIND_LIMIT = 80;
const MAX_COUNT = 99;
const MAX_ENTRIES = 100;
const TICK_MS = 60_000;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

const pad = (n) => String(n).padStart(2, '0');
const clip = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const kstTime = (ms) => {
  const d = new Date(ms + KST_OFFSET_MS);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
};
const validDate = (date) => {
  const m = DATE_RE.exec(String(date ?? ''));
  if (!m || Number(m[1]) < 2000 || Number(m[1]) > 2100) return false;
  return new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date;
};
// '2026-11-16' -> '11/16(월)'
const shortDate = (date) => {
  const [, mm, dd] = date.split('-');
  return `${Number(mm)}/${Number(dd)}(${weekdayOf(date)})`;
};

// ---------------------------------------------------------------- Claude's, as entered

// When an entry runs out: at its time on its date (KST), or without a time, when that date ends.
function claudeExpiry({ date, time }) {
  return time ? Date.parse(`${date}T${time}:00+09:00`) : Date.parse(`${addDays(date, 1)}T00:00:00+09:00`);
}

// What the window sends, checked: { kind, count, date, time } (time null for the end of the day).
// Throws with a message the window shows.
function claudeEntry(data) {
  const kind = typeof data?.kind === 'string' ? data.kind.replace(/\s+/g, ' ').trim() : '';
  if (!kind) throw new Error('Enter the kind of reset.');
  if (kind.length > KIND_LIMIT) throw new Error(`Keep the kind under ${KIND_LIMIT} characters.`);
  const count = Number(data?.count);
  if (!Number.isInteger(count) || count < 1 || count > MAX_COUNT) throw new Error(`The count is a whole number from 1 to ${MAX_COUNT}.`);
  if (!validDate(data?.date)) throw new Error('Enter the expiry date.');
  const time = data?.time ? String(data.time) : null;
  if (time && !TIME_RE.test(time)) throw new Error('Enter the time as HH:MM, or leave it empty.');
  return { kind, count, date: data.date, time };
}

// The saved entries, less any that don't read right (a hand-edited settings file).
function claudeResetsOf(saved) {
  if (!Array.isArray(saved)) return [];
  const ids = new Set();
  const out = [];
  for (const e of saved) {
    if (typeof e?.id !== 'string' || !e.id || ids.has(e.id)) continue;
    try {
      out.push({ id: e.id, ...claudeEntry(e) });
      ids.add(e.id);
    } catch { /* left out */ }
  }
  return out;
}

// ---------------------------------------------------------------- each account's resets

// Every account that holds a reset still to be used: [{ key, app, name, resets, total }], `resets`
// the ones with a known expiry, soonest first ({ title, expiresAt, timed }), `total` all of them.
// `codex`: AccountManager's snapshot().accounts; `claude`: claudeResetsOf's entries.
function resetAccounts({ codex = [], claude = [] }, nowMs) {
  const out = [];
  for (const a of codex) {
    if (!a?.enabled || !a.bankedResets) continue;
    const { availableCount, credits } = a.bankedResets;
    const usable = (credits || []).filter((c) => c.status === 'available');
    const left = usable.filter((c) => c.expiresAt == null || c.expiresAt > nowMs);
    const lapsed = usable.length - left.length;   // expired since the last reading
    const total = Math.max(left.length, availableCount - lapsed);
    if (total <= 0) continue;
    const resets = left.filter((c) => Number.isFinite(c.expiresAt))
      .map((c) => ({ title: c.title || 'Rate-limit reset', expiresAt: c.expiresAt, timed: true }))
      .sort((x, y) => x.expiresAt - y.expiresAt);
    out.push({ key: `codex:${a.id}`, app: 'codex', name: `Codex ${a.label}`, resets, total });
  }
  const claudeResets = claude.flatMap((e) => {
    const expiresAt = claudeExpiry(e);
    return expiresAt > nowMs ? Array.from({ length: e.count }, () => ({ title: e.kind, expiresAt, timed: Boolean(e.time) })) : [];
  }).sort((x, y) => x.expiresAt - y.expiresAt);
  if (claudeResets.length) out.push({ key: 'claude', app: 'claude', name: 'Claude', resets: claudeResets, total: claudeResets.length });
  return out;
}

// The D-X for a reset that runs out at `expiresAt`, counted from the day showing at `nowMs`: a
// reset that runs out at the end of a day (or at its midnight) counts to that day.
function daysLeft(expiresAt, nowMs) {
  return Math.max(0, daysBetween(countdownDay(nowMs), kstParts(expiresAt - 1).date));
}

// This morning's bubbles, one per account with a dated reset, soonest first. `hidden`: id -> until
// when a cleared one stays out of sight.
function resetItems(accounts, nowMs, hidden = {}) {
  const day = countdownDay(nowMs);
  const nextMorning = Date.parse(`${addDays(day, 1)}T${pad(SHOW_FROM_HOUR)}:00:00+09:00`);
  return accounts
    .filter((a) => a.resets.length)
    .sort((x, y) => x.resets[0].expiresAt - y.resets[0].expiresAt)
    .flatMap((a) => {
      const id = `resets:dday:${a.key}:${day}`;
      if (hidden[id] > nowMs) return [];
      const r = a.resets[0];
      const n = daysLeft(r.expiresAt, nowMs);
      const others = a.total - 1;
      const title = `${a.name} · ${r.title}`;
      // How many more go on the second line: the bubble's fixed width cuts a long title short.
      const when = (r.timed ? `${shortDate(kstParts(r.expiresAt).date)} ${kstTime(r.expiresAt)} 만료` : `${shortDate(kstParts(r.expiresAt - 1).date)}까지`)
        + (others > 0 ? ` · 외 ${others}개` : '');
      return [{
        id,
        kind: 'resets',
        app: a.app,
        status: n <= 1 ? 'waiting' : n <= 3 ? 'review' : 'idle',
        badge: dLabel(n),
        title: clip(title, 200),
        project: when,
        detail: clip(`${dLabel(n)} ${title} · ${when}`, 300),
        clearOnClick: true,
        expiresAt: nextMorning,
      }];
    });
}

// ---------------------------------------------------------------- the bubbles, kept up to date

class ResetReminders extends EventEmitter {
  // settings: the pet's Settings; codex(): AccountManager's snapshot().accounts.
  constructor({ settings, codex = () => [], now = Date.now, timers = { setInterval, clearInterval } }) {
    super();
    Object.assign(this, { settings, codex, now, timers });
    this.interval = null;
    this.lastKey = null;
  }

  start() {
    if (this.interval) return;
    this.interval = this.timers.setInterval(() => this.update(), TICK_MS);
    this.interval?.unref?.();
    this.update(true);
  }

  stop() {
    this.timers.clearInterval(this.interval);
    this.interval = null;
    this.lastKey = null;
    this.emit('change', []);
  }

  claude() {
    return claudeResetsOf(this.settings.get('claudeResets'));
  }

  // For the Claude tab: each entry, soonest first, with when it runs out and its D-X.
  claudeSnapshot() {
    const now = this.now();
    return this.claude().map((e) => {
      const expiresAt = claudeExpiry(e);
      const expired = expiresAt <= now;
      return { ...e, expiresAt, expired, dday: expired ? null : dLabel(daysLeft(expiresAt, now)) };
    }).sort((a, b) => a.expiresAt - b.expiresAt);
  }

  addClaude(data) {
    const entry = this.#future(claudeEntry(data));
    const list = this.claude();
    if (list.length >= MAX_ENTRIES) throw new Error(`Keep it to ${MAX_ENTRIES} entries.`);
    this.#save([...list, { id: randomUUID(), ...entry }]);
  }

  editClaude(id, data) {
    const entry = this.#future(claudeEntry(data));
    const list = this.claude();
    if (!list.some((e) => e.id === id)) throw new Error('That reset is no longer listed.');
    this.#save(list.map((e) => (e.id === id ? { id, ...entry } : e)));
  }

  // One of the entry's resets was used: one fewer, and none left takes the entry away.
  useClaude(id) {
    const list = this.claude();
    if (!list.some((e) => e.id === id)) throw new Error('That reset is no longer listed.');
    this.#save(list.flatMap((e) => (e.id !== id ? [e] : e.count > 1 ? [{ ...e, count: e.count - 1 }] : [])));
  }

  removeClaude(id) {
    this.#save(this.claude().filter((e) => e.id !== id));
  }

  items() {
    if (!this.interval) return [];
    const now = this.now();
    return resetItems(resetAccounts({ codex: this.codex(), claude: this.claude() }, now), now, this.#hidden());
  }

  // Called every minute, when a Codex reading comes in and when an entry changes.
  update(force = false) {
    if (!this.interval) return;
    const list = this.items();
    const key = JSON.stringify(list);
    if (force || key !== this.lastKey) {
      this.lastKey = key;
      this.emit('change', list);
    }
  }

  // A click on a bubble, or its ×: out of sight until the next morning, across restarts.
  dismiss(id) {
    if (!String(id).startsWith('resets:')) return;
    const shown = this.items().find((it) => it.id === id);
    if (!shown) return;
    this.settings.set({ resetsHidden: { ...this.#hidden(), [id]: shown.expiresAt } });
    this.update(true);
  }

  dismissedSnapshot() {
    return {};
  }

  #future(entry) {
    if (claudeExpiry(entry) <= this.now()) throw new Error('That expiry has already passed.');
    return entry;
  }

  #save(list) {
    this.settings.set({ claudeResets: list.map(({ id, kind, count, date, time }) => ({ id, kind, count, date, time })) });
    this.update(true);
  }

  // Ids hidden with a click or ×, and until when; the ones that have run out are dropped.
  #hidden() {
    const now = this.now();
    const saved = this.settings.get('resetsHidden');
    return Object.fromEntries(Object.entries(saved && typeof saved === 'object' ? saved : {}).filter(([, until]) => until > now));
  }
}

module.exports = { ResetReminders, claudeEntry, claudeExpiry, claudeResetsOf, resetAccounts, resetItems };
