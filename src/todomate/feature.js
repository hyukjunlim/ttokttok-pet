'use strict';

// TodoMate's schedule in the pet (CONSTRAINTS.md, TodoMate schedule): everything main.js needs, in
// one place. Off by default; while it's off nothing here makes a request, a file or a timer.
//
// When on, it reads today's todos and the last LOOKBACK_DAYS' through PlayMCP (mcp.js) at start,
// every REFRESH_MS, on wake from sleep and when the day changes, and redoes the bubbles every minute
// (schedule.js): today's timed Schedule items, and a countdown for each D-Day item. The tokens live
// only in userData, encrypted with safeStorage (etl/token.js's store); the categories are settings.
// Connecting takes a connection prompt from the user's PlayMCP toolbox (mcp.js). When the connection
// stops working, one bubble says so, and clicking it connects again.

const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createTokenStore } = require('../etl/token');
const { createClient, exchangeOneTimeToken, oneTimeTokenOf, TodomateAuthError, TOOLBOX_URL } = require('./mcp');
const { countdownItems, countdownsOf, kstParts, scheduleItems, scheduleOf, todosOf, goalsOf } = require('./schedule');

const DEFAULT_CATEGORY = 'Schedule';
const DEFAULT_DDAY_CATEGORY = 'D-Day';
const LOOKBACK_DAYS = 30;          // D-Day items are looked for on today and the days before it
const DAY_MS = 24 * 60 * 60 * 1000;
const RANGE_CAP = 100;            // loadTodoItemsByDateRange answers with at most this many, oldest first

const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const ymd = (date) => {
  const [year, month, day] = date.split('-').map(Number);
  return { year, month, day };
};
const REFRESH_MS = 15 * 60 * 1000;
const RETRY_MS = 5 * 60 * 1000;
const TICK_MS = 60 * 1000;
const MAX_TOKENS_LENGTH = 16 * 1024;
const AUTH_ID = 'todomate:auth';

// The tokens as the store keeps them: compact JSON, printable ASCII without spaces.
function normalizeTokens(text) {
  const value = typeof text === 'string' ? text : '';
  if (!value || value.length > MAX_TOKENS_LENGTH || !/^[\x21-\x7e]+$/.test(value)) throw new Error('PlayMCP 토큰 형식이 올바르지 않습니다.');
  return value;
}

