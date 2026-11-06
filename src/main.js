'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile, execFileSync, spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { format } = require('node:util');
const {
  app, BrowserWindow, Menu, Tray, clipboard, dialog, globalShortcut, ipcMain, nativeImage, nativeTheme, net, powerMonitor, protocol,
  safeStorage, screen, shell,
} = require('electron');
const { Settings, DEFAULTS } = require('./settings');
const { discoverPets, petRoots } = require('./pets');
const { SessionTracker, defaultPaths, liveBridges } = require('./sessions');
const { CodexTracker, codexPaths } = require('./codex');
const { CodexAccountsFeature } = require('./codex-accounts/feature');
const { compareSessions } = require('./transcript');
const { timeline } = require('./timeline');
const { combineClaudeUsage, usageView } = require('./usage');
const { ClaudeUsage } = require('./claude-usage');
const { LocalMod, bundledVersion, modFiles, runningWslDistros, sshInstaller, wslInstaller } = require('./claude-mod');
const { isSameHost, sshConfigHosts } = require('./ssh-config');
const { cleanShape, shapeForWindow, NO_SHAPE } = require('./shape');
const { DemoTracker } = require('./demo');
const { checkForRelease, checkForUpdate, startUpdate } = require('./updater');
const { raiseBrowserWindow, raiseCodexWindow, raisePaseoWindow, raiseVsCodeWindow, vsCodePlace } = require('./raise');
const { archiveCodexChat, canDelete, deleteClaudeSession, isChat } = require('./chat-delete');
const { watchWindowOrder } = require('./window-order');
const { EtlFeature } = require('./etl/feature');
const { SlackFeature } = require('./slack/feature');
const { TodomateFeature } = require('./todomate/feature');
const { WebChatsFeature } = require('./webchats/feature');
const { PhoneFeature } = require('./phone/feature');
const { FolderWindow, displayChoices } = require('./folder-mode');
const { buildTree, attentionIds, hiddenMenu } = require('./folder-tree');
const { markNewChats, newChatLinks, placeOf, sshTargets } = require('./new-chat');
const { settleMarks } = require('./marks');
const { maximizeApps } = require('./maximize');
const { StepKeys } = require('./step-keys');
const { moveFolder, previous } = require('./migrate');
const { GettingStarted } = require('./onboarding');

const DEMO = process.argv.includes('--demo');
// Debug aid: TTOKTTOK_PET_USER_DATA=<dir> keeps settings, the log and the single-instance lock
// there, so a second copy can run next to the one you use.
const DEBUG_USER_DATA = process.env.TTOKTTOK_PET_USER_DATA || null;
const DEBUG_CAPTURE_DIR = process.env.TTOKTTOK_PET_CAPTURE_DIR || null;
const DEBUG_OPEN_AFTER_MS = Number(process.env.TTOKTTOK_PET_DEBUG_OPEN_AFTER_MS) || 0;

const APP_ROOT = path.join(__dirname, '..');
// A clone runs as `electron <folder>`, so the folder goes on the command line whenever the pet
// starts itself again; a downloaded copy (an installer or zip, see "build" in package.json) is
// its own exe and needs no argument.
const ROOT_ARGS = app.isPackaged ? [] : [APP_ROOT];
// The pet and what it starts (its PowerShell helpers, the updater) work in the home folder, not the
// one the pet was started in, so they never keep that folder from being moved or deleted.
process.chdir(os.homedir());
const RENDERER_DIR = path.join(__dirname, 'renderer');
const CELL = { width: 192, height: 208 };
const WIN_WIDTH = 400;
const TRAY_HEIGHT = 280;        // room kept above (or below) the pet for bubbles, at least
const TRAY_GAP = 6;
const EDGE_MARGIN = 24;
const BUBBLE_MARGIN = 12;       // bubbles keep this distance from the monitor's edge
const SCALES = [
  { label: 'Small', value: 0.5 },
  { label: 'Medium', value: 0.75 },
  { label: 'Large', value: 1 },
];
// Throw physics, same constants as ChatGPT's pet.
const MOMENTUM_TICK_MS = 16;
const MOMENTUM_MAX_DT_MS = 32;
const FRICTION_PER_TICK = 0.88;
const BOUNCE = 0.7;
const STOP_SPEED = 65;
const MAX_MOMENTUM_MS = 900;
const MIN_THROW_SPEED = 450;
const STATUS_LABEL = { waiting: 'Needs you', failed: 'Error', review: 'Ready', running: 'Running', background: 'Background' };
const DESKTOP_SESSION_RE = /^local_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const CLI_SESSION_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;   // a VS Code or terminal session's
const APP_LINK = { claude: 'claude://hotkey', codex: 'codex://launch' };   // bring the app's window forward
const ETL_LINK = /^https:\/\/myetl\.snu\.ac\.kr\//;   // the only pages an eTL bubble opens
const WEB_LINK = /^https:\/\/(claude\.ai|chatgpt\.com|gemini\.google\.com)\//;   // and a web chat's
const SLACK_LINK = /^https:\/\/[a-z0-9-]+\.(enterprise\.)?slack\.com\/docs\//;   // and a Slack reminder's canvas
const FOREGROUND_HANDOFF_MS = 1500;
const LOG_MAX_BYTES = 1024 * 1024;  // then the log starts over, keeping the last one as ttokttok-pet.old.log

