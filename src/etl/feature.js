'use strict';

// SNU eTL in the pet: everything main.js needs, in one place. Off by default; while it's off
// nothing here makes a request, a file or a timer.
//
// When on, it runs:
//   - the EtlTracker (tracker.js), which checks eTL every 30 minutes and on wake from sleep,
//     and hands its notices to the pet as bubbles (kind 'etl');
//   - the query bridge (bridge.js), so the AI in the chat folder can ask the pet for eTL data
//     without ever seeing the token;
//   - the chat folder (workspace.js), created or brought up to date from etl-workspace/;
//   - the TimetableNotifier (timetable.js), with a bubble for each of the day's classes.
//
// Course files are downloaded only when the AI asks with the `download` command (files.js), never
// by the tracker or on turning eTL on.
//
// The token lives only in userData, encrypted with safeStorage (token.js).

const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createClient, EtlAuthError } = require('./client');
const { createTokenStore } = require('./token');
const { openTokenWindow } = require('./token-window');
const { EtlTracker } = require('./tracker');
const { createBridge, createFileBridge, COMMANDS } = require('./bridge');
const { createQueries } = require('./queries');
const { createFiles } = require('./files');
const { defaultWorkspaceDir, ensureWorkspace, moveWorkspace, isInside } = require('./workspace');
const { ASSISTANT_ID, assistantItem, assistantLinks } = require('./assistant');
const { TimetableNotifier, createTimetable, kstParts } = require('./timetable');
const { formatKst } = require('./model');
const { EtlHistory } = require('./history');

const NO_TOKEN = 'eTL 토큰이 등록되지 않았습니다. 펫 트레이 메뉴의 Sources → eTL에서 토큰을 등록해 주세요.';
const CODEX_PROMPT = '오늘 브리핑해 줘';
const FILE_COMMANDS = new Set(['files', 'download']);   // answered by files.js, timetable by
                                                        // timetable.js, the rest by queries.js
const ASSISTANT_LINK_GAP_MS = 1200;   // between the eTL 비서 bubble's links (see openAssistant)

class EtlFeature extends EventEmitter {
  // electron: { app, dialog, powerMonitor, safeStorage, shell }; settings: the pet's Settings;
  // codexSessionsRoot: where Codex keeps its rollouts (for the eTL 비서 bubble's link).
  constructor({
    electron, settings, appRoot, log = () => {}, codexInstalled = () => false,
    codexSessionsRoot = path.join(os.homedir(), '.codex', 'sessions'),
  }) {
    super();
    this.electron = electron;
    this.settings = settings;
    this.appRoot = appRoot;
    this.log = log;
    this.codexInstalled = codexInstalled;
    this.codexSessionsRoot = codexSessionsRoot;
    this.trackerItems = [];           // the tracker's bubbles; the eTL 비서 bubble goes with them
    this.timetableItems = [];         // a bubble for each of today's classes (timetable.js)
    this.assistantSince = Date.now();
    const userData = electron.app.getPath('userData');
    this.token = createTokenStore({ safeStorage: electron.safeStorage, file: path.join(userData, 'etl-token.bin') });
    this.stateFile = path.join(userData, 'etl-state.json');
    this.downloadsFile = path.join(userData, 'etl-downloads.json');   // files.js's own records
    this.history = new EtlHistory({ dir: userData, log });             // etl-history.log (history.js)
    this.timetable = createTimetable({
      cacheFile: path.join(userData, 'etl-timetable.json'),
      workspaceDir: () => this.workspaceDir(),
    });
    this.notifier = null;
    this.tracker = null;
    this.bridge = null;
    this.fileBridge = null;           // the same, through files in the chat folder (Codex's sandbox)
    this.onResume = () => this.checkNow();
  }

  get enabled() {
    return this.settings.get('etlEnabled') === true;
  }

  // At launch: picks up where the last run left off.
  start() {
    if (this.enabled) this.#run();
  }

  stop() {
    this.electron.powerMonitor.off('resume', this.onResume);
    this.tracker?.stop();
    this.tracker = null;
    this.#stopNotifier();
    const bridge = this.bridge;
    this.bridge = null;
    bridge?.stop().catch((err) => this.log('etl bridge stop:', err.message));
    this.fileBridge?.stop();
    this.fileBridge = null;
    this.trackerItems = [];
    this.timetableItems = [];
    this.emit('change', []);
  }

