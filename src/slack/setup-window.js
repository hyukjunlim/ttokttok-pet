'use strict';

// The small window that sets up the Slack presentation reminders: the user token, the canvas link
// and the name to look for. It is UI only: the caller's verify({ token, link, name }) reads the
// canvas with them and saves them, and this module only reports how that went. The token field may
// be left empty once a token is saved; verify then uses the saved one.
//
// The page gets a minimal API from slack-setup-preload.js. Its messages are handled on its own
// webContents (webContents.ipc), so no other window can submit a token or close this one.

const path = require('node:path');
const { BrowserWindow, Menu, nativeTheme, shell } = require('electron');

const GUIDE_URL = 'https://api.slack.com/apps';
const MAX_ERROR_LENGTH = 300;
const MAX_FIELD = 512;

let current = null;                     // { win, done } while the window is open

function openGuide() {
  shell.openExternal(GUIDE_URL).catch(() => {});
}

// What the page may show when verify fails: its Korean message, with the token cut out in case
// some lower layer quoted it.
function errorText(err, token) {
  let text = err && typeof err.message === 'string' && err.message.trim()
    ? err.message.trim()
    : 'Slack에서 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.';
  if (token) text = text.split(token).join('(토큰)');
  return text.length > MAX_ERROR_LENGTH ? `${text.slice(0, MAX_ERROR_LENGTH - 1)}…` : text;
}

const field = (v) => (typeof v === 'string' ? v.trim().slice(0, MAX_FIELD) : '');

// Opens the window (or brings the open one forward) and resolves once it closes:
// { saved: true } when verify went through at least once, else { saved: false }.
// `initial`: { link, name, hasToken } to fill the page in with.
function openSetupWindow({ verify, initial = {} } = {}) {
  if (typeof verify !== 'function') throw new TypeError('openSetupWindow needs verify(fields)');
  if (current && !current.win.isDestroyed()) {
    if (current.win.isMinimized()) current.win.restore();
    current.win.show();
    current.win.focus();
    return current.done;
  }

  const win = new BrowserWindow({
    width: 460,
    height: 470,
    useContentSize: true,
    title: 'Slack 발표 알림',
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    autoHideMenuBar: true,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#282623' : '#fffdfa',
    webPreferences: {
      preload: path.join(__dirname, '..', 'slack-setup-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  win.removeMenu();

  let result = { saved: false };
  let inFlight = null;
  let resolveDone;
  const done = new Promise((resolve) => { resolveDone = resolve; });
  current = { win, done };

  const wc = win.webContents;
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  wc.on('will-navigate', (e) => e.preventDefault());
  wc.on('will-redirect', (e) => e.preventDefault());
  wc.on('will-attach-webview', (e) => e.preventDefault());
  wc.on('render-process-gone', () => {
    if (!win.isDestroyed()) win.close();
  });
  wc.on('context-menu', (_e, params) => {
    if (!params.isEditable || win.isDestroyed()) return;
    Menu.buildFromTemplate([
      { role: 'paste', label: '붙여넣기' },
      { role: 'selectAll', label: '모두 선택' },
    ]).popup({ window: win });
  });

  const fromPage = (event) => !win.isDestroyed() && event.sender === wc;

  wc.ipc.handle('slack-setup:initial', (event) => (fromPage(event)
    ? { link: field(initial.link), name: field(initial.name), hasToken: initial.hasToken === true }
    : null));
  wc.ipc.handle('slack-setup:submit', async (event, raw) => {
    if (!fromPage(event)) return { ok: false, error: '잘못된 요청입니다.' };
    if (inFlight) return { ok: false, error: '확인 중입니다. 잠시만 기다려 주세요.' };
    const fields = { token: field(raw?.token), link: field(raw?.link), name: field(raw?.name) };
    inFlight = Promise.resolve().then(() => verify(fields));
    try {
      const info = await inFlight;
      result = { saved: true };
      const turns = Array.isArray(info?.turns) ? info.turns.slice(0, 20).map((t) => String(t).slice(0, 100)) : [];
      return { ok: true, turns };
    } catch (err) {
      return { ok: false, error: errorText(err, fields.token) };
    } finally {
      inFlight = null;
    }
  });
  wc.ipc.on('slack-setup:guide', (event) => {
    if (fromPage(event)) openGuide();
  });
  wc.ipc.on('slack-setup:close', (event) => {
    if (fromPage(event)) win.close();
  });

  win.once('ready-to-show', () => {
    if (win.isDestroyed()) return;
    win.show();
    win.focus();
  });
  win.on('closed', () => {
    if (current && current.win === win) current = null;
    const pending = inFlight;
    if (pending) pending.then(() => resolveDone(result), () => resolveDone(result));
    else resolveDone(result);
  });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'slack-setup.html')).catch(() => {
    if (!win.isDestroyed()) win.close();
  });
  return done;
}

module.exports = { openSetupWindow, GUIDE_URL };