protocol.registerSchemesAsPrivileged([
  { scheme: 'pet', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

let settings;
let tracker;
let codexAccounts = null;
let codex = null;               // Codex threads, when Codex is installed and shown
let etl = null;                 // SNU eTL notices, when turned on (see etl/feature.js)
let slack = null;               // presentation reminders from a Slack canvas, when turned on (see slack/feature.js)
let todomate = null;            // today's TodoMate schedule, when turned on (see todomate/feature.js)
let webchats = null;            // claude.ai and ChatGPT chats, when turned on (see webchats/feature.js)
let phone = null;               // the sidebar on your phone, when turned on (see phone/feature.js)
let win = null;
let tray = null;
let pets = [];
let currentPet = null;
let petPos = null;              // top-left of the pet sprite, screen DIPs
let layout = 'above';           // pills above or below the pet
let shape = null;               // what the page says is drawn: the pet and the bubbles (see shape.js)
let shapeKey = '';              // the shape last set on the window, to skip setting it again
let drag = null;
let momentumTimer = null;
let trayHeight = TRAY_HEIGHT;   // what the bubbles need, as the page measures it
let sessions = [];              // Claude, Codex, eTL and web chats together, most urgent first
let claudeSessions = [];
let codexSessions = [];
let etlSessions = [];
let slackSessions = [];
let todomateSessions = [];
let webSessions = [];
let folder = null;              // folder mode's sidebar (see folder-mode.js)
let stepKeys = null;            // Ctrl+Tab through the sidebar (see step-keys.js)
let claudeAll = [];             // every Claude session, Codex thread and web chat, quiet ones too, for folder mode
let codexAll = [];
let webAll = [];
const deleted = new Map();      // id -> when: chats deleted in the sidebar, left out until the trackers see them go
let treeKey = '';
let treeHosts = [];             // the tree last built for the sidebar, for its folders' menus
let quitting = false;
const usage = { claude: [], codex: null };   // Claude's readings from each place, Codex's newest (see usage.js)
let claudeUsage = null;         // where Claude's readings come from (see claude-usage.js)
let localMod = null;            // the pet's Claude Code mod on this PC (see claude-mod.js)
let modBusy = null;             // what the Live Claude usage menu is doing, while it does it
let userDataNote = null;        // what became of an older install's %APPDATA% folder, for the log (userDataDir)
let gettingStarted = null;      // the Getting started window and its practice items (see onboarding.js)
let usageSetupErrors = {};      // Getting started's Claude usage step: place key -> why it couldn't be set up
const modUpdated = new Set();   // SSH hosts whose copy of the mod was brought up to date this run
const wslAsked = new Set();     // the WSL distros checkWsl has asked this run
let wslTimer = null;
let wslChatsTimer = null;       // syncWslChats, while the pet runs
const wslHomes = new Map();     // WSL distro -> its $HOME, asked while it ran
let wslRunning = new Set();     // the distros running at syncWslChats's last look
let wslChatsKey = '';
let usageKey = '';
let usageTimer = null;
let logFile = null;
let logBytes = 0;
let update = null;              // what the last check found, when there's an update waiting
let updateBusy = null;          // 'checking' while looking, 'asking' while a dialog is up

// Started from a terminal or by another program, the pet writes its lines to that program's pipe
// as well. Once that program has gone, writing there fails (EPIPE), and unhandled, the error would
// end the pet with a "JavaScript error occurred in the main process" box. The log file has every
// line, so a console that can't be written to is let go.
for (const stream of [process.stdout, process.stderr]) stream.on('error', () => {});

// The pet usually runs without a console, so lines also go to ttokttok-pet.log in the app's logs
// folder (%APPDATA%\ttokttok-pet\logs on Windows).
function log(...args) {
  const now = new Date();
  const pad = (n, width = 2) => String(n).padStart(width, '0');
  const day = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const line = `[ttokttok-pet ${day} ${now.toTimeString().slice(0, 8)}.${pad(now.getMilliseconds(), 3)}] ${format(...args)}`;
  console.log(line);
  try {
    if (!logFile) {
      logFile = path.join(app.getPath('logs'), 'ttokttok-pet.log');
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      logBytes = fs.statSync(logFile, { throwIfNoEntry: false })?.size || 0;
    }
    if (logBytes > LOG_MAX_BYTES) {
      fs.renameSync(logFile, logFile.replace(/\.log$/, '.old.log'));
      logBytes = 0;
    }
    fs.appendFileSync(logFile, `${line}\n`);
    logBytes += Buffer.byteLength(line) + 1;
  } catch {
    // the console still has it
  }
}

// ---------------------------------------------------------------- geometry

// The floating pet's scale (tray menu → Appearance → Size), or `s`: folder mode's pet has a size of its own.
function petScale(s = settings.get('scale')) {
  if (currentPet?.pixelArt) {
    // Snap so every art pixel (4 atlas px) covers a whole number of device pixels.
    const dpr = displayForPet().scaleFactor || 1;
    s = Math.max(1, Math.round(4 * s * dpr)) / (4 * dpr);
  }
  return s;
}

function petSize() {
  const s = petScale();
  return { width: CELL.width * s, height: CELL.height * s, scale: s };
}

function displayForPet(pos = petPos) {
  if (!pos) return screen.getPrimaryDisplay();
  const s = settings.get('scale');
  return screen.getDisplayNearestPoint({
    x: Math.round(pos.x + (CELL.width * s) / 2),
    y: Math.round(pos.y + (CELL.height * s) / 2),
  });
}

function clampPet(pos) {
  const { width, height } = petSize();
  const wa = displayForPet(pos).workArea;
  return {
    x: Math.min(Math.max(pos.x, wa.x), wa.x + wa.width - width),
    y: Math.min(Math.max(pos.y, wa.y), wa.y + wa.height - height),
  };
}

function defaultPosition() {
  const wa = screen.getPrimaryDisplay().workArea;
  const { width, height } = petSize();
  return { x: wa.x + wa.width - width - EDGE_MARGIN - 40, y: wa.y + wa.height - height - EDGE_MARGIN };
}

// Bubbles go above the pet when there's room for a few of them there. The stack then grows
// upward as sessions come in, and scrolls if it reaches the top of the monitor.
function chooseLayout(pos) {
  const room = pos.y - displayForPet(pos).workArea.y;
  const need = TRAY_HEIGHT + TRAY_GAP;
  if (layout === 'above' && room < need) return 'below';
  if (layout === 'below' && room > need + 40) return 'above';
  return layout;
}

// The window stays on the pet's monitor so the bubbles belong to it. Near an edge the
// window stops at the edge and the pet moves within it, so the pet can still reach the edge.
// It's as tall as the bubbles need, up to the edge of the monitor (then they scroll).
function windowBounds() {
  const { width, height } = petSize();
  const wa = displayForPet().workArea;
  const petH = Math.ceil(height);
  const room = (layout === 'above' ? petPos.y + height - wa.y : wa.y + wa.height - petPos.y) - petH - TRAY_GAP;
  const h = petH + TRAY_GAP + Math.min(trayHeight, Math.max(TRAY_HEIGHT, Math.floor(room)));
  const centered = petPos.x + width / 2 - WIN_WIDTH / 2;
  const x = wa.width >= WIN_WIDTH ? Math.min(Math.max(centered, wa.x), wa.x + wa.width - WIN_WIDTH) : wa.x;
  return {
    x: Math.round(x),
    y: layout === 'above' ? Math.round(petPos.y + height - h) : Math.round(petPos.y),
    width: WIN_WIDTH,
    height: h,
  };
}

// Always set the full bounds: when the pet crosses onto a monitor with different
// scaling, Windows rescales the window and only moving it would keep the wrong size.
let lastLayoutKey = '';
function placeWindow() {
  if (!win || win.isDestroyed()) return;
  const b = windowBounds();
  win.setBounds(b);
  applyShape();
  if (layoutKey(b) !== lastLayoutKey) sendLayout();
}

// The window takes the mouse only where the pet or a bubble is drawn; clicks elsewhere go to the
// window behind it. The page measures them from the edge the content sits against, so this lays
// them on the window as it is now (see shape.js). Windows keeps the shape in pixels, so it is set
// again when the pet's monitor has a different scaling.
let shapeScale = 0;
function applyShape() {
  if (!win || win.isDestroyed()) return;
  const { width, height } = win.getBounds();
  const rects = shape ? shapeForWindow(shape, width, height) : NO_SHAPE;
  const scale = displayForPet().scaleFactor;
  const key = `${scale}|${JSON.stringify(rects)}`;
  if (key === shapeKey) return;
  const rescaled = shapeScale !== 0 && scale !== shapeScale;
  shapeKey = key;
  shapeScale = scale;
  win.setShape(rects);
  if (rescaled) {
    // Windows may rescale the window a moment after it was moved onto the other monitor.
    const current = win;
    setTimeout(() => {
      if (current !== win || current.isDestroyed()) return;
      shapeKey = '';
      applyShape();
    }, 200);
  }
}

function layoutKey(b) {
  return `${layout}|${petScale()}|${Math.round((petPos.x - b.x) * 4)}`;
}

function sendLayout() {
  if (!win || win.isDestroyed()) return;
  const b = windowBounds();
  lastLayoutKey = layoutKey(b);
  win.webContents.send('pet:layout', {
    layout,
    scale: petScale(),
    petLeft: petPos.x - b.x,
    margin: BUBBLE_MARGIN,
  });
}

// Apply a change that alters the pet's size while keeping its feet where they were.
function resizeInPlace(change) {
  const before = petSize();
  const anchor = { x: petPos.x + before.width / 2, y: petPos.y + before.height };
  change();
  const after = petSize();
  petPos = clampPet({ x: anchor.x - after.width / 2, y: anchor.y - after.height });
  finishMove();
}

function finishMove() {
  const next = chooseLayout(petPos);
  const changed = next !== layout;
  layout = next;
  placeWindow();
  sendLayout();
  if (changed) log(`pills now ${layout} the pet`);
  settings.set({ position: petPos });
}

// ---------------------------------------------------------------- window

function createWindow() {
  win = new BrowserWindow({
    ...windowBounds(),
    title: 'Ttokttok Pet',
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: false,
    show: false,
    // Windows tool windows stay across virtual desktops.
    ...(process.platform === 'win32' ? { type: 'toolbar', thickFrame: false, roundedCorners: false, accentColor: false } : {}),
    ...(process.platform === 'darwin' ? { type: 'panel' } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      spellcheck: false,
    },
  });
  watchWindowOrder(win, { log });
  // Windows puts the floating level behind the taskbar; pop-up-menu avoids that
  // anchor changing the pet's topmost status when the taskbar hides.
  win.setAlwaysOnTop(true, process.platform === 'win32' ? 'pop-up-menu' : 'floating');
  win.setMenuBarVisibility(false);
  // Until the page says where the pet is, the window takes no mouse at all.
  shape = null;
  shapeKey = '';
  applyShape();
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  const created = win;
  win.webContents.on('render-process-gone', (_e, details) => {
    log('renderer exited:', details.reason, `(exit code ${details.exitCode})`);
    if (details.reason !== 'clean-exit') setTimeout(() => replaceWindow(created), 1000);
  });
  win.once('ready-to-show', () => {
    if (settings.get('visible') && settings.get('mode') !== 'folder') {
      win.showInactive();
      wake();
    }
  });
  win.loadURL('pet://app/ui/index.html');
}

// A crashed page gets a new window rather than a reload, so the new page starts out as the main
// process then assumes: with no drag under way, and no shape until the page says where the pet is.
function replaceWindow(old) {
  if (old !== win || old.isDestroyed()) return;
  drag = null;
  createWindow();
  old.destroy();
}

function setVisible(visible) {
  settings.set({ visible });
  applyMode();
  gettingStarted?.visibilityChanged(visible);
}

// The monitor the sidebar docks on: the one picked in the tray menu while it's connected, else
// the floating pet's.
function folderDisplay() {
  const id = settings.get('folderDisplay');
  return screen.getAllDisplays().find((d) => d.id === id) ?? displayForPet();
}

// The tray menu's Sidebar position: the sidebar opens again on `display` (an id), against `edge`.
async function placeSidebar({ display = settings.get('folderDisplay'), edge = settings.get('folderEdge') }) {
  settings.set({ folderDisplay: display, folderEdge: edge === 'right' ? 'right' : 'left' });
  log(`sidebar: ${settings.get('folderEdge')} edge of display ${display ?? '(the pet’s)'}`);
  if (settings.get('mode') !== 'folder' || !settings.get('visible')) return;
  await folder.close();
  applyMode();
}

// Shows the floating pet or the folder sidebar, whichever the mode is, if the pet is to be seen.
function applyMode() {
  const visible = settings.get('visible');
  if (settings.get('mode') === 'folder') {
    if (win && !win.isDestroyed()) win.hide();
    if (visible) {
      folder.show(folderDisplay(), settings.get('folderEdge'));
      treeKey = '';
      stepKeys.start();
    } else {
      stepKeys.stop();
      folder.close();
    }
    return;
  }
  stepKeys.stop();
  folder.close();
  if (!win || win.isDestroyed()) return;
  if (visible) {
    win.showInactive();
    wake();
  } else {
    win.hide();
  }
}

function setMode(mode) {
  if ((mode !== 'pet' && mode !== 'folder') || mode === settings.get('mode')) return;
  settings.set({ mode, visible: true });
  log(`mode: ${mode}`);
  applyMode();
}

function wake() {
  win?.webContents.send('pet:wake');
  folder?.send('folder:wake');
}

// ---------------------------------------------------------------- pets

function sheetUrl(pet) {
  let v = 0;
  try {
    v = Math.round(fs.statSync(pet.sheet).mtimeMs);
  } catch {
    // keep 0
  }
  return `pet://app/sheet/${encodeURIComponent(pet.key)}?v=${v}`;
}

function loadPets() {
  pets = discoverPets(APP_ROOT, log);
  currentPet = pets.find((p) => p.key === settings.get('petKey')) || pets.find((p) => p.key === DEFAULTS.petKey) || pets[0] || null;
  log(`pets: ${pets.map((p) => p.key).join(', ') || 'none'}; using ${currentPet?.key}`);
}

function sendPet() {
  if (!currentPet) return;
  const payload = {
    key: currentPet.key,
    displayName: currentPet.displayName,
    url: sheetUrl(currentPet),
    rows: currentPet.rows,
    pixelArt: currentPet.pixelArt,
  };
  if (win && !win.isDestroyed()) win.webContents.send('pet:pet', payload);
  folder?.send('folder:pet', { ...payload, scale: petScale(settings.get('folderPetScale')) });
}

function sendMotion() {
  const motion = { alwaysAnimate: settings.get('alwaysAnimate') === true };
  if (win && !win.isDestroyed()) win.webContents.send('pet:motion', motion);
  folder?.send('folder:motion', motion);
}

function selectPet(key) {
  const pet = pets.find((p) => p.key === key);
  if (!pet) return;
  resizeInPlace(() => {
    currentPet = pet;
    settings.set({ petKey: key });
  });
  tray?.setImage(trayImageFor(pet));
  sendPet();
  wake();
}

// A pet can ship its own tray icon (tray.png, plus @1.5x/@2x variants) next to its sprite
// sheet; otherwise the default icon is used.
function trayImageFor(pet) {
  const own = pet ? path.join(pet.dir, 'tray.png') : null;
  const file = own && fs.existsSync(own) ? own : path.join(APP_ROOT, 'assets', 'tray.png');
  log(`tray icon: ${path.relative(APP_ROOT, file) || file}`);
  return nativeImage.createFromPath(file);
}

function handleProtocol(request) {
  const url = new URL(request.url);
  if (url.hostname !== 'app') return new Response('Not found', { status: 404 });
  if (url.pathname.startsWith('/sheet/')) {
    const key = decodeURIComponent(url.pathname.slice('/sheet/'.length));
    const pet = pets.find((p) => p.key === key);
    if (!pet) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(pet.sheet).toString());
  }
  if (url.pathname.startsWith('/ui/')) {
    const file = path.normalize(path.join(RENDERER_DIR, decodeURIComponent(url.pathname.slice('/ui/'.length))));
    if (!file.startsWith(RENDERER_DIR + path.sep)) return new Response('Forbidden', { status: 403 });
    return net.fetch(pathToFileURL(file).toString());
  }
  return new Response('Not found', { status: 404 });
}

// ---------------------------------------------------------------- sessions

function sendSessions() {
  // Folder mode: the pet acts out the most urgent session, as the floating pet does, and eTL's
  // notices sit under the tree.
  folder?.send('folder:status', sessions[0]?.status || 'idle');
  folder?.send('folder:notices', currentNotices());
  if (!win || win.isDestroyed()) return;
  // Getting started's practice bubble goes first, and shows even with the bubbles turned off.
  const practice = gettingStarted?.petItems() ?? [];
  win.webContents.send('pet:sessions', {
    sessions: [...practice, ...sessions],
    showActivity: settings.get('showActivity') || practice.length > 0,
    showSessions: settings.get('showSessionBubbles') !== false,
  });
  if (tray) tray.setToolTip(trayTooltip());
}

// eTL's, Slack's and TodoMate's bubbles, today's classes and schedule in one timeline.
function currentNotices() {
  return timeline([...etlSessions, ...slackSessions, ...todomateSessions]);
}

function mergeSessions() {
  sessions = timeline([...claudeSessions, ...codexSessions, ...etlSessions, ...slackSessions, ...todomateSessions, ...webSessions]).filter((s) => !isDeleted(s.id)).sort(compareSessions);
  sendSessions();
  phone?.changed();
  phone?.observe(sessions, currentHidden());
  if (DEBUG_CAPTURE_DIR) debugCapture(sessions);
}

// Every session under its machine and folder (folder-tree.js), less the hidden and deleted ones;
// `hiddenOnly`: just the hidden ones, for the tray menu's Hidden from the sidebar.
function currentTree({ marked = currentMarks(), hidden = currentHidden(), sshHosts = sshConfigHosts(), hiddenOnly = false } = {}) {
  const shown = (list) => list.filter((s) => Object.hasOwn(hidden, s.id) === hiddenOnly && !isDeleted(s.id));
  return buildTree({
    claude: shown(claudeAll),
    codex: shown(codexAll),
    chats: shown(webAll),
    sshHosts,
    codexConnections: codex?.connections ?? [],
    defaultWsl: wslDistros()[0] ?? null,
    marked,
  });
}

// Folder mode's tree: every session, under its machine and folder (see folder-tree.js).
function sendTree() {
  const marked = currentMarks();
  const hidden = currentHidden();
  phone?.changed();
  if (!folder?.open) return;
  const sshHosts = sshConfigHosts();
  const hosts = markNewChats(currentTree({ marked, hidden, sshHosts }), newChatOptions(sshHosts));
  treeHosts = [...hosts];   // without the practice sessions, which have no real folders
  const practice = gettingStarted?.folderHost();   // Getting started's practice sessions, on top
  if (practice) hosts.unshift(practice);
  const key = JSON.stringify(hosts);
  if (key === treeKey) return;
  treeKey = key;
  folder.send('folder:tree', hosts);
}

// The sessions you marked as Ready (marks.js), less the ones you've since sent a message. Marks
// were follow-up flags before; those carry over.
function currentMarks() {
  const flags = settings.get('flags');
  if (flags) settings.set({ marked: { ...flags, ...settings.get('marked') }, flags: undefined });
  const saved = settings.get('marked') || {};
  const left = settleMarks(saved, [...claudeAll, ...codexAll, ...webAll]);
  if (left !== saved) settings.set({ marked: left });
  return left;
}

// Mark as Ready: a session you'd marked done gets back what it had (a question still in the
// next-step box is Needs you again); a quiet one shows as Ready until you mark it done or message it.
function markReady(id) {
  trackerFor(id)?.undismiss?.(id);   // the lists update right away
  persistDismissed();
  const s = [claudeAll, codexAll, webAll].reduce((found, list) => found ?? list.find((x) => x.id === id), null);
  if (!s || s.status === 'idle') settings.set({ marked: { ...currentMarks(), [id]: Date.now() } });
  sendTree();
}

// Mark as done: a session's Ready, Error or Needs you is settled, as its bubble's × settles it,
// and your mark on it goes.
function markDone(ids) {
  const marked = { ...currentMarks() };
  for (const id of ids) {
    trackerFor(id)?.dismiss(id);
    delete marked[id];
  }
  settings.set({ marked });
  persistDismissed();
  sendTree();
}

// The sessions you hid from the sidebar: session id -> when. One stays hidden whatever happens in
// it, until the tray menu's Hidden from the sidebar brings it back (setHidden).
function currentHidden() {
  return settings.get('hidden') || {};
}

// `ids` null: every hidden session shows again.
function setHidden(ids, on) {
  const hidden = ids == null ? {} : { ...currentHidden() };
  const now = Date.now();
  for (const id of ids ?? []) {
    if (on) hidden[id] = now;
    else delete hidden[id];
  }
  settings.set({ hidden });
  sendTree();
}

// Mark all as done: what shows Needs you, Error or Ready in the whole sidebar, or (`ids`) in one
// machine or folder, is settled at once.
function markAllItem(ids = null) {
  const pending = attentionIds(treeHosts);
  const todo = ids ? pending.filter((id) => ids.includes(id)) : pending;
  return { label: 'Mark all as done', enabled: todo.length > 0, click: () => markDone(todo) };
}

// A sidebar row's own menu: a session's (mark it done or Ready, hide it, delete a VS Code or
// terminal chat), or a machine's or a folder's (fold it, mark or hide what's in it, and in a folder
// start a new chat). Null for anywhere else, which gets the tray menu with Mark all as done.
function rowMenu(target) {
  const known = (id) => typeof id === 'string' && [claudeAll, codexAll, webAll].some((list) => list.some((s) => s.id === id));
  if (target?.kind === 'session' && known(target.id)) {
    const { id } = target;
    const s = listedSession(id);
    const status = s?.status;
    const pending = Object.hasOwn(currentMarks(), id) || status === 'review' || status === 'failed' || status === 'waiting';
    return Menu.buildFromTemplate([
      pending ? { label: 'Mark as done', click: () => markDone([id]) } : { label: 'Mark as Ready', click: () => markReady(id) },
      { label: 'Hide from the sidebar', click: () => setHidden([id], true) },
      // Not while it's working or was written to just now: it may still be open.
      ...(isChat(s) ? [{ type: 'separator' }, { label: 'Delete…', enabled: canDelete(s), click: () => deleteChat(id) }] : []),
    ]);
  }
  if (target?.kind === 'folder' && typeof target.key === 'string' && Array.isArray(target.ids)) {
    const { key } = target;
    const open = target.open === true;
    const ids = target.ids.filter(known);
    const chats = newChatItems(key);
    return Menu.buildFromTemplate([
      ...chats,
      ...(chats.length ? [{ type: 'separator' }] : []),
      { label: open ? 'Collapse' : 'Expand', click: () => folder?.send('folder:fold', { key, open: !open }) },
      { type: 'separator' },
      markAllItem(ids),
      { label: 'Hide from the sidebar', enabled: ids.length > 0, click: () => setHidden(ids, true) },
    ]);
  }
  return null;
}

// A folder's menu (its + or a right-click) starts a new chat there in Claude or Codex, by the
// app's own link (new-chat.js).
function newChatItems(key) {
  const links = newChatLinks(placeOf(treeHosts, key), newChatOptions());
  return [
    ...(links.claude ? [{ label: 'New Claude Code session here', click: () => startChat(links.claude, 'claude') }] : []),
    ...(links.codex ? [{ label: 'New Codex chat here', click: () => startChat(links.codex, 'codex') }] : []),
  ];
}

// Which apps can start chats, and the SSH hosts by the name Claude knows them by: a saved
// connection's, or its sessions'.
function newChatOptions(sshHosts = sshConfigHosts()) {
  const machineKeys = [...(tracker?.connectionNames?.keys() ?? []), ...claudeAll.filter((s) => s.kind === 'desktop').map((s) => s.machineKey)];
  return {
    claude: claudeInstalled(),
    codex: settings.get('showCodex') && codexInstalled(),
    claudeSsh: sshTargets(machineKeys),
    codexProjects: codex?.projects ?? [],
    sshHosts,
  };
}

// The app opens its new-chat page and fills the rest of the screen, as a session opened from the
// sidebar does; the chat shows in the tree once you've sent its first message.
function startChat(url, which) {
  log(`new ${which} chat: ${url}`);
  openApp(url);
  maximizeApps('open', which);
}

// A session as the full lists have it (with its machine), whether or not it has a bubble.
function listedSession(id) {
  return [claudeAll, codexAll, webAll].reduce((found, list) => found ?? list.find((s) => s.id === id), null);
}

// Left out for two minutes after you deleted it, by when its tracker has looked again. One still
// there after that wasn't deleted, and shows again.
function isDeleted(id) {
  const at = deleted.get(id);
  if (at && Date.now() - at > 2 * 60_000) deleted.delete(id);
  return deleted.has(id);
}

// The sidebar's Delete, once you confirm it (chat-delete.js): a Claude Code session's files go,
// a Codex chat is archived by Codex.
async function deleteChat(id) {
  const s = listedSession(id);
  if (!canDelete(s)) return;
  const job = deleteJob(s);
  if (!job) {
    dialog.showMessageBox({ type: 'error', title: 'Ttokttok Pet', message: `Couldn't find where "${s.title}" is kept.`, buttons: ['OK'] });
    return;
  }
  const options = {
    type: 'warning',
    title: 'Ttokttok Pet',
    message: job.archive ? `Archive "${s.title}" in Codex?` : `Delete "${s.title}"?`,
    detail: job.detail,
    buttons: [job.archive ? 'Archive' : 'Delete', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  };
  const parent = folder?.open ? folder.win : null;
  const answer = await (parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options));
  if (answer.response !== 0) return;
  try {
    await job.run();
  } catch (err) {
    log(`delete ${id}:`, err.message);
    dialog.showMessageBox({ type: 'error', title: 'Ttokttok Pet', message: `Couldn't delete "${s.title}"`, detail: err.message, buttons: ['OK'] });
    return;
  }
  log(`deleted ${id} (${job.where})`);
  deleted.set(id, Date.now());
  const marked = { ...currentMarks() };
  delete marked[id];
  settings.set({ marked });
  setHidden([id], false);   // sends the tree
  mergeSessions();
  if (s.kind === 'codex') codex?.rescan();
  else tracker?.kick?.({ projects: true });
}

// What deleting `s` takes, and what the confirmation says: null if it can't be found.
function deleteJob(s) {
  const record = "Claude Code's record of this session (its transcript and folder)";
  const gone = "It won't be in /resume or in VS Code's past sessions any more.";
  if (s.kind === 'codex') {
    const threadId = s.id.slice('codex:'.length);
    const at = codex?.chatPlace(threadId);
    if (!at) return null;
    const where = at.place === 'wsl' ? `WSL (${at.distro})` : at.place === 'ssh' ? at.host.name : 'this PC';
    return {
      archive: true,
      where,
      detail: `Codex on ${where} archives this chat. You can bring it back from Codex's archived chats.`,
      run: () => archiveCodexChat({ threadId, ...at }),
    };
  }
  const sessionId = s.sessionId;
  const ssh = /^ssh:/.test(s.machineKey || '');
  if (ssh) {
    const host = claudeUsage?.hostFor(s.machineKey);
    if (!host) return null;
    return {
      where: host.name,
      detail: `${record} is deleted on ${host.name}, for good. ${gone}`,
      run: () => deleteClaudeSession({ sessionId, place: 'ssh', host }),
    };
  }
  const c = tracker?.cliSessions?.get(sessionId);
  if (!c?.file) return null;
  const wsl = /^wsl:(.+)$/.exec(c.machineKey || '')?.[1];
  return {
    where: wsl ? `WSL (${wsl})` : 'this PC',
    detail: wsl
      ? `${record} is deleted in WSL (${wsl}), for good: the Recycle Bin can't take files from WSL. ${gone}`
      : `${record} goes to the Recycle Bin. ${gone}`,
    run: () => deleteClaudeSession({ sessionId, place: wsl ? 'wsl' : 'local', file: c.file, trashItem: (p) => shell.trashItem(p) }),
  };
}

// ---------------------------------------------------------------- Getting started (see onboarding.js)

function startGettingStarted() {
  gettingStarted = new GettingStarted({
    log,
    state: gettingStartedState,
    changed: () => {
      sendSessions();
      sendTree();
    },
    // Its Claude usage step asked, if it had somewhere to set the mod up; otherwise the pet still
    // asks once Claude Code turns up (offerLiveUsage).
    closed: () => {
      if (usagePlaces().length) settings.set({ claudeModOffered: true });
    },
    actions: {
      mode: (mode) => {
        setMode(mode);
        setTimeout(() => gettingStarted.raise(), 1500);   // after the sidebar docks and the apps move
      },
      usage: setUpUsage,
      etl: () => etl?.setEnabled(true, { openChat: false }),
      todomate: () => todomate?.setEnabled(true),
      slack: () => slack?.setEnabled(true),
      web: (on) => webchats?.setEnabled(on, { quiet: true }),
      extensionFolder: () => webchats?.openExtensionFolder(),
      phone: (on) => phone?.setEnabled(on, { quiet: true }).then(() => on && phone.checkSetup()),
      phoneCheck: () => phone?.checkSetup(),
      phoneServe: () => phone?.serveForSetup(),
      phoneCode: () => phone?.codeForSetup(),
      phoneOpen: (url) => shell.openExternal(url),   // a Tailscale page (onboarding.js checks)
      doc: (name) => name === 'usage' && shell.openExternal(LIVE_USAGE_DOC),
    },
  });
}

function gettingStartedState() {
  return {
    mode: settings.get('mode'),
    pet: currentPet ? { url: sheetUrl(currentPet), pixelArt: currentPet.pixelArt === true } : null,
    usage: { places: usagePlaces(), busy: modBusy, errors: usageSetupErrors },
    etl: { available: Boolean(etl), enabled: Boolean(etl?.enabled) },
    todomate: { available: Boolean(todomate), enabled: Boolean(todomate?.enabled) },
    slack: { available: Boolean(slack), enabled: Boolean(slack?.enabled) },
    web: {
      available: Boolean(webchats),
      on: Boolean(webchats?.enabled),
      connected: webchats?.chats.connected() ?? 0,
      folder: webchats?.extensionDir() ?? '',
    },
    phone: phone ? { available: true, ...phone.setupState() } : { available: false },
  };
}

// Where Claude Code is, for the mod: this PC, its WSL distros, the SSH hosts the pet reads.
function usagePlaces() {
  if (!localMod) return [];
  const local = localMod.status();
  const places = [];
  if (localMod.hasClaudeCode() || local.version != null) {
    places.push({ key: 'pc', label: 'This PC', note: 'Claude Code in ~/.claude', set: local.installed });
  }
  for (const distro of wslDistros()) {
    places.push({ key: `wsl:${distro}`, label: `WSL: ${distro}`, note: 'Runs this PC’s copy of the mod', set: settings.get('claudeModWsl')?.[distro] === true });
  }
  for (const h of sshHosts()) {
    places.push({ key: `ssh:${h.key}`, label: `SSH: ${h.name}`, note: h.mod ? 'One of the Claude app’s SSH connections' : 'Connecting…', set: h.mod?.enabled === true });
  }
  return places;
}

// The usage step's button: the mod on each of `keys` (usagePlaces), one after another; what
// failed says why next to its place.
async function setUpUsage(keys) {
  if (modBusy) return;
  usageSetupErrors = {};
  modBusy = 'Setting up';
  gettingStarted?.send();
  try {
    for (const key of keys) {
      try {
        if (key === 'pc') await setLocal(true);
        else if (key.startsWith('wsl:')) await setWsl(key.slice('wsl:'.length), true);
        else if (key.startsWith('ssh:')) {
          const h = sshHosts().find((x) => `ssh:${x.key}` === key);
          if (h) await setSsh(h, true);
        }
      } catch (err) {
        log('mod:', err.message);
        usageSetupErrors = { ...usageSetupErrors, [key]: String(err.message).split('\n')[0].slice(0, 80) };
      }
    }
  } finally {
    modBusy = null;
  }
}

// A practice session's menu, as a real one's: either item settles it, and it goes.
function practiceRowMenu(id) {
  return Menu.buildFromTemplate([
    { label: 'Mark as done', click: () => gettingStarted?.remove(id) },
    { label: 'Hide from the sidebar', click: () => gettingStarted?.remove(id) },
  ]);
}

function codexInstalled() {
  return fs.existsSync(codexPaths().home);
}

// The Claude desktop app's own folder. Someone who uses only Codex, or only the claude CLI,
// has none, and gets no menu items for the app.
function claudeInstalled() {
  return fs.existsSync(path.join(app.getPath('appData'), 'Claude'));
}

// Paseo, installed per user. With it, clicking the pet opens Paseo (openPaseo) instead of the
// app mainAppLink names.
function paseoExe() {
  const local = process.env.LOCALAPPDATA;
  return local ? path.join(local, 'Programs', 'Paseo', 'Paseo.exe') : null;
}

function paseoInstalled() {
  const exe = paseoExe();
  return process.platform === 'win32' && !!exe && fs.existsSync(exe);
}

// What clicking the pet opens without Paseo: Claude, like ChatGPT's pet opens its app, or Codex
// for someone who has only Codex.
function mainAppLink() {
  if (claudeInstalled()) return APP_LINK.claude;
  return codexInstalled() ? APP_LINK.codex : null;
}

function startCodex() {
  if (codex || DEMO || !settings.get('showCodex') || !codexInstalled()) return;
  codex = new CodexTracker({
    ...codexPaths(),
    watchHosts: settings.get('codexOverSsh'),
    dismissed: settings.get('dismissed') || {},
    readyFrom: readyFrom(),
    cliReadyFrom: cliReadyFrom(),
  });
  codex.setChatRoots(wslRoots('.codex\\sessions'));
  codex.on('change', (list) => {
    codexSessions = list;
    mergeSessions();
  });
  codex.on('list', (list) => {
    codexAll = list;
    sendTree();
  });
  codex.on('usage', setUsage);
  codex.on('error', (err) => log('codex tracker error:', err?.message || err));
  codex.start();
}

function stopCodex() {
  codex?.stop();
  codex = null;
  codexSessions = [];
  codexAll = [];
  mergeSessions();
  sendTree();
  setUsage({ codex: null });
}

function startEtl() {
  etl = new EtlFeature({
    electron: { app, dialog, powerMonitor, safeStorage, shell },
    settings,
    appRoot: APP_ROOT,
    log,
    codexInstalled,
    codexSessionsRoot: codexPaths().sessionsRoot,
  });
  etl.on('change', (list) => {
    etlSessions = list;
    mergeSessions();
  });
  etl.start();
}

function startSlack() {
  slack = new SlackFeature({ electron: { app, powerMonitor, safeStorage }, settings, log });
  slack.on('change', (list) => {
    slackSessions = list;
    mergeSessions();
  });
  slack.start();
}

// `--todomate-clock=HH:MM`, for trying the TodoMate bubbles: their clock starts at that time today
// (KST) and runs on from there. A restart from the tray menu goes back to the real time.
function todomateClock() {
  const m = /^--todomate-clock=([01]?\d|2[0-3]):([0-5]\d)$/.exec(process.argv.find((a) => a.startsWith('--todomate-clock=')) || '');
  if (!m) return Date.now;
  const today = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
  const offset = Date.parse(`${today}T${m[1].padStart(2, '0')}:${m[2]}:00+09:00`) - Date.now();
  log(`todomate: clock set to ${m[1]}:${m[2]} KST`);
  return () => Date.now() + offset;
}

function startTodomate() {
  todomate = new TodomateFeature({ electron: { app, clipboard, dialog, powerMonitor, safeStorage, shell }, settings, log, now: todomateClock() });
  todomate.on('change', (list) => {
    todomateSessions = list;
    mergeSessions();
  });
  todomate.start();
}

function startWebChats() {
  webchats = new WebChatsFeature({
    electron: { dialog, shell },
    settings,
    appRoot: APP_ROOT,
    userData: app.getPath('userData'),
    exe: process.execPath,
    log,
  });
  webchats.on('change', (list) => {
    webSessions = list;
    mergeSessions();
  });
  webchats.on('list', (list) => {
    webAll = list;
    sendTree();
  });
  webchats.start().catch((err) => log('web chats:', err.message));
}

function startPhone() {
  phone = new PhoneFeature({
    electron: { dialog, shell, clipboard },
    settings,
    userData: app.getPath('userData'),
    log,
    snapshot: phoneSnapshot,
    sampleNotice: sampleEtlNotice,
    icon: appIcon,
  });
  phone.on('setup', () => gettingStarted?.send());   // Getting started's Phone step draws again
  phone.start()
    .then(() => {
      phone.changed();
      phone.observe(sessions, currentHidden());
    })
    .catch((err) => log('phone:', err.message));
}

// What the phone page shows: the sidebar's tree, eTL's, Slack's and TodoMate's notices and the weekly limits. A Claude
// session opens at its Remote Control session: the one its running process is connected to, else
// the one the desktop app connected it to last (an SSH session's process runs on the host).
function phoneSnapshot() {
  const links = new Map(webAll.map((c) => [c.id, c.url]));
  const live = currentBridges();
  for (const s of claudeAll) {
    const bridge = live.get(s.kind === 'cli' ? s.sessionId : s.hostSessionId) ?? s.bridgeSessionId;
    if (bridge) links.set(s.id, `https://claude.ai/code/${bridge}`);
  }
  return {
    hosts: currentTree(),
    notices: currentNotices(),
    usage: settings.get('showUsage') ? currentUsage() : [],
    linkOf: (id) => links.get(id) ?? null,
  };
}

// liveBridges (sessions.js), read again at most every few seconds.
let bridges = { at: 0, map: new Map() };
function currentBridges() {
  if (Date.now() - bridges.at > 5000) bridges = { at: Date.now(), map: liveBridges() };
  return bridges.map;
}

// What the phone's sample eTL notice links to: the next assignment due that isn't handed in (any
// assignment eTL listed, else eTL's front page), so a tap shows where LearningX lands.
function sampleEtlNotice() {
  const now = Date.now();
  const recs = Object.values(etl?.tracker?.watch?.assignments || {}).filter((r) => ETL_LINK.test(r?.url || ''));
  const next = recs.filter((r) => r.due > now && !r.submitted).sort((a, b) => a.due - b.due)[0] || recs[0];
  if (!next) return { title: 'eTL', project: '', url: 'https://myetl.snu.ac.kr/' };
  return { title: String(next.name || 'eTL'), project: typeof next.course === 'string' ? next.course : '', url: next.url };
}

// The app icon as a square PNG of `size` pixels, for the phone's Home Screen.
const appIcons = new Map();
function appIcon(size) {
  if (!appIcons.has(size)) {
    const img = nativeImage.createFromPath(path.join(APP_ROOT, 'assets', 'icon.png'));
    appIcons.set(size, img.isEmpty() ? null : img.resize({ width: size, height: size, quality: 'best' }).toPNG());
  }
  return appIcons.get(size);
}

function trackerFor(id) {
  if (String(id).startsWith('etl:')) return etl;
  if (String(id).startsWith('slack:')) return slack;
  if (String(id).startsWith('todomate:')) return todomate;
  if (String(id).startsWith('web:')) return webchats;
  return String(id).startsWith('codex:') ? codex : tracker;
}

// ---------------------------------------------------------------- weekly limits

function setUsage(patch) {
  Object.assign(usage, patch);
  sendUsage();
}

function currentUsage() {
  return [...usageView({ claude: combineClaudeUsage(usage.claude), codex: codexAccounts?.count ? null : usage.codex }), ...(codexAccounts?.meter() || [])];
}

// Also runs every minute: a week can turn over, and figures can get old, with no news.
function sendUsage(force = false) {
  const items = settings.get('showUsage') ? currentUsage() : [];
  const key = JSON.stringify(items);
  if (key === usageKey && force !== true) return;
  usageKey = key;
  if (win && !win.isDestroyed()) win.webContents.send('pet:usage', items);
  folder?.send('folder:usage', items);
  phone?.changed();
}

// "Claude: 42% of the weekly limit used · 55% into the week · resets in 3d 4h · as of 2h ago"
function usageLabel(u) {
  return [
    `${u.name}: ${u.percent}% of the weekly limit used`,
    u.elapsed != null && `${u.elapsed}% into the week`,
    u.resetsIn && `resets in ${u.resetsIn}`,
    u.age && `as of ${u.age} ago`,
  ].filter(Boolean).join(' · ');
}

// ---------------------------------------------------------------- live Claude usage (see claude-mod.js)

const LIVE_USAGE_DOC = 'https://github.com/hyukjunlim/ttokttok-pet#live-claude-usage';
const WSL_CHECK_MS = 5 * 60_000;

// The WSL distros Claude Code is known to be in: those the desktop app has run sessions in, and
// those checkWsl found it in, or the mod set up.
function wslDistros() {
  if (process.platform !== 'win32') return [];
  const ticked = (map) => Object.keys(map || {}).filter((d) => map[d]);
  const all = [...(tracker?.wslDistros?.() ?? []), ...ticked(settings.get('claudeCodeWsl')), ...ticked(settings.get('claudeModWsl'))];
  return [...new Set(all)].sort();
}

// The SSH hosts the pet reads: the desktop app's connections, then the ones picked from ~/.ssh/config.
function sshHosts() {
  return settings.get('claudeUsageOverSsh') ? claudeUsage?.hostStates() ?? [] : [];
}

// The hosts in ~/.ssh/config that could still be picked: not yet picked, nor the desktop app's.
function otherSshHosts() {
  if (!settings.get('claudeUsageOverSsh')) return [];
  const listed = sshHosts();
  return sshConfigHosts().filter((c) => !listed.some((h) => (h.fromConfig ? h.target === c.alias : isSameHost(c, h.target, h.port))));
}

// Whether there's anywhere to set the mod up: Claude Code on this PC or in WSL, or SSH hosts.
function liveUsageWanted() {
  return localMod.hasClaudeCode() || localMod.status().version != null || wslDistros().length > 0
    || settings.get('claudeSshHosts').length > 0 || sshConfigHosts().length > 0;
}

// Whether the mod is set up anywhere: this PC, a WSL distro, or an SSH host the pet reads.
function modSetUpAnywhere() {
  return localMod.status().installed || Object.values(settings.get('claudeModWsl') || {}).some(Boolean)
    || sshHosts().some((h) => h.mod?.enabled);
}

function rememberWsl(distro, on) {
  settings.set({ claudeModWsl: { ...settings.get('claudeModWsl'), [distro]: on } });
}

// WSL runs this PC's copy of the mod, through /mnt/c, so setting it up in WSL sets it up here too.
// Without Claude Code on this PC, the copy is all it gets, and it goes when no distro uses it.
async function setWsl(distro, on) {
  if (on && !localMod.status().installed) {
    if (localMod.hasClaudeCode()) localMod.install();
    else localMod.update();
  }
  const r = await wslInstaller(distro, { action: on ? 'install' : 'uninstall', windowsDir: localMod.dir });
  if (!r.ok) throw new Error(`WSL ${distro}: ${r.error}`);
  rememberWsl(distro, r.enabled);
  log(`mod ${on ? 'set up' : 'removed'} in WSL ${distro}`);
  if (!on && !localMod.status().installed && !Object.values(settings.get('claudeModWsl')).some(Boolean)) localMod.uninstall();
}

async function setSsh(host, on) {
  const r = await sshInstaller(host, on ? { action: 'install', files: modFiles() } : { action: 'uninstall' });
  if (!r.ok) throw new Error(`${host.name}: ${r.error}`);
  log(`mod ${on ? 'set up' : 'removed'} on ${host.name}`);
}

function setConfigHosts(aliases) {
  settings.set({ claudeSshHosts: aliases });
  claudeUsage?.setConfigHosts(aliases);
}

// A host from ~/.ssh/config: the mod is set up there, and the pet reads it from then on.
async function pickSshHost(alias) {
  await setSsh({ name: alias, target: alias, port: null, identity: null }, true);
  setConfigHosts([...settings.get('claudeSshHosts').filter((a) => a !== alias), alias]);
}

// The pet stops reading it first, so a host that can't be reached can still be dropped.
async function dropSshHost(h) {
  setConfigHosts(settings.get('claudeSshHosts').filter((a) => a !== h.target));
  await setSsh(h, false);
}

// This PC, and the WSL distros running its copy.
async function setLocal(on) {
  if (on) {
    localMod.install();
    log('mod set up on this PC');
    return;
  }
  const failures = [];
  for (const distro of wslDistros().filter((d) => settings.get('claudeModWsl')?.[d])) {
    try {
      await setWsl(distro, false);
    } catch (err) {
      failures.push(err.message);
    }
  }
  localMod.uninstall();
  log('mod removed from this PC');
  if (failures.length) throw new Error(failures.join('\n'));
}

async function runModTask(label, task) {
  if (modBusy) return;
  modBusy = label;
  try {
    await task();
  } catch (err) {
    log('mod:', err.message);
    await dialog.showMessageBox({
      type: 'warning', title: 'Ttokttok Pet', message: "Couldn't change Ttokttok Pet's mod for Claude Code.", detail: err.message,
    });
  } finally {
    modBusy = null;
  }
}

function liveUsageMenu() {
  const local = localMod.status();
  const busy = Boolean(modBusy);
  const toggle = (set) => (mi) => runModTask(mi.checked ? 'Setting up' : 'Removing', () => set(mi.checked));
  const items = [
    { label: busy ? `${modBusy}…` : 'Saves your usage after each reply, in sessions started after setup', enabled: false },
    { type: 'separator' },
  ];
  if (localMod.hasClaudeCode() || local.installed) {
    items.push({ label: 'This PC', type: 'checkbox', checked: local.installed, enabled: !busy, click: toggle(setLocal) });
  }
  for (const distro of wslDistros()) {
    items.push({
      label: `WSL: ${distro}`,
      type: 'checkbox',
      checked: settings.get('claudeModWsl')?.[distro] === true,
      enabled: !busy,
      click: toggle((on) => setWsl(distro, on)),
    });
  }
  for (const h of sshHosts()) {
    items.push({
      label: `SSH: ${h.name}${h.mod ? '' : ' (connecting…)'}`,
      type: 'checkbox',
      // one picked from ~/.ssh/config stays ticked until you untick it, even while it can't be reached
      checked: h.fromConfig ? h.mod?.enabled !== false : h.mod?.enabled === true,
      enabled: !busy && (h.fromConfig || Boolean(h.mod)),
      click: toggle((on) => (h.fromConfig && !on ? dropSshHost(h) : setSsh(h, on))),
    });
  }
  const others = otherSshHosts();
  if (others.length) {
    items.push({
      label: 'More SSH hosts (~/.ssh/config)',
      enabled: !busy,
      submenu: others.map((c) => ({ label: c.alias, click: () => runModTask('Setting up', () => pickSshHost(c.alias)) })),
    });
  }
  items.push({ type: 'separator' });
  items.push({
    label: 'Read usage on SSH hosts',
    type: 'checkbox',
    checked: settings.get('claudeUsageOverSsh'),
    click: (mi) => {
      settings.set({ claudeUsageOverSsh: mi.checked });
      claudeUsage?.setWatchHosts(mi.checked);
    },
  });
  items.push({ label: 'How it works…', click: () => shell.openExternal(LIVE_USAGE_DOC) });
  return { label: `Live Claude usage${modSetUpAnywhere() ? '' : ' (off)'}`, submenu: items };
}

// Asked once (a new install, or the first start after the pet gained the mod), as soon as Claude
// Code turns up on this PC or in WSL.
async function offerLiveUsage() {
  if (DEMO || modBusy || settings.get('claudeModOffered') || modSetUpAnywhere()) return;
  if (gettingStarted?.isOpen) return;   // its Claude usage step asks; see startGettingStarted's closed
  const here = localMod.hasClaudeCode();
  const distros = wslDistros();
  const hosts = sshHosts().filter((h) => !h.fromConfig);
  if (!here && !distros.length) return;
  const elsewhere = [...distros.map((d) => `WSL (${d})`), ...hosts.map((h) => h.name)];
  settings.set({ claudeModOffered: true });   // before the dialog: checkWsl may call again while it's up
  const answer = await dialog.showMessageBox({
    type: 'question',
    title: 'Ttokttok Pet',
    message: "Show Claude's weekly limit?",
    detail: [
      "Ttokttok Pet reads Claude's usage from a small mod for Claude Code, which saves your plan's",
      "usage after each reply, as Claude reports it: how much of the weekly limit you've used,",
      'and when the week resets.',
      '',
      'It puts the mod in ~/.ttokttok-pet and adds two entries to the "env" of ~/.claude/settings.json',
      `${here ? '' : `in ${elsewhere.join(', ')} `}(a backup is kept). Sessions you start from now on use it.`,
      '',
      'Tray menu → Sources → Live Claude usage changes this later.',
    ].join('\n'),
    buttons: ['Set it up', 'Not now'],
    defaultId: 0,
    cancelId: 1,
    ...(here && elsewhere.length ? { checkboxLabel: `Also in ${elsewhere.join(', ')}`, checkboxChecked: true } : {}),
  });
  if (answer.response !== 0) return;
  await runModTask('Setting up', async () => {
    if (here) {
      await setLocal(true);
      if (!answer.checkboxChecked) return;
    }
    const failures = [];
    for (const distro of distros) await setWsl(distro, true).catch((err) => failures.push(err.message));
    for (const h of hosts) await setSsh(h, true).catch((err) => failures.push(err.message));
    if (failures.length) throw new Error(`${here ? 'Set up on this PC, but not' : 'Not set up'} on:\n${failures.join('\n')}`);
  });
}

// A one-time, optional invitation to connect SNU eTL. The tray menu remains available if they
// skip, and setEnabled() reuses the normal token registration and verification flow.
async function offerEtlConnection() {
  if (DEMO || !etl || settings.get('etlOnboardingOffered')) return;
  if (etl.enabled) {
    settings.set({ etlOnboardingOffered: true });
    return;
  }

  const answer = await dialog.showMessageBox({
    type: 'question',
    title: 'Ttokttok Pet',
    message: 'eTL에 연결할까요?',
    detail: [
      '서울대 eTL을 쓰는 경우 과제 마감과 공지를 펫 알림으로 받을 수 있습니다.',
      '연결을 누르면 토큰 입력 창이 열립니다. eTL의 계정 → 설정 → 새 액세스 토큰에서 발급해 붙여 넣으면 됩니다.',
      '토큰은 이 컴퓨터에 암호화해 저장됩니다.',
      '지금 건너뛰어도 트레이 메뉴의 Sources → eTL에서 언제든 연결할 수 있습니다.',
    ].join('\n'),
    buttons: ['eTL 연결', '나중에'],
    defaultId: 1,
    cancelId: 1,
  });
  settings.set({ etlOnboardingOffered: true });
  if (answer.response === 0) await etl.setEnabled(true);
}

// After the pet itself updates: the copies of the mod it set up get its newer version. WSL runs
// this PC's copy, which can be there without this PC's settings loading it.
function updateLocalMod() {
  const st = localMod.status();
  if (!st.version || st.version === bundledVersion()) return;
  try {
    localMod.update();
    log(`mod updated on this PC (${st.version} → ${bundledVersion()})`);
  } catch (err) {
    log('mod update on this PC failed:', err.message);
  }
}

function updateHostMods() {
  for (const h of sshHosts()) {
    if (!h.mod?.enabled || !h.mod.version || h.mod.version === bundledVersion() || modUpdated.has(h.key)) continue;
    modUpdated.add(h.key);
    sshInstaller(h, { action: 'update', files: modFiles() }).then((r) => {
      log(r.ok ? `mod updated on ${h.name} (${h.mod.version} → ${bundledVersion()})` : `mod update on ${h.name} failed: ${r.error}`);
    });
  }
}

// Asks each running WSL distro, once a run, whether Claude Code is there and whether the mod is
// set up. Distros that aren't running are left alone (asking would start them), so one you start
// Claude Code in is asked the next time this runs. Resolves whether Claude Code turned up in one.
async function checkWsl() {
  if (process.platform !== 'win32') return false;
  const running = await runningWslDistros();
  let found = false;
  for (const distro of [...running].filter((d) => !wslAsked.has(d))) {
    wslAsked.add(distro);
    const r = await wslInstaller(distro, { action: 'status', windowsDir: localMod.dir });
    if (!r.ok) continue;
    await moveWsl(distro, r.legacy === true);
    rememberWsl(distro, r.enabled);
    const had = settings.get('claudeCodeWsl')?.[distro] === true;
    if (r.claude === had) continue;
    settings.set({ claudeCodeWsl: { ...settings.get('claudeCodeWsl'), [distro]: r.claude === true } });
    found ||= r.claude === true;
  }
  return found;
}

// WSL's VS Code and terminal sessions: the trackers read each distro's ~/.claude/projects and
// ~/.codex/sessions from here (\\wsl.localhost\…), but only while the distro runs, which this
// checks every 15 s. Reading a stopped distro's files would start it, and with the pet reading
// every second it would never stop again (SessionTracker.setCliRoots, CodexTracker.setChatRoots).
const WSL_CHATS_MS = 15_000;

async function syncWslChats() {
  if (process.platform !== 'win32' || DEMO) return;
  const running = await runningWslDistros();
  for (const distro of running) {
    if (wslHomes.has(distro)) continue;
    const home = await wslHome(distro);
    if (home) wslHomes.set(distro, home);
  }
  wslRunning = running;
  const key = JSON.stringify(wslRoots(''));
  if (key === wslChatsKey) return;
  wslChatsKey = key;
  tracker?.setCliRoots?.(wslRoots('.claude\\projects'));
  codex?.setChatRoots(wslRoots('.codex\\sessions'));
}

// `folder` (Windows-style) in the home folder of each WSL distro seen running, and whether it runs.
function wslRoots(folder) {
  return [...wslHomes].map(([distro, home]) => ({
    root: `\\\\wsl.localhost\\${distro}${home.replace(/\//g, '\\')}\\${folder}`,
    machineKey: `wsl:${distro}`,
    machine: distro,
    active: wslRunning.has(distro),
  }));
}

// A running distro's home folder, e.g. /home/me; null if it won't say.
function wslHome(distro) {
  return new Promise((resolve) => {
    execFile('wsl.exe', ['-d', distro, '-e', 'sh', '-c', 'printf %s "$HOME"'], { windowsHide: true, timeout: 10_000 }, (err, stdout) => {
      const home = String(stdout || '').trim();
      resolve(!err && /^\/[^\\]*$/.test(home) ? home.replace(/\/+$/, '') : null);
    });
  });
}

function trayTooltip() {
  if (!sessions.length) return 'Ttokttok Pet: all quiet';
  const top = sessions[0];
  return `Ttokttok Pet: ${top.badge || STATUS_LABEL[top.status]} · ${top.title}`.slice(0, 120);
}

// Claude's claude://code/continue?session=… links sit behind a server-side flag and quietly
// do nothing on some accounts. claude://resume is always on: given the id part of an existing
// desktop session (local_<uuid>), it opens that session as-is, SSH sessions included. Only
// sessions that are still in the desktop index get a link, so resume never imports a copy.
function sessionUrl(s) {
  // codex://threads/<id>?hostId=…, or the VS Code extension's vscode://openai.chatgpt/local/<id>
  if (s?.kind === 'codex') return s.url || null;
  if (s?.kind === 'etl' && s.assistant) return etl?.assistantLinks().at(-1) || null;   // the eTL chat
  if (s?.kind === 'etl') return ETL_LINK.test(s.url || '') ? s.url : null;
  if (s?.kind === 'slack') return SLACK_LINK.test(s.url || '') ? s.url : null;
  if (s?.kind === 'web') {
    const url = webchats?.target(s.id)?.url || '';
    return WEB_LINK.test(url) ? url : null;
  }
  // Claude Code in VS Code opens its session itself, in the window that runs it (a WSL or SSH
  // window for a session there); a terminal session has nothing to open.
  if (s?.kind === 'cli') {
    return s.client === 'vscode' && CLI_SESSION_RE.test(s.sessionId || '') ? `vscode://anthropic.claude-code/open?session=${s.sessionId}` : null;
  }
  const m = DESKTOP_SESSION_RE.exec(s?.hostSessionId || '');
  if (!m || !tracker.desktop?.has(s.hostSessionId)) return null;
  return `claude://resume?session=${m[1]}`;
}

// Launching any claude:// link makes the running app restore and focus its main window;
// claude://hotkey does nothing else (codex:// links work the same way for Codex, and
// codex://launch does nothing else). On Windows an app may only bring another app forward
// if it's the one in front, and the pet window never takes focus. So a click first focuses
// a tiny invisible helper window, then launches the link, and hides the helper once Claude
// has taken over. (Toggling the pet window's own focusability doesn't work: Electron then
// deactivates it, which hands focus to whatever window sits under the pet.)
let handoffWin = null;
let handoffTimer = null;

function focusHandoffWindow() {
  if (!handoffWin || handoffWin.isDestroyed()) {
    handoffWin = new BrowserWindow({
      width: 1,
      height: 1,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      resizable: false,
      skipTaskbar: true,
      show: false,
      title: 'Ttokttok Pet focus helper',
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
  }
  const { width, height } = petSize();
  handoffWin.setBounds({ x: Math.round(petPos.x + width / 2), y: Math.round(petPos.y + height / 2), width: 1, height: 1 });
  handoffWin.showInactive();
  handoffWin.focus();
}

function handOffFocus() {
  if (process.platform !== 'win32') return;
  clearTimeout(handoffTimer);
  focusHandoffWindow();
  handoffTimer = setTimeout(() => {
    if (!handoffWin || handoffWin.isDestroyed()) return;
    if (DEBUG_OPEN_AFTER_MS) log(`debug: hiding focus helper (focused=${handoffWin.isFocused()})`);
    handoffWin.hide();
  }, FOREGROUND_HANDOFF_MS);
}

// `handoff: false` for a click in folder mode's sidebar, which has the focus to hand on itself.
function openApp(url, { handoff = true } = {}) {
  if (handoff) handOffFocus();
  shell.openExternal(url).catch((err) => log(`could not open ${url.split(':')[0]}:`, err.message));
  if (url.startsWith('codex:')) raiseCodexWindow();   // a reopened Codex window stays behind otherwise
}

// Paseo's window that's open comes to the front (raise.js); with none, Paseo starts. Starting
// Paseo.exe while a window is open would open a second one, so it's only for "none" (false), not
// for "couldn't tell" (null). `fill`: folder mode keeps the app maximized beside the sidebar.
async function openPaseo({ handoff = true, fill = false } = {}) {
  if (handoff) handOffFocus();
  const raised = await raisePaseoWindow({ maximize: fill });
  if (raised !== false) return;
  try {
    const c = spawn(paseoExe(), [], { detached: true, stdio: 'ignore', windowsHide: false });
    c.on('error', (err) => log('could not start Paseo:', err.message));
    c.unref();
  } catch (err) {
    log('could not start Paseo:', err.message);
    return;
  }
  if (fill) maximizeApps('open', 'paseo');
}

// A web chat opens in the tab that shows it: the extension brings the tab forward in its window,
// and the pet brings that window to the front. With no such tab left, its address opens instead.
function openWebChat(s, { handoff = true } = {}) {
  const target = webchats?.target(s.id);
  if (target?.tab && webchats.focus(s.id)) {
    if (handoff) handOffFocus();
    raiseBrowserWindow({ hostPid: target.tab.hostPid, title: target.tab.rawTitle });
  } else {
    const url = sessionUrl(s);
    if (!url) return false;
    openApp(url, { handoff });
  }
  return true;
}

// A VS Code extension's link goes to the VS Code window you used last, and the extension there
// knows only its own machine's chats. So the window for the chat's machine comes to the front
// first (raise.js). With none open, that machine's folder opens in VS Code instead, and a second
// click, once it's connected, opens the chat.
async function openInVsCode(s, url, { handoff }) {
  if (handoff) handOffFocus();
  const where = vsCodePlace(s, { connections: codex?.connections ?? [], sshHosts: sshConfigHosts() });
  const raised = await raiseVsCodeWindow({ marks: where.marks });
  if (raised === false && where.folder) {
    log(`VS Code: no window for ${where.marks.join(' or ') || 'this PC'}; opening the folder there`);
    shell.openExternal(where.folder).catch((err) => log('could not open vscode:', err.message));
    return;
  }
  if (raised) await new Promise((resolve) => setTimeout(resolve, 300));   // VS Code notes which window is in front
  shell.openExternal(url).catch((err) => log('could not open vscode:', err.message));
}

// A bubble's session, or (from folder mode) any session in the full lists. `fill`: maximize the
// app beside the sidebar.
function openSession(id, { handoff = true, fill = false } = {}) {
  const s = [sessions, claudeAll, codexAll, webAll].reduce((found, list) => found ?? list.find((x) => x.id === id), null);
  const open = (url) => openApp(url, { handoff });
  if (s?.kind === 'etl' && s.assistant) return Boolean(etl?.openAssistant(open));   // the eTL chat
  if (s?.kind === 'web') return openWebChat(s, { handoff });
  if (s?.kind === 'todomate' && todomate?.open(id)) return true;   // its connection bubble
  if (s?.clearOnClick) {   // a D-X countdown (Slack's, TodoMate's): seen, so it goes until tomorrow
    trackerFor(s.id)?.dismiss(s.id);
    return true;
  }
  if (s?.kind === 'todomate') return true;   // a schedule item: nothing to open, only × closes it
  const url = s && sessionUrl(s);
  if (!url) return false;
  if (url.startsWith('vscode://')) openInVsCode(listedSession(id) ?? s, url, { handoff });
  else open(url);
  if (fill && (s.kind === 'desktop' || (s.kind === 'codex' && !s.client))) maximizeApps('open', s.kind === 'codex' ? 'codex' : 'claude');
  // Opening a session doesn't settle it: Ready, Error and Needs you stay until you mark it done
  // (its ×, or the sidebar's Mark as done) or send it a message. A one-off eTL notice is done with
  // once opened; a class bubble (`keepOnOpen`, etl/timetable.js) stays until the class ends or its
  // × is clicked. A Slack reminder stays until the next one takes over: it's about a day to come.
  if (s.kind === 'slack' && s.badge === '순서 변경') trackerFor(s.id)?.dismiss(s.id);
  if (s.kind === 'etl' && s.status !== 'running' && s.status !== 'background' && s.status !== 'idle' && !s.keepOnOpen) {
    trackerFor(s.id)?.dismiss(s.id);
    persistDismissed();
  }
  return true;
}

// From when on a look at a session no longer counts as done with it: set the first time this
// version runs, so what was settled before stays settled.
function readyFrom() {
  if (!settings.get('readyFrom')) settings.set({ readyFrom: Date.now() });
  return settings.get('readyFrom');
}

// The same for VS Code and terminal sessions, which were Ready for only a few minutes before.
function cliReadyFrom() {
  if (!settings.get('cliReadyFrom')) settings.set({ cliReadyFrom: Date.now() });
  return settings.get('cliReadyFrom');
}

function persistDismissed() {
  settings.set({ dismissed: { ...tracker.dismissedSnapshot(), ...codex?.dismissedSnapshot() } });
}

// ---------------------------------------------------------------- drag & throw

function stopMomentum() {
  clearTimeout(momentumTimer);
  momentumTimer = null;
}

function startMomentum(vx, vy) {
  stopMomentum();
  const started = Date.now();
  let last = started;
  const step = () => {
    if (!win || win.isDestroyed()) return;
    const now = Date.now();
    const dt = Math.min(Math.max(0, now - last), MOMENTUM_MAX_DT_MS);
    last = now;
    const next = { x: petPos.x + (vx * dt) / 1000, y: petPos.y + (vy * dt) / 1000 };
    const clamped = clampPet(next);
    if (clamped.x !== next.x) vx = -vx * BOUNCE;
    if (clamped.y !== next.y) vy = -vy * BOUNCE;
    petPos = clamped;
    placeWindow();
    const friction = FRICTION_PER_TICK ** (dt / MOMENTUM_TICK_MS);
    vx *= friction;
    vy *= friction;
    if (now - started >= MAX_MOMENTUM_MS || Math.hypot(vx, vy) < STOP_SPEED) {
      momentumTimer = null;
      win.webContents.send('pet:landed');
      finishMove();
      return;
    }
    momentumTimer = setTimeout(step, MOMENTUM_TICK_MS);
  };
  momentumTimer = setTimeout(step, MOMENTUM_TICK_MS);
}

function fromPet(event) {
  return win && !win.isDestroyed() && event.sender === win.webContents;
}

function registerIpc() {
  ipcMain.on('pet:ready', (e) => {
    if (!fromPet(e)) return;
    shape = null;                       // a page that has just loaded sends its own
    applyShape();
    sendPet();
    sendMotion();
    sendLayout();
    sendSessions();
    sendUsage(true);
  });
  ipcMain.on('pet:shape', (e, payload) => {
    if (!fromPet(e)) return;
    const next = cleanShape(payload);
    if (!next) return;
    shape = next;
    applyShape();
  });
  ipcMain.on('pet:drag-start', (e, p) => {
    if (!fromPet(e) || !isPoint(p)) return;
    stopMomentum();
    drag = { dx: p.screenX - petPos.x, dy: p.screenY - petPos.y };
  });
  ipcMain.on('pet:drag-move', (e, p) => {
    if (!fromPet(e) || !drag || !isPoint(p)) return;
    petPos = clampPet({ x: p.screenX - drag.dx, y: p.screenY - drag.dy });
    placeWindow();
  });
  ipcMain.on('pet:drag-end', (e, v) => {
    if (!fromPet(e) || !drag) return;
    drag = null;
    const vx = Number(v?.vx) || 0;
    const vy = Number(v?.vy) || 0;
    if (Math.hypot(vx, vy) >= MIN_THROW_SPEED) startMomentum(vx, vy);
    else {
      win.webContents.send('pet:landed');
      finishMove();
    }
  });
  ipcMain.on('pet:activate', (e, id) => {
    if (!fromPet(e)) return;
    if (gettingStarted?.isPractice(id)) {   // the page has the pet wave; nothing to open
      gettingStarted.tried('click');
      return;
    }
    if (typeof id === 'string') {
      if (!openSession(id)) wake();     // terminal sessions have nothing to open
      return;
    }
    if (paseoInstalled()) {             // clicking the pet opens Paseo when it's installed
      openPaseo();
      return;
    }
    const url = mainAppLink();          // otherwise Claude, like ChatGPT's pet
    if (url) openApp(url);
    else wake();
  });
  ipcMain.on('pet:dismiss', (e, id) => {
    if (!fromPet(e) || typeof id !== 'string') return;
    if (gettingStarted?.isPractice(id)) {
      gettingStarted.tried('dismiss');
      gettingStarted.remove(id);
      return;
    }
    trackerFor(id)?.dismiss(id);
    persistDismissed();
  });
  ipcMain.on('pet:tray-size', (e, h) => {
    if (!fromPet(e) || !Number.isFinite(h)) return;
    const next = Math.max(TRAY_HEIGHT, Math.min(10_000, Math.ceil(h)));
    if (next === trayHeight) return;
    trayHeight = next;
    if (!drag && !momentumTimer) placeWindow();
  });
  ipcMain.on('pet:context-menu', (e, p) => {
    if (!fromPet(e)) return;
    const position = isPoint(p) ? { x: Math.round(p.screenX), y: Math.round(p.screenY) } : undefined;
    gettingStarted?.tried('menu');
    tray?.popUpContextMenu(buildMenu(), position);
  });

  // Folder mode's sidebar.
  const fromFolder = (event) => Boolean(folder?.owns(event.sender));
  // The sidebar's folding, folder order and text size, kept in settings.json. The page asks as it
  // starts, before it draws the tree.
  ipcMain.on('folder:prefs', (e) => {
    e.returnValue = fromFolder(e)
      ? {
        fold: settings.get('folderFold') || {}, order: settings.get('folderOrder') || {}, zoom: settings.get('folderZoom') ?? null,
        edge: folder.edge,   // the page puts its drag edge and border on the inner side
      }
      : null;
  });
  ipcMain.on('folder:save-prefs', (e, p) => {
    if (!fromFolder(e) || !p || typeof p !== 'object') return;
    const patch = {};
    if (isMapOf(p.fold, (v) => typeof v === 'boolean')) patch.folderFold = p.fold;
    if (isMapOf(p.order, (v) => Array.isArray(v) && v.every((k) => typeof k === 'string'))) patch.folderOrder = p.order;
    if (Number.isFinite(p.zoom) && p.zoom >= 0.5 && p.zoom <= 3) patch.folderZoom = p.zoom;
    if (Object.keys(patch).length) settings.set(patch);
  });
  ipcMain.on('folder:ready', (e) => {
    if (!fromFolder(e)) return;
    treeKey = '';
    sendTree();
    sendPet();
    sendMotion();
    sendSessions();
    sendUsage(true);
  });
  // A click in the sidebar has the focus to hand on; Ctrl+Tab (`via` 'key') comes while Claude
  // or Codex is in front, so the pet takes the focus first, as a click on the floating pet does.
  ipcMain.on('folder:open', (e, id, via) => {
    if (!fromFolder(e) || typeof id !== 'string') return;
    if (gettingStarted?.isPractice(id)) {   // Ctrl+Tab counts where it's pressed (onStep)
      if (via !== 'key') gettingStarted.tried('click');
      return;
    }
    if (!openSession(id, { handoff: via === 'key', fill: true })) log('folder: nothing to open for', id);
  });
  // A folder's +: the apps that can start a chat there, as a menu where it was clicked.
  ipcMain.on('folder:new-chat', (e, p) => {
    if (!fromFolder(e) || typeof p?.key !== 'string') return;
    const items = newChatItems(p.key);
    if (!items.length) return;
    const position = isPoint(p) ? { x: Math.round(p.screenX), y: Math.round(p.screenY) } : undefined;
    tray?.popUpContextMenu(Menu.buildFromTemplate(items), position);
  });
  ipcMain.on('folder:pet-click', (e) => {
    if (!fromFolder(e)) return;
    if (paseoInstalled()) {
      openPaseo({ handoff: false, fill: true });
      return;
    }
    const url = mainAppLink();
    if (!url) return;
    openApp(url, { handoff: false });
    maximizeApps('open', url === APP_LINK.codex ? 'codex' : 'claude');
  });
  // Dragging the sidebar's edge: the window follows the cursor, and the drop docks it at the new
  // width; a double-click goes back to the default.
  ipcMain.on('folder:resize', (e, phase) => {
    if (!fromFolder(e)) return;
    if (phase === 'reset') settings.set({ folderWidth: folder.setWidth(DEFAULTS.folderWidth) });
    else if (phase === 'end') settings.set({ folderWidth: folder.setWidth(folder.widthAtCursor()) });
    else if (phase === 'move') folder.preview(folder.widthAtCursor());
  });
  ipcMain.on('folder:context-menu', (e, p) => {
    if (!fromFolder(e)) return;
    const position = isPoint(p) ? { x: Math.round(p.screenX), y: Math.round(p.screenY) } : undefined;
    const target = p?.target;
    if (target?.kind === 'session' && gettingStarted?.isPractice(target.id)) {
      gettingStarted.tried('rowMenu');
      tray?.popUpContextMenu(practiceRowMenu(target.id), position);
      return;
    }
    const menu = rowMenu(target);
    if (!menu) gettingStarted?.tried('menu');
    tray?.popUpContextMenu(menu ?? buildMenu({ markAll: true }), position);
  });
}

// Light or dark, for every page of the pet's (the sidebar, the bubbles, the eTL window). The
// pages' own CSS goes by prefers-color-scheme, which follows this.
const THEMES = [
  { label: 'System (Windows app mode)', value: 'system' },
  { label: 'Light', value: 'light' },
  { label: 'Dark', value: 'dark' },
];

function themeOf() {
  const theme = settings.get('theme');
  return THEMES.some((t) => t.value === theme) ? theme : 'system';
}

function applyTheme() {
  nativeTheme.themeSource = themeOf();
}

// A plain object whose values all pass `ok`.
function isMapOf(value, ok) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Object.values(value).every(ok);
}

function isPoint(p) {
  return p && Number.isFinite(p.screenX) && Number.isFinite(p.screenY);
}

// ---------------------------------------------------------------- tray

function loginItemOptions() {
  return app.isPackaged ? {} : { path: process.execPath, args: ROOT_ARGS };
}

// `--start-at-login` / `--no-start-at-login` set the same option as the tray menu's checkbox.
function applyLoginFlag(argv) {
  const on = argv.includes('--start-at-login');
  const off = argv.includes('--no-start-at-login');
  if (!on && !off) return;
  app.setLoginItemSettings({ ...loginItemOptions(), openAtLogin: on });
  log(`start at login: ${app.getLoginItemSettings(loginItemOptions()).openAtLogin ? 'on' : 'off'}`);
}

// `--mode=pet` / `--mode=folder` switch the mode, as the tray menu does (also when the pet is
// already running: starting it again hands the flag over). Returns whether there was one.
function applyModeFlag(argv) {
  const flag = argv.find((a) => a.startsWith('--mode='));
  if (!flag) return false;
  if (settings.get('mode') === flag.slice('--mode='.length)) setVisible(true);
  else setMode(flag.slice('--mode='.length));
  return true;
}

// `markAll`: for a right-click on the sidebar's empty space, which has Mark all as done.
function buildMenu({ markAll = false } = {}) {
  const items = [];
  const folderMode = settings.get('mode') === 'folder';
  // The sessions themselves are in the bubbles and the sidebar. The weekly limits in words are
  // in the sidebar meter's hover text; the floating pet's meter has none, so they're here.
  if (!folderMode) for (const u of currentUsage()) items.push({ label: usageLabel(u), enabled: false });
  if (items.length) items.push({ type: 'separator' });
  items.push({
    label: folderMode ? 'Show sidebar' : 'Show pet',
    type: 'checkbox',
    checked: settings.get('visible'),
    accelerator: settings.get('shortcut'),
    click: (mi) => setVisible(mi.checked),
  });
  items.push({
    label: 'Mode',
    submenu: [
      { label: 'Floating pet', type: 'radio', checked: !folderMode, click: () => setMode('pet') },
      { label: 'Folder sidebar (every session, by machine and folder)', type: 'radio', checked: folderMode, click: () => setMode('folder') },
    ],
  });
  // The sessions you hid from the sidebar, under their machine and folder, to bring back (one whose
  // session is gone isn't listed).
  if (folderMode) {
    if (markAll) items.push(markAllItem());
    const count = Object.keys(currentHidden()).filter((id) => listedSession(id) && !isDeleted(id)).length;
    if (count) {
      items.push({
        label: `Hidden from the sidebar (${count})`,
        submenu: [
          ...hiddenMenu(currentTree({ hiddenOnly: true }), (ids) => setHidden(ids, false)),
          { type: 'separator' },
          { label: 'Show them all', click: () => setHidden(null) },
        ],
      });
    }
  }
  items.push({ type: 'separator' }, appearanceMenu(folderMode));
  const sources = sourcesMenu();
  if (sources) items.push(sources);
  if (phone) items.push(phone.menu());
  if (codexAccounts) items.push(codexAccounts.menu());
  items.push({ type: 'separator' });
  items.push({
    label: 'Start at login',
    type: 'checkbox',
    checked: app.getLoginItemSettings(loginItemOptions()).openAtLogin,
    click: (mi) => app.setLoginItemSettings({ ...loginItemOptions(), openAtLogin: mi.checked }),
  });
  if (!DEMO) {
    items.push({
      label: updateLabel(),
      enabled: !updateBusy,
      click: () => (update ? offerUpdate() : checkUpdates()),
    });
  }
  if (gettingStarted) items.push({ label: 'Getting started…', click: () => gettingStarted.open() });
  items.push({ type: 'separator' });
  if (claudeInstalled()) items.push({ label: 'Open Claude', click: () => openApp(APP_LINK.claude) });
  if (codexInstalled()) items.push({ label: 'Open Codex', click: () => openApp(APP_LINK.codex) });
  items.push({ label: 'Restart Ttokttok Pet', click: restart });
  items.push({ label: 'Quit Ttokttok Pet', click: () => app.quit() });
  return Menu.buildFromTemplate(items);
}

// How the pet looks. The bubbles and the position are the floating pet's, so folder mode leaves
// them out; there, Size is the pet's at the foot of the sidebar.
function appearanceMenu(folderMode) {
  const items = [];
  items.push({
    label: 'Pet',
    submenu: [
      ...pets.map((p) => ({
        label: `${p.displayName}${p.source === 'codex' ? '  (from Codex)' : ''}${p.version === 1 ? '  (v1)' : ''}`,
        type: 'radio',
        checked: p.key === currentPet?.key,
        click: () => selectPet(p.key),
      })),
      { type: 'separator' },
      { label: 'Open my pets folder', click: openPetsFolder },
      { label: 'Reload pets', click: () => { loadPets(); selectPet(currentPet?.key); } },
    ],
  });
  const sizeKey = folderMode ? 'folderPetScale' : 'scale';
  items.push({
    label: 'Size',
    submenu: SCALES.map((s) => ({
      label: s.label,
      type: 'radio',
      checked: settings.get(sizeKey) === s.value,
      click: () => {
        if (folderMode) {
          settings.set({ folderPetScale: s.value });
          sendPet();
        } else {
          resizeInPlace(() => settings.set({ scale: s.value }));
        }
      },
    })),
  });
  items.push({
    label: 'Theme',
    submenu: THEMES.map((t) => ({
      label: t.label,
      type: 'radio',
      checked: themeOf() === t.value,
      click: () => {
        settings.set({ theme: t.value });
        applyTheme();
      },
    })),
  });
  // Which monitor the sidebar docks on, and which of its edges.
  if (folderMode) {
    const on = folderDisplay().id;
    const edge = settings.get('folderEdge');
    items.push({
      label: 'Sidebar position',
      submenu: [
        ...displayChoices(screen.getAllDisplays(), screen.getPrimaryDisplay().id).map((d) => ({
          label: d.label, type: 'radio', checked: d.id === on, click: () => placeSidebar({ display: d.id }),
        })),
        { type: 'separator' },
        { label: 'Left edge', type: 'radio', checked: edge !== 'right', click: () => placeSidebar({ edge: 'left' }) },
        { label: 'Right edge', type: 'radio', checked: edge === 'right', click: () => placeSidebar({ edge: 'right' }) },
      ],
    });
  }
  items.push({ type: 'separator' });
  if (!folderMode) {
    // Which bubbles the pet shows; with none, a badge on it counts what needs you. Kept as
    // showActivity (any bubbles) and showSessionBubbles (sessions' too).
    const shown = !settings.get('showActivity') ? 'none' : settings.get('showSessionBubbles') === false ? 'notices' : 'all';
    const bubbles = (value, label, patch) => ({
      label,
      type: 'radio',
      checked: shown === value,
      click: () => {
        settings.set(patch);
        sendSessions();
      },
    });
    items.push({
      label: 'Bubbles',
      submenu: [
        bubbles('all', 'All', { showActivity: true, showSessionBubbles: true }),
        bubbles('notices', 'eTL, Slack and TodoMate only (no sessions)', { showActivity: true, showSessionBubbles: false }),
        bubbles('none', 'None (a badge counts what needs you)', { showActivity: false }),
      ],
    });
  }
  items.push({
    label: 'Show weekly limits',
    type: 'checkbox',
    checked: settings.get('showUsage'),
    click: (mi) => {
      settings.set({ showUsage: mi.checked });
      sendUsage();
    },
  });
  items.push({
    label: 'Animate even with Windows animation effects off',
    type: 'checkbox',
    checked: settings.get('alwaysAnimate') === true,
    click: (mi) => {
      settings.set({ alwaysAnimate: mi.checked });
      sendMotion();
    },
  });
  if (!folderMode) {
    items.push({ type: 'separator' });
    items.push({
      label: 'Reset position',
      click: () => {
        layout = 'above';
        petPos = clampPet(defaultPosition());
        finishMove();
        wake();
      },
    });
  }
  return { label: 'Appearance', submenu: items };
}

// What the pet watches besides Claude: Codex, live usage, web chats and eTL. Null when none of
// them is around.
function sourcesMenu() {
  const items = [];
  if (codexInstalled() && !DEMO) {
    items.push({
      label: 'Show Codex threads',
      type: 'checkbox',
      checked: settings.get('showCodex'),
      click: (mi) => {
        settings.set({ showCodex: mi.checked });
        if (mi.checked) startCodex();
        else stopCodex();
      },
    });
    items.push({
      label: 'Follow Codex on SSH hosts',
      type: 'checkbox',
      checked: settings.get('codexOverSsh'),
      enabled: settings.get('showCodex'),
      click: (mi) => {
        settings.set({ codexOverSsh: mi.checked });
        codex?.setWatchHosts(mi.checked);
      },
    });
  }
  if (localMod && liveUsageWanted()) items.push(liveUsageMenu());
  if (webchats) items.push(webchats.menu());
  if (etl) items.push(etl.menu());
  if (slack) items.push(slack.menu());
  if (todomate) items.push(todomate.menu());
  return items.length ? { label: 'Sources', submenu: items } : null;
}

// Starts a fresh pet as this one exits. The single-instance lock is let go first, so the new
// pet never finds it still held. The login flags aren't passed on: they'd undo a change made
// to Start at login since this pet started.
function restart() {
  log('restarting');
  app.relaunch({ args: [...ROOT_ARGS, ...(DEMO ? ['--demo'] : [])] });
  app.releaseSingleInstanceLock();
  app.quit();
}

function openPetsFolder() {
  const dir = petRoots(APP_ROOT).find((r) => r.source === 'user').dir;
  fs.mkdirSync(dir, { recursive: true });
  shell.openPath(dir);
}

function createTray() {
  tray = new Tray(trayImageFor(currentPet));
  tray.setToolTip(trayTooltip());
  const show = () => tray.popUpContextMenu(buildMenu());
  tray.on('click', show);
  tray.on('right-click', show);
}

// Debug aid: TTOKTTOK_PET_CAPTURE_DIR=<dir> saves a PNG of the pet window after each change.
let captureCount = 0;
function debugCapture(list) {
  const n = ++captureCount;
  setTimeout(async () => {
    if (!win || win.isDestroyed()) return;
    const image = await win.webContents.capturePage();
    const status = list[0]?.status || 'idle';
    fs.mkdirSync(DEBUG_CAPTURE_DIR, { recursive: true });
    fs.writeFileSync(path.join(DEBUG_CAPTURE_DIR, `capture-${String(n).padStart(2, '0')}-${status}.png`), image.toPNG());
    log(`captured ${status} (${list.length} sessions), window ${JSON.stringify(win.getBounds())}, menu items ${buildMenu().items.length}`);
  }, 1800);
}

// ---------------------------------------------------------------- updates (see updater.js)

const updateResultFile = () => path.join(app.getPath('userData'), 'update-result.json');
const updateBox = (options) => dialog.showMessageBox({ title: 'Ttokttok Pet', buttons: ['OK'], ...options });

function updateLabel() {
  if (updateBusy === 'checking') return 'Checking for updates…';
  return update ? 'Update available…' : 'Check for updates…';
}

// A clone updates itself from GitHub's main. A downloaded copy can't (it isn't a git checkout and
// has no npm), so for it the check looks at GitHub's releases and offers the download page.
async function checkUpdates() {
  updateBusy = 'checking';
  let found;
  try {
    found = app.isPackaged ? await checkForRelease(app.getVersion(), { fetch: net.fetch }) : await checkForUpdate(APP_ROOT);
  } finally {
    updateBusy = null;
  }
  update = found.status === 'available' ? found : null;
  log(`update check: ${found.status}${found.message ? ` (${found.message})` : ''}`);
  if (update) return offerUpdate();
  if (found.status === 'current') {
    const at = app.isPackaged ? `Version ${app.getVersion()}.` : `Version ${app.getVersion()} (${found.head.slice(0, 7)}).`;
    return updateBox({ type: 'info', message: 'Ttokttok Pet is up to date.', detail: at });
  }
  if (found.status === 'none') {
    return updateBox({ type: 'info', message: 'Ttokttok Pet is up to date.', detail: `Version ${app.getVersion()}. ${found.message}` });
  }
  return updateBox({ type: 'warning', message: "Couldn't check for updates.", detail: found.message });
}

// For a downloaded copy: says what's new and opens the download page; the user installs it.
async function offerRelease() {
  const { version, changes, url } = update;
  updateBusy = 'asking';
  let answer;
  try {
    answer = await updateBox({
      type: 'question',
      message: `Ttokttok Pet ${version} is available to download.`,
      detail: [
        ...(changes.length ? ["What's new:", ...changes.map((line) => `• ${line}`), ''] : []),
        `This copy (${app.getVersion()}) was installed from a download, so it can't update itself. Get the new ` +
        'installer or zip from the download page, quit the pet, and run the installer (or replace the unzipped folder). ' +
        'Your settings and pets are kept.',
      ].join('\n'),
      buttons: ['Open download page', 'Later'],
      defaultId: 0,
      cancelId: 1,
    });
  } finally {
    updateBusy = null;
  }
  if (answer.response === 0) shell.openExternal(url);
}

async function offerUpdate() {
  if (!update || updateBusy) return;
  if (app.isPackaged) return offerRelease();
  const { target, count, changes } = update;
  updateBusy = 'asking';
  let answer;
  try {
    answer = await updateBox({
      type: 'question',
      message: 'A new version of Ttokttok Pet is available.',
      detail: [
        "What's new:",
        ...changes.map((subject) => `• ${subject}`),
        count > changes.length ? `…and ${count - changes.length} more` : null,
        '',
        'The pet closes while it updates, then starts again. Your settings and pets are kept.',
      ].filter((line) => line !== null).join('\n'),
      buttons: ['Update and restart', 'Later'],
      defaultId: 0,
      cancelId: 1,
    });
  } finally {
    updateBusy = null;
  }
  if (answer.response !== 0) return;
  try {
    await startUpdate({
      root: APP_ROOT,
      target,
      relaunch: { exe: process.execPath, args: ROOT_ARGS },
      logFile,
      resultFile: updateResultFile(),
    });
  } catch (err) {
    log('could not start the update:', err.message);
    return updateBox({ type: 'warning', message: "Couldn't start the update.", detail: err.message });
  }
  log(`updating to ${target.slice(0, 7)}`);
  app.quit();
}

// The update ran while the pet was closed; this tells the user how it went.
async function showUpdateResult() {
  let result;
  try {
    result = JSON.parse(fs.readFileSync(updateResultFile(), 'utf8'));
    fs.rmSync(updateResultFile(), { force: true });
  } catch {
    return;   // no update was run
  }
  if (result.ok) {
    await updateBox({ type: 'info', message: 'Ttokttok Pet was updated.', detail: `Now at ${String(result.to).slice(0, 7)}.` });
  } else {
    await updateBox({
      type: 'warning',
      message: "The update didn't work.",
      detail: `${result.message}\n\nTtokttok Pet is still on the old version. The log has the details.`,
    });
  }
}

// ---------------------------------------------------------------- an older install (see migrate.js)

// An older install kept its settings in %APPDATA%\<previous name>. The folder comes along whole
// (the eTL token's key is in its Local State), copied if a browser's web chats host holds it. If
// even that fails, this run stays there and the next one tries again.
function userDataDir() {
  const dir = path.join(app.getPath('appData'), 'ttokttok-pet');
  const legacy = path.join(app.getPath('appData'), previous.dir);
  try {
    userDataNote = moveFolder(legacy, dir);
    return dir;
  } catch (err) {
    userDataNote = `couldn't move ${legacy} (${err.code || err.message})`;
    return fs.existsSync(dir) ? dir : legacy;
  }
}

// The rest of the older install's, once: Start at login under its name, and its home folder
// (LocalMod.adoptLegacy). Its copy of the mod stays until the WSL distros set up with it have
// moved over too (moveWsl).
function adoptPrevious() {
  if (userDataNote) log(userDataNote);
  moveLoginItem();
  try {
    const moved = localMod.adoptLegacy();
    if (!moved.length) return;
    log(`moved from ~/${previous.homeDir} to ~/.ttokttok-pet: ${moved.join(', ')}`);
    if (moved.includes('mod') && settings.get('claudeModWslToMove') == null) {
      const wsl = settings.get('claudeModWsl');
      settings.set({ claudeModWslToMove: Object.keys(wsl).filter((d) => wsl[d]) });
    }
    if (!settings.get('claudeModWslToMove')?.length) localMod.dropLegacy();
  } catch (err) {
    log(`couldn't move ~/${previous.homeDir}:`, err.message);
  }
}

// The older install started at login under its own name; if it did, this pet does in its place.
function moveLoginItem() {
  if (process.platform !== 'win32') return;
  const run = ['HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', previous.loginItem];
  try {
    execFileSync('reg.exe', ['query', ...run], { stdio: 'ignore', windowsHide: true });
  } catch {
    return;   // not there
  }
  try {
    execFileSync('reg.exe', ['delete', ...run, '/f'], { stdio: 'ignore', windowsHide: true });
    app.setLoginItemSettings({ ...loginItemOptions(), openAtLogin: true });
    log(`Start at login: ${previous.loginItem} replaced`);
  } catch (err) {
    log(`couldn't replace Start at login's ${previous.loginItem}:`, err.message);
  }
}

// A distro still loading the older install's copy of the mod loads the new one from now on. Once
// none is left to move, that copy goes.
async function moveWsl(distro, legacy) {
  const left = settings.get('claudeModWslToMove');
  if (!legacy && !left?.includes(distro)) return;
  if (legacy) {
    const r = await wslInstaller(distro, { action: 'update', windowsDir: localMod.dir });
    if (!r.ok) {
      log(`mod move in WSL ${distro} failed: ${r.error}`);
      return;
    }
    log(`mod moved to ~/.ttokttok-pet in WSL ${distro}`);
  }
  const rest = (left ?? []).filter((d) => d !== distro);
  settings.set({ claudeModWslToMove: rest });
  if (!rest.length) localMod.dropLegacy();
}

// ---------------------------------------------------------------- lifecycle

// A downloaded copy is named "Ttokttok Pet", which would give it its own %APPDATA%\Ttokttok Pet.
// Settings, pets and the log stay where a clone keeps them (%APPDATA%\ttokttok-pet, and
// ~/Library/Logs/ttokttok-pet on macOS), so going from one kind of install to the other loses
// nothing. Set before the single-instance lock, which lives in that folder too.
app.setPath('userData', DEBUG_USER_DATA || userDataDir());
app.setAppLogsPath(process.platform === 'darwin'
  ? path.join(app.getPath('home'), 'Library', 'Logs', 'ttokttok-pet')
  : path.join(app.getPath('userData'), 'logs'));

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    applyLoginFlag(argv);
    if (argv.includes('--codex-accounts')) codexAccounts?.open();
    else if (argv.includes('--getting-started')) gettingStarted?.open();
    else if (!applyModeFlag(argv)) setVisible(true);
  });
  app.setAppUserModelId('TtokttokPet');

  app.whenReady().then(() => {
    settings = new Settings(path.join(app.getPath('userData'), 'settings.json'));
    // A new install starts at login; the tray menu (or --no-start-at-login) turns that off.
    if (settings.firstRun && !DEMO) {
      app.setLoginItemSettings({ ...loginItemOptions(), openAtLogin: true });
      settings.save();
    }
    applyLoginFlag(process.argv);
    protocol.handle('pet', handleProtocol);
    if (!DEMO) {
      localMod = new LocalMod();
      adoptPrevious();   // before loadPets: your own pets may still be in the older install's folder
    }
    loadPets();
    const saved = settings.get('position');
    petPos = clampPet(saved && Number.isFinite(saved.x) && Number.isFinite(saved.y) ? saved : defaultPosition());
    layout = 'above';
    layout = chooseLayout(petPos);

    applyTheme();
    registerIpc();
    createTray();
    // Each time the sidebar docks, the Claude and Codex windows are maximized beside it.
    folder = new FolderWindow({
      log, width: settings.get('folderWidth'), edge: settings.get('folderEdge'), onDocked: () => maximizeApps('all'),
    });
    // Taken while Claude, Codex (ChatGPT.exe) or the sidebar (this app) is in front.
    stepKeys = new StepKeys({
      apps: ['claude', 'chatgpt', path.parse(process.execPath).name],
      onStep: (direction) => {
        gettingStarted?.tried('step', direction);
        folder.send('folder:step', direction);
      },
      globalShortcut,
      log,
    });
    const modeFlag = process.argv.find((a) => a.startsWith('--mode='))?.slice('--mode='.length);
    if (modeFlag === 'pet' || modeFlag === 'folder') settings.set({ mode: modeFlag });
    createWindow();
    if (settings.get('mode') === 'folder') applyMode();
    if (!DEMO) showUpdateResult();

    tracker = DEMO
      ? new DemoTracker()
      : new SessionTracker({
        ...defaultPaths(app.getPath('appData')), dismissed: settings.get('dismissed') || {},
        readyFrom: readyFrom(),
        cliReadyFrom: cliReadyFrom(),
      });
    tracker.on('change', (list) => {
      claudeSessions = list;
      mergeSessions();
    });
    tracker.on('list', (list) => {
      claudeAll = list;
      sendTree();
    });
    tracker.on('error', (err) => log('tracker error:', err?.message || err));
    if (DEMO) {
      tracker.on('usage', ({ claude, codex }) => setUsage({ claude: claude ? [claude] : [], codex }));
    } else {
      updateLocalMod();
      claudeUsage = new ClaudeUsage({
        usageFile: localMod.usageFile,
        sshConnections: defaultPaths(app.getPath('appData')).sshConnections,
        configHosts: settings.get('claudeSshHosts'),
        watchHosts: settings.get('claudeUsageOverSsh'),
      });
      claudeUsage.on('change', (readings) => setUsage({ claude: readings }));
      claudeUsage.on('hosts', () => {
        updateHostMods();
        gettingStarted?.send();   // a host's mod turned up, or changed
      });
      claudeUsage.on('chats', (chats) => tracker.setRemoteChats?.(chats));
      claudeUsage.on('error', (err) => log('claude usage:', err?.message || err));
      claudeUsage.start();
      // once the desktop index (for WSL distros) and the SSH connections have been read
      setTimeout(() => {
        (async () => {
          await checkWsl().catch((err) => log('WSL check:', err.message));
          await offerLiveUsage().catch((err) => log('mod offer:', err.message));
          await offerEtlConnection().catch((err) => log('eTL offer:', err.message));
        })();
        wslTimer = setInterval(() => {
          checkWsl()
            .then((found) => found && offerLiveUsage())
            .catch((err) => log('WSL check:', err.message));
        }, WSL_CHECK_MS);
        syncWslChats().catch((err) => log('WSL sessions:', err.message));
        wslChatsTimer = setInterval(() => syncWslChats().catch((err) => log('WSL sessions:', err.message)), WSL_CHATS_MS);
      }, 8000);
    }
    tracker.start();
    startCodex();
    if (!DEMO) codexAccounts = new CodexAccountsFeature({ electron: { BrowserWindow, shell, dialog }, changed: () => { sendUsage(true); } });
    if (process.argv.includes('--codex-accounts')) codexAccounts?.open();
    if (!DEMO) startEtl();
    if (!DEMO) startSlack();
    if (!DEMO) startTodomate();
    if (!DEMO) startWebChats();
    if (!DEMO) startPhone();
    if (!DEMO) {
      startGettingStarted();
      // A new install: Getting started has the eTL step, so the one-time eTL offer doesn't come too
      // (the Claude usage offer waits for it to close). `--getting-started` opens it any time.
      if (settings.firstRun) settings.set({ etlOnboardingOffered: true });
      if (settings.firstRun || process.argv.includes('--getting-started')) gettingStarted.open();
    }
    usageTimer = setInterval(sendUsage, 60_000);

    const shortcut = settings.get('shortcut');
    try {
      if (shortcut && !globalShortcut.register(shortcut, () => setVisible(!settings.get('visible')))) {
        log(`shortcut ${shortcut} is taken by another app`);
      }
    } catch (err) {
      log(`invalid shortcut ${shortcut}: ${err.message}`);
    }

    const onDisplaysChanged = () => {
      petPos = clampPet(petPos);
      finishMove();
    };
    // Debug aid: TTOKTTOK_PET_DEBUG_OPEN_AFTER_MS=<ms> simulates clicking the pet.
    if (DEBUG_OPEN_AFTER_MS) {
      setTimeout(() => {
        log('debug: simulating a pet click (openApp)');
        openApp(mainAppLink() || APP_LINK.claude);
      }, DEBUG_OPEN_AFTER_MS);
    }
    screen.on('display-metrics-changed', (_e, _display, changed) => {
      onDisplaysChanged();
      folder.onDisplayChanged(changed);
    });
    for (const event of ['display-added', 'display-removed']) {
      screen.on(event, () => {
        onDisplaysChanged();
        folder.onDisplayChanged();
      });
    }
    log(`watching ${os.homedir()} sessions${codex ? ' and Codex threads' : ''}; press ${shortcut} to show/hide`);
  });

  // The GPU and other helper processes (the page's own process is logged with its window).
  app.on('child-process-gone', (_event, details) => {
    log(`${details.type} process exited:`, details.reason, `(exit code ${details.exitCode})`);
  });

  app.on('window-all-closed', () => {
    // Keep running in the tray.
  });

  app.on('before-quit', (e) => {
    // The sidebar's strip is given back before the pet goes, so maximized windows fill it again.
    if (folder?.open && !quitting) {
      e.preventDefault();
      quitting = true;
      folder.close().finally(() => app.quit());
      return;
    }
    clearInterval(usageTimer);
    clearInterval(wslTimer);
    clearInterval(wslChatsTimer);
    stopMomentum();
    stepKeys?.stop();
    tracker?.stop();
    codex?.stop();
    codexAccounts?.stop();
    etl?.stop();
    slack?.stop();
    todomate?.stop();
    webchats?.stop();
    phone?.stop();
    claudeUsage?.stop();
    if (settings) settings.save();
  });

  app.on('will-quit', () => globalShortcut.unregisterAll());
}