class TodomateFeature extends EventEmitter {
  // electron: { app, clipboard, dialog, powerMonitor, safeStorage, shell }; settings: the pet's
  // Settings. `askForPrompt()`: the pasted connection prompt, or null (tests bring their own).
  constructor({ electron, settings, log = () => {}, fetch = globalThis.fetch, askForPrompt = null, now = Date.now, timers = { setInterval, clearInterval } }) {
    super();
    this.electron = electron;
    this.settings = settings;
    this.log = log;
    this.fetch = fetch;
    this.askForPrompt = askForPrompt ?? (() => this.#askFromClipboard());
    this.now = now;
    this.timers = timers;
    this.store = createTokenStore({
      safeStorage: electron.safeStorage,
      file: path.join(electron.app.getPath('userData'), 'todomate-token.bin'),
      normalize: normalizeTokens,
    });
    this.client = null;
    this.raw = null;            // { date, todos, recent, goals } from the last good check
    this.day = null;            // { date, items } for today: raw's, in the category set now
    this.countdowns = [];       // raw's D-Day items (schedule.js countdownsOf)
    this.goals = [];            // category titles from the last check, for the menu
    this.lastChecked = 0;
    this.error = null;
    this.authFailed = false;
    this.loadedAt = 0;
    this.inflight = null;
    this.signingIn = null;
    this.interval = null;
    this.lastKey = null;
    this.running = false;
    this.onResume = () => this.checkNow();
  }

  get enabled() {
    return this.settings.get('todomateEnabled') === true;
  }

  category() {
    return String(this.settings.get('todomateCategory') || '').trim() || DEFAULT_CATEGORY;
  }

  ddayCategory() {
    return String(this.settings.get('todomateDdayCategory') || '').trim() || DEFAULT_DDAY_CATEGORY;
  }

  // At launch: picks up where the last run left off.
  start() {
    if (this.enabled) this.#run();
  }

  stop() {
    if (this.running) {
      this.running = false;
      this.timers.clearInterval(this.interval);
      this.interval = null;
      this.electron.powerMonitor.off('resume', this.onResume);
    }
    this.client?.close();
    this.client = null;
    this.raw = null;
    this.day = null;
    this.countdowns = [];
    this.lastKey = null;
    this.emit('change', []);
  }

  async setEnabled(on) {
    if (!on) {
      this.settings.set({ todomateEnabled: false });
      this.stop();
      return;
    }
    if (!this.#tokens() && !(await this.connect())) return;   // not connected, stays off
    this.settings.set({ todomateEnabled: true });
    this.#run();
  }

  // Connects to PlayMCP with a connection prompt the user copies from the toolbox; true once tokens
  // are saved, false when the user cancels or the prompt doesn't work.
  async connect() {
    if (this.signingIn) return this.signingIn;
    this.signingIn = (async () => {
      try {
        const text = await this.askForPrompt();
        if (text == null) return false;   // cancelled
        const ott = oneTimeTokenOf(text);
        if (!ott) throw new Error('클립보드에 PlayMCP 연결 프롬프트가 없습니다. 도구함에서 연결 프롬프트를 만들어 복사한 뒤 다시 해 주세요.');
        const tokens = await exchangeOneTimeToken(ott, { fetch: this.fetch });
        this.store.save(JSON.stringify(tokens));
        this.authFailed = false;
        this.error = null;
        this.client?.close();
        this.client = null;
        if (this.running) this.checkNow();
        return true;
      } catch (err) {
        this.log('todomate connect:', err?.message || err);
        this.error = err?.message || String(err);
        await this.electron.dialog?.showMessageBox({ type: 'warning', title: '투두메이트 연결', message: '연결하지 못했습니다.', detail: this.error });
        return false;
      } finally {
        this.signingIn = null;
      }
    })();
    return this.signingIn;
  }

  // Opens the toolbox in the browser and waits for the user to copy a connection prompt there;
  // the clipboard's text then, or null when they cancel. Only connect() reads the clipboard.
  async #askFromClipboard() {
    const { dialog, clipboard, shell } = this.electron;
    shell.openExternal(TOOLBOX_URL).catch((err) => this.log('todomate: could not open the toolbox:', err.message));
    const { response } = await dialog.showMessageBox({
      type: 'info',
      title: '투두메이트 연결',
      message: 'PlayMCP 도구함에서 연결 프롬프트를 복사해 주세요.',
      detail: '브라우저에 열린 도구함(투두메이트가 담긴 상태)에서 "OpenClaw와 연결" → 동의 → "연결 프롬프트 생성"을 누르고, '
        + '만들어진 프롬프트를 복사한 뒤 "클립보드로 연결"을 누르세요. 프롬프트는 10분 동안만 쓸 수 있고, '
        + '펫은 그 안의 일회용 토큰만 읽습니다.',
      buttons: ['클립보드로 연결', '취소'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    return response === 0 ? clipboard.readText() : null;
  }

  signOut() {
    this.store.clear();
    this.settings.set({ todomateEnabled: false });
    this.stop();
  }

  checkNow() {
    if (!this.running) return Promise.resolve();
    if (!this.inflight) this.inflight = this.#load().finally(() => { this.inflight = null; });
    return this.inflight;
  }

  // The connection bubble asks for a new connection prompt rather than opening a page.
  open(id) {
    if (id !== AUTH_ID) return false;
    this.connect();
    return true;
  }

  // × on a bubble, or a click on a countdown: hidden until it would have gone anyway (an item's
  // end, the next morning). Kept in settings, so a restart doesn't bring it back.
  dismiss(id) {
    if (!String(id).startsWith('todomate:') || id === AUTH_ID) return;
    const shown = this.#items().find((it) => it.id === id);
    if (!shown) return;
    this.settings.set({ todomateHidden: { ...this.#hidden(), [id]: shown.expiresAt } });
    this.#tick(true);
  }

  dismissedSnapshot() {
    return {};
  }

  // The tray menu's Sources → "투두메이트 일정" submenu.
  menu() {
    const on = this.enabled;
    const category = this.category();
    const titles = [...new Set([category, ...this.goals])];
    const dday = this.ddayCategory();
    const ddayTitles = [...new Set([dday, ...this.goals])];
    const items = [
      { label: '켜기', type: 'checkbox', checked: on, click: (mi) => this.#later(this.setEnabled(mi.checked)) },
      { label: 'PlayMCP 다시 연결…', click: () => this.#later(this.connect()) },
      {
        label: `카테고리: ${category}`,
        submenu: titles.map((t) => ({
          label: t,
          type: 'radio',
          checked: t === category,
          click: () => {
            this.settings.set({ todomateCategory: t });
            this.#recompose();
          },
        })),
      },
      {
        label: `D-Day 카테고리: ${dday}`,
        submenu: ddayTitles.map((t) => ({
          label: t,
          type: 'radio',
          checked: t === dday,
          click: () => {
            this.settings.set({ todomateDdayCategory: t });
            this.#recompose();
          },
        })),
      },
      { label: '지금 확인', enabled: Boolean(on && this.running), click: () => this.checkNow() },
    ];
    if (on) {
      items.push({ type: 'separator' });
      if (this.day) items.push({ label: `오늘 일정 ${this.day.items.length}개 · D-Day ${this.countdowns.length}개`, enabled: false });
      items.push({ label: this.#statusLine(), enabled: false });
    }
    if (this.store.has()) items.push({ type: 'separator' }, { label: '연결 해제', click: () => this.signOut() });
    return { label: '투두메이트 일정', submenu: items };
  }

  #tokens() {
    const text = this.store.load();
    if (!text) return null;
    try {
      const t = JSON.parse(text);
      return typeof t?.accessToken === 'string' ? t : null;
    } catch {
      return null;
    }
  }

  #run() {
    if (this.running) return;
    this.running = true;
    this.interval = this.timers.setInterval(() => this.#tick(), TICK_MS);
    this.electron.powerMonitor.on('resume', this.onResume);
    this.checkNow();
  }

  async #load() {
    this.loadedAt = this.now();
    const date = kstParts(this.now()).date;
    const [year, month, day] = date.split('-').map(Number);
    this.client ??= createClient({
      getTokens: () => this.#tokens(),
      saveTokens: (t) => this.store.save(JSON.stringify(t)),
      fetch: this.fetch,
      now: this.now,
      clientVersion: this.electron.app.getVersion?.() ?? '0.0.0',
    });
    try {
      const todos = todosOf(await this.client.loadTodoItems({ year, month, day }));
      // A D-Day item stays on the day it was written, so the days before today are read too.
      const recent = await this.#between(addDays(date, -(LOOKBACK_DAYS - 1)), addDays(date, -1));
      // Todos that name only their category's id need loadGoals; it also fills the menu's list.
      const goals = goalsOf(await this.client.loadGoals());
      this.goals = [...new Set(goals.values())];
      this.raw = { date, todos, recent, goals };
      this.authFailed = false;
      this.error = null;
      this.lastChecked = this.now();
      this.#recompose();
      // Counts only, never the todos themselves: enough to tell an answer the pet can't read.
      this.log(`todomate: ${todos.length} todos today, ${recent.length} in ${LOOKBACK_DAYS} days, ${goals.size} categories, `
        + `${this.day.items.length} timed in ${this.category()}, ${this.countdowns.length} dated in ${this.ddayCategory()}`);
    } catch (err) {
      this.error = err?.message || String(err);
      if (err instanceof TodomateAuthError) this.authFailed = true;
      this.client?.close();
      this.client = null;
      this.log('todomate:', this.error);
      this.#tick(true);
    }
  }

  // The todos from `from` to `to` (YYYY-MM-DD, both included). The range tool stops at RANGE_CAP,
  // so a full answer is asked for again in two halves, down to single days.
  async #between(from, to) {
    if (from > to) return [];
    if (from === to) return todosOf(await this.client.loadTodoItems(ymd(from)));
    const todos = todosOf(await this.client.loadTodoItemsByDateRange(ymd(from), ymd(to)));
    if (todos.length < RANGE_CAP) return todos;
    const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
    const mid = addDays(from, Math.floor(days / 2));
    return [...(await this.#between(from, mid)), ...(await this.#between(addDays(mid, 1), to))];
  }

  // Today's items and the countdowns from the last check, with the categories as set now.
  #recompose() {
    if (this.raw) {
      this.day = { date: this.raw.date, items: scheduleOf(this.raw.todos, this.raw.goals, this.category()) };
      this.countdowns = countdownsOf([...this.raw.todos, ...this.raw.recent], this.raw.goals, this.ddayCategory(), this.raw.date);
    }
    this.#tick(true);
  }

  // Ids hidden with × or a click, and until when; the ones that would have gone anyway are dropped.
  #hidden() {
    const now = this.now();
    const saved = this.settings.get('todomateHidden');
    return Object.fromEntries(Object.entries(saved && typeof saved === 'object' ? saved : {}).filter(([, until]) => until > now));
  }

  #items() {
    if (!this.running) return [];
    const auth = this.authFailed
      ? [{
        id: AUTH_ID,
        kind: 'todomate',
        status: 'failed',
        badge: '연결 필요',
        title: '투두메이트: PlayMCP에 다시 연결',
        project: '클릭하면 연결 프롬프트를 받습니다',
        detail: this.error || '',
        keepOnOpen: true,
      }]
      : [];
    if (!this.day) return auth;
    const hidden = this.#hidden();
    return [...auth, ...countdownItems(this.countdowns, this.now(), hidden), ...scheduleItems(this.day, this.now(), Object.keys(hidden))];
  }

  #tick(force = false) {
    if (!this.running) return;
    const nowMs = this.now();
    if (this.day && this.day.date !== kstParts(nowMs).date) {   // a new day
      this.day = null;
      this.raw = null;
      this.loadedAt = 0;
    }
    if (!this.inflight && !this.authFailed && nowMs - this.loadedAt >= (this.day ? REFRESH_MS : RETRY_MS)) this.checkNow();
    const list = this.#items();
    const key = JSON.stringify(list);
    if (force || key !== this.lastKey) {
      this.lastKey = key;
      this.emit('change', list);
    }
  }

  #statusLine() {
    if (!this.store.has()) return '연결 안 됨';
    if (this.error) return `오류: ${String(this.error).slice(0, 40)}`;
    if (!this.lastChecked) return '확인 중…';
    const t = new Date(this.lastChecked);
    return `마지막 확인 ${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
  }

  #later(promise) {
    promise.catch((err) => this.log('todomate:', err?.message || err));
  }
}

module.exports = { AUTH_ID, DEFAULT_CATEGORY, DEFAULT_DDAY_CATEGORY, TodomateFeature };
