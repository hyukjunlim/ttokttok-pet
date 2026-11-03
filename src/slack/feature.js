'use strict';

// Slack presentation reminders in the pet (CONSTRAINTS.md, Slack presentation schedule): everything
// main.js needs, in one place. Off by default; while it's off nothing here makes a request, a file
// or a timer.
//
// When on, it runs the SlackTracker (tracker.js), which reads the registered canvas every 30
// minutes and on wake from sleep, and hands its reminders to the pet as bubbles (kind 'slack').
// The token lives only in userData, encrypted with safeStorage (etl/token.js's store); the canvas
// link and the name are settings.

const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createTokenStore } = require('../etl/token');
const { createClient, parseCanvasLink, SlackAuthError, TOKEN_RE } = require('./client');
const { parseSchedule, turnsOf, dayLabel } = require('./schedule');
const { openSetupWindow } = require('./setup-window');
const { SlackTracker } = require('./tracker');

const MAX_TOKEN_LENGTH = 512;

// The token as pasted, trimmed, or an Error with a Korean message saying what's wrong with it.
// The message never repeats the token.
function normalizeSlackToken(token) {
  const value = typeof token === 'string' ? token.trim() : '';
  if (!value) throw new Error('토큰을 입력해 주세요.');
  if (value.length > MAX_TOKEN_LENGTH || !TOKEN_RE.test(value)) {
    throw new Error('토큰 형식이 올바르지 않습니다. Slack 앱의 User OAuth Token(xoxp-…)을 그대로 붙여 넣어 주세요.');
  }
  if (!value.startsWith('xoxp-')) throw new Error('User OAuth Token(xoxp-…)을 붙여 넣어 주세요. Bot 토큰은 이 캔버스를 읽지 못할 수 있습니다.');
  return value;
}

class SlackFeature extends EventEmitter {
  // electron: { app, powerMonitor, safeStorage }; settings: the pet's Settings.
  constructor({ electron, settings, log = () => {}, openWindow = openSetupWindow, fetch = globalThis.fetch }) {
    super();
    this.electron = electron;
    this.settings = settings;
    this.log = log;
    this.openWindow = openWindow;
    this.fetch = fetch;
    const userData = electron.app.getPath('userData');
    this.token = createTokenStore({
      safeStorage: electron.safeStorage, file: path.join(userData, 'slack-token.bin'), normalize: normalizeSlackToken,
    });
    this.stateFile = path.join(userData, 'slack-state.json');
    this.tracker = null;
    this.onResume = () => this.checkNow();
  }

  get enabled() {
    return this.settings.get('slackEnabled') === true;
  }

  // { canvasId, url, name } as set now, or null when something is missing.
  config() {
    const canvas = parseCanvasLink(this.settings.get('slackCanvasUrl'));
    const name = String(this.settings.get('slackName') || '').trim();
    return canvas && name ? { ...canvas, name } : null;
  }

  // At launch: picks up where the last run left off.
  start() {
    if (this.enabled) this.#run();
  }

  stop() {
    this.electron.powerMonitor.off('resume', this.onResume);
    this.tracker?.stop();
    this.tracker = null;
    this.emit('change', []);
  }

  async setEnabled(on) {
    if (!on) {
      this.settings.set({ slackEnabled: false });
      this.stop();
      return;
    }
    if ((!this.token.has() || !this.config()) && !(await this.setUp())) return;   // not set up, stays off
    this.settings.set({ slackEnabled: true });
    this.#run();
  }

  // Opens the setup window; true once the canvas has been read with what was typed and it's saved.
  async setUp() {
    const { saved } = await this.openWindow({
      verify: (fields) => this.verify(fields),
      initial: { link: this.settings.get('slackCanvasUrl') || '', name: this.settings.get('slackName') || '', hasToken: this.token.has() },
    });
    if (saved) this.tracker?.settingsChanged();
    return saved;
  }

  // Reads the canvas with the typed (or saved) token, link and name; saves them once that works.
  // Returns { turns: ['11/10(화) 짧은 발표 2 10:00-11:00', ...] }, the turns still to come.
  async verify({ token, link, name } = {}) {
    const newToken = token ? normalizeSlackToken(token) : null;
    const useToken = newToken || this.token.load();
    if (!useToken) throw new Error('토큰을 입력해 주세요.');
    const canvas = parseCanvasLink(link);
    if (!canvas) throw new Error('캔버스 링크가 올바르지 않습니다. Slack에서 캔버스의 링크 복사로 얻은 주소(https://….slack.com/docs/T…/F…)를 붙여 넣어 주세요.');
    const who = String(name || '').replace(/\s+/g, ' ').trim();
    if (!who) throw new Error('이름을 입력해 주세요.');

    let markdown;
    try {
      markdown = await createClient({ token: useToken, fetch: this.fetch }).canvasMarkdown(canvas.canvasId);
    } catch (err) {
      if (err instanceof SlackAuthError && !newToken) throw new Error(`저장된 토큰이 더 이상 통하지 않습니다. 새 토큰을 붙여 넣어 주세요. (${err.code})`);
      throw err;
    }
    const now = Date.now();
    const turns = turnsOf(parseSchedule(markdown), who).filter((t) => t.endAt > now);

    if (newToken) this.token.save(newToken);
    this.settings.set({ slackCanvasUrl: canvas.url, slackName: who });
    return { turns: turns.map((t) => [dayLabel(t), t.column, t.time].filter(Boolean).join(' ')) };
  }

  checkNow() {
    return this.tracker?.checkNow().catch((err) => this.log('slack check:', err.message));
  }

  dismiss(id) {
    this.tracker?.dismiss(id);
  }

  dismissedSnapshot() {
    return {};
  }

  // The tray menu's Sources → "Slack 발표" submenu.
  menu() {
    const on = this.enabled;
    const items = [
      { label: '켜기', type: 'checkbox', checked: on, click: (mi) => this.#later(this.setEnabled(mi.checked)) },
      { label: '토큰·캔버스·이름 설정…', click: () => this.#later(this.setUp()) },
      { label: '지금 확인', enabled: Boolean(on && this.tracker), click: () => this.checkNow() },
    ];
    if (on) {
      const next = this.tracker?.turns().filter((t) => t.endAt > Date.now())[0];
      items.push({ type: 'separator' });
      if (next) items.push({ label: `다음 발표: ${dayLabel(next)} ${next.column}`, enabled: false });
      items.push({ label: this.#statusLine(), enabled: false });
    }
    return { label: 'Slack 발표', submenu: items };
  }

  #run() {
    if (this.tracker) return;
    this.tracker = new SlackTracker({
      createClient: () => {
        const token = this.token.load();
        return token ? createClient({ token, fetch: this.fetch }) : null;
      },
      config: () => this.config(),
      stateFile: this.stateFile,
    });
    this.tracker.on('change', (list) => this.emit('change', list));
    this.tracker.on('error', (err) => this.log('slack tracker:', err?.message || err));
    this.tracker.start();
    this.electron.powerMonitor.on('resume', this.onResume);
  }

  #statusLine() {
    if (!this.token.has()) return '토큰 없음';
    const { lastChecked, error } = this.tracker?.status() || {};
    if (error) return `오류: ${String(error).slice(0, 40)}`;
    if (!lastChecked) return '확인 중…';
    const t = new Date(lastChecked);
    return `마지막 확인 ${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
  }

  #later(promise) {
    promise.catch((err) => this.log('slack:', err?.message || err));
  }
}

module.exports = { SlackFeature, normalizeSlackToken };