  // `openChat`: straight into the eTL chat in Codex, when it's there (not from Getting started,
  // which has more steps to go).
  async setEnabled(on, { openChat = true } = {}) {
    if (!on) {
      this.settings.set({ etlEnabled: false });
      this.stop();
      return;
    }
    if (!this.token.has() && !(await this.registerToken())) return;   // no token, stays off
    this.settings.set({ etlEnabled: true });
    this.#run();
    if (openChat && this.codexInstalled()) await this.openInCodex();
  }

  // Opens the token window; true once a token that eTL accepted is saved. The first time, it
  // also asks whether to keep the eTL 비서 bubble.
  async registerToken() {
    const { saved } = await openTokenWindow({ verify: (token) => this.#verify(token) });
    if (saved) this.tracker?.tokenChanged();
    if (saved && !this.settings.get('etlAssistantAsked')) await this.#offerAssistant();
    return saved;
  }

  setTimetableBubble(on) {
    this.settings.set({ etlTimetableBubble: on });
    if (!this.enabled) return;
    if (on) this.#startNotifier();
    else this.#stopNotifier();
    this.#emitItems();
  }

  setAssistantBubble(on) {
    this.settings.set({ etlAssistantBubble: on });
    if (this.enabled) this.#emitItems();
  }

  // The links the eTL 비서 bubble opens, in order (see assistant.js); [] without a chat folder.
  assistantLinks() {
    const dir = this.#ensureWorkspace();
    if (!dir) return [];
    return assistantLinks(dir, { codexInstalled: this.codexInstalled(), sessionsRoot: this.codexSessionsRoot });
  }

  // Opens them with `open` (main.js's openApp), giving Codex a moment between them to take the
  // first: selecting the project switches its view, and a thread opened meanwhile is lost.
  openAssistant(open, { gapMs = ASSISTANT_LINK_GAP_MS } = {}) {
    const links = this.assistantLinks();
    links.forEach((url, i) => {
      if (i === 0) open(url);
      else setTimeout(() => open(url), gapMs * i);
    });
    return links.length > 0;
  }

  checkNow() {
    this.notifier?.refresh();
    return this.tracker?.checkNow().catch((err) => this.log('etl check:', err.message));
  }

  dismiss(id) {
    if (id === ASSISTANT_ID) return this.setAssistantBubble(false);   // its ×, like the menu item
    if (String(id).startsWith('etl:timetable:')) {
      this.log('etl timetable: closed', id);
      this.notifier?.dismiss(id);                                            // until tomorrow
    }
    else this.tracker?.dismiss(id);
  }

  // The tracker keeps its own dismissals (until each notice expires), not in settings.dismissed.
  dismissedSnapshot() {
    return {};
  }

  workspaceDir() {
    return this.settings.get('etlWorkspace') || defaultWorkspaceDir();
  }

  openWorkspace() {
    const dir = this.#ensureWorkspace();
    if (dir) this.electron.shell.openPath(dir);
  }

  async changeWorkspace() {
    const { dialog } = this.electron;
    const from = this.workspaceDir();
    const r = await dialog.showOpenDialog({
      title: 'eTL 채팅 폴더 위치',
      defaultPath: from,
      properties: ['openDirectory', 'createDirectory'],
    });
    const to = r.canceled ? null : r.filePaths[0];
    if (!to || path.resolve(to) === path.resolve(from)) return;
    if (isInside(to, this.appRoot)) {
      const { response } = await dialog.showMessageBox({
        type: 'warning',
        title: 'Ttokttok Pet',
        message: '펫 폴더 안을 채팅 폴더로 고르셨습니다.',
        detail: '채팅 AI가 펫의 코드와 설정까지 보게 되고, 펫을 다시 설치하면 할 일 목록(todos.md)도 함께 지워질 수 있습니다. 그래도 이 위치를 쓸까요?',
        buttons: ['이 위치 사용', '취소'],
        defaultId: 1,
        cancelId: 1,
      });
      if (response !== 0) return;
    }
    try {
      moveWorkspace(from, to);
      this.settings.set({ etlWorkspace: to });
      if (this.enabled) this.#startFileBridge();
      this.electron.shell.openPath(to);
    } catch (err) {
      this.log('etl workspace move:', err.message);
      dialog.showErrorBox('Ttokttok Pet', `채팅 폴더를 만들지 못했습니다.\n${err.message}`);
    }
  }

  // Codex opens codex://threads/new?path=… as a new chat in that folder, adding it as a project
  // first. It's undocumented, so when it fails the folder is opened instead.
  async openInCodex() {
    const dir = this.#ensureWorkspace();
    if (!dir) return;
    const url = `codex://threads/new?path=${encodeURIComponent(dir)}&prompt=${encodeURIComponent(CODEX_PROMPT)}`;
    try {
      await this.electron.shell.openExternal(url);
    } catch (err) {
      this.log('etl codex link:', err.message);
      this.electron.shell.openPath(dir);
    }
  }

  // The tray menu's Sources → "eTL" submenu.
  menu() {
    const on = this.enabled;
    const items = [
      { label: '켜기', type: 'checkbox', checked: on, click: (mi) => this.#later(this.setEnabled(mi.checked)) },
      { label: '토큰 등록/변경…', click: () => this.#later(this.registerToken()) },
      { label: '지금 확인', enabled: Boolean(on && this.tracker), click: () => this.checkNow() },
      { type: 'separator' },
      { label: '채팅 폴더 열기', enabled: on, click: () => this.openWorkspace() },
      { label: '채팅 폴더 위치 변경…', enabled: on, click: () => this.#later(this.changeWorkspace()) },
    ];
    if (this.codexInstalled()) {
      items.push({ label: 'Codex에서 eTL 비서 열기', enabled: on, click: () => this.#later(this.openInCodex()) });
    }
    items.push({
      label: '오늘 수업 알림',
      type: 'checkbox',
      checked: this.settings.get('etlTimetableBubble') !== false,
      click: (mi) => this.setTimetableBubble(mi.checked),
    });
    items.push({
      label: 'eTL 비서 말풍선 보이기',
      type: 'checkbox',
      checked: this.settings.get('etlAssistantBubble') === true,
      click: (mi) => this.setAssistantBubble(mi.checked),
    });
    if (on) items.push({ type: 'separator' }, { label: this.#statusLine(), enabled: false });
    return { label: 'eTL', submenu: items };
  }

  #run() {
    this.#ensureWorkspace();
    if (!this.tracker) {
      this.tracker = new EtlTracker({ createClient: () => this.#client(), stateFile: this.stateFile });
      this.tracker.on('change', (list) => {
        this.trackerItems = list;
        this.#emitItems();
      });
      this.tracker.on('error', (err) => this.log('etl tracker:', err?.message || err));
      this.tracker.start();
      this.electron.powerMonitor.on('resume', this.onResume);
    }
    if (!this.bridge) {
      this.bridge = createBridge({ handlers: this.#handlers() });
      this.bridge.start().catch((err) => {
        this.log('etl bridge:', err.message);
        this.bridge = null;
      });
    }
    this.#startFileBridge();
    if (this.settings.get('etlTimetableBubble') !== false) this.#startNotifier();
    this.#emitItems();
  }

  #startNotifier() {
    if (this.notifier) return;
    this.notifier = new TimetableNotifier({ timetable: this.timetable, createClient: () => this.#client() });
    this.notifier.on('change', (list) => {
      this.timetableItems = list;
      this.#emitItems();
    });
    this.notifier.on('error', (err) => this.log('etl timetable:', err?.message || err));
    this.notifier.start();
  }

  #stopNotifier() {
    this.notifier?.stop();
    this.notifier = null;
    this.timetableItems = [];
  }

  // The tracker's bubbles, and the eTL 비서 bubble when it's turned on. Each one is written to
  // etl-history.log the first time it shows.
  #emitItems() {
    const extra = this.settings.get('etlAssistantBubble') === true
      ? [assistantItem({ since: this.assistantSince, codexInstalled: this.codexInstalled() })]
      : [];
    const items = [...this.trackerItems, ...this.timetableItems, ...extra];
    this.history.record(items);
    this.emit('change', items);
  }

  async #offerAssistant() {
    const where = this.codexInstalled() ? 'Codex의 eTL 비서 대화' : 'eTL 채팅 폴더';
    const { response } = await this.electron.dialog.showMessageBox({
      type: 'question',
      title: 'Ttokttok Pet',
      message: 'eTL 비서 말풍선을 켤까요?',
      detail: `펫 위에 "eTL 비서" 말풍선을 늘 띄워 두고, 누르면 ${where}로 바로 갑니다. 나중에 트레이 메뉴의 Sources → eTL에서 바꿀 수 있습니다.`,
      buttons: ['켜기', '나중에'],
      defaultId: 0,
      cancelId: 1,
    });
    this.settings.set({ etlAssistantAsked: true, etlAssistantBubble: response === 0 });
    if (this.enabled) this.#emitItems();
  }

  // The file bridge lives in the chat folder, so it moves when the folder does.
  #startFileBridge() {
    this.fileBridge?.stop();
    this.fileBridge = null;
    const dir = path.join(this.workspaceDir(), '.etl-bridge');
    try {
      this.fileBridge = createFileBridge({ handlers: this.#handlers(), dir });
      this.fileBridge.start();
    } catch (err) {
      this.log('etl file bridge:', err.message);
      this.fileBridge = null;
    }
  }

  #client() {
    const token = this.token.load();
    return token ? createClient({ token }) : null;
  }

  // Each bridge request reads the token (and the chat folder's place) afresh, so a new token or
  // folder works without a restart.
  #handlers() {
    const handlers = {};
    for (const cmd of Object.keys(COMMANDS)) {
      handlers[cmd] = (args) => {
        const token = this.token.load();
        if (!token) throw new Error(NO_TOKEN);
        const client = createClient({ token });
        if (cmd === 'timetable') return this.#timetableAnswer(client, args);
        if (!FILE_COMMANDS.has(cmd)) return createQueries({ client })[cmd](args);
        return createFiles({
          client, token, workspaceDir: this.workspaceDir(), recordsFile: this.downloadsFile,
        })[cmd](args);
      };
    }
    return handlers;
  }

  // The bridge's timetable command: one day (today unless `date`), and with `week` the weekly
  // classes too. The day's 보강·휴강 come from timetable.md in the chat folder.
  async #timetableAnswer(client, { date, week = false } = {}) {
    const day = date || kstParts(Date.now()).date;
    const result = await this.timetable.day(client, day);
    const answer = {
      now: formatKst(Date.now()),
      date: result.date,
      weekday: result.weekday,
      classes: result.classes,
      cancelled: result.cancelled,
      changes_file: 'timetable.md',
    };
    if (week) {
      const w = await this.timetable.weekly(client);
      answer.weekly = w.courses.map((c) => ({ course: c.name, course_id: c.course_id, meetings: c.meetings }));
    }
    if (result.errors.length) answer.errors = result.errors;
    return answer;
  }

  async #verify(token) {
    let me;
    try {
      me = await createClient({ token }).self();
    } catch (err) {
      if (err instanceof EtlAuthError) throw new Error('토큰이 올바르지 않거나 만료되었습니다. 새로 발급한 토큰을 붙여넣어 주세요.');
      throw err;
    }
    this.token.save(token);
    return { user: me?.name };
  }

  #ensureWorkspace() {
    const dir = this.workspaceDir();
    try {
      ensureWorkspace(dir);
      return dir;
    } catch (err) {
      this.log('etl workspace:', err.message);
      return null;
    }
  }

  #statusLine() {
    if (!this.token.has()) return '토큰 없음';
    const { lastChecked, error } = this.tracker?.status() || {};
    if (error) return `오류: ${String(error).slice(0, 40)}`;
    if (!lastChecked) return '확인 중…';
    const t = new Date(lastChecked);
    const hm = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
    return `마지막 확인 ${hm}`;
  }

  #later(promise) {
    promise.catch((err) => this.log('etl:', err?.message || err));
  }
}

module.exports = { EtlFeature };
