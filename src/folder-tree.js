'use strict';

// Folder mode's tree: every Claude session and Codex thread, under the machine it runs on and the
// folder it runs in (host › folder). The two apps name the same place differently, so both are
// brought to one form first:
//
//   Claude                                  Codex                                 here
//   sshConfig alice@192.0.2.10:22           remote-ssh-discovered:lab             ssh:192.0.2.10:22, via ~/.ssh/config
//   wslConfig Ubuntu                        local, with a Linux path               wsl:ubuntu
//   C:\Users\me\pet                         /mnt/c/Users/me/pet                   pc, C:\Users\me\pet
//   \\wsl$\Ubuntu\home\me                   (an SSH host on 127.0.0.1)            wsl:ubuntu, /home/me
//
// A session sits in the folder it was opened in, so one opened in a parent folder stays there.
// Folders that only lead to others are joined into one row (/data/me/projects), as an editor's
// compact folders are. Sessions started without a folder (Claude's scratch folders, Codex's dated
// ones) go under "No folder".

const { isSameHost } = require('./ssh-config');
const { projectName } = require('./sessions');

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);
const ATTENTION = new Set(['waiting', 'failed', 'review']);
const BUSY = new Set(['running', 'background']);
const OPEN_DAYS = 30;   // a folder with nothing newer starts out folded
const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------- hosts

// What ~/.ssh/config says `target` ([user@]host or an alias) on `port` is: the machine's name
// (its HostName, else the host itself), the port, and the alias if there is one.
function sshMachine(target, port, sshHosts) {
  const host = target.slice(target.lastIndexOf('@') + 1);
  const cfg = sshHosts.find((h) => isSameHost(h, target, port ?? null));
  return {
    name: (cfg?.hostName || host).toLowerCase(),
    port: port ?? cfg?.port ?? 22,
    alias: cfg?.alias ?? (host === target ? target : null),
  };
}

const PC = { key: 'pc', kind: 'pc', label: 'Local' };

// Just "WSL"; with more than one distro in the tree, each also names its own (buildTree).
function wslHost(distro) {
  return distro
    ? { key: `wsl:${distro.toLowerCase()}`, kind: 'wsl', label: 'WSL', distro }
    : { key: 'wsl', kind: 'wsl', label: 'WSL' };
}

// An SSH host, or WSL when the host is this PC's own loopback (WSL's sshd).
function sshHost({ target, port, labels }, ctx) {
  const m = sshMachine(target, port, ctx.sshHosts);
  if (LOOPBACK.has(m.name)) return wslHost(ctx.defaultWsl);
  const isAddress = (s) => !s || /^[\d.:]+$/.test(s) || s.includes('@');
  const label = [...labels, m.alias].find((s) => !isAddress(s)) || m.alias || m.name;
  return { key: `ssh:${m.name}:${m.port}`, kind: 'ssh', label };
}

// ---------------------------------------------------------------- paths

// Where a path points: { host (pc or wsl, or null for a plain Linux path), style, segments }.
// Windows paths keep their case for showing and are compared without it.
function splitPath(cwd, ctx) {
  if (!cwd) return null;
  const unc = /^\\\\wsl(?:\$|\.localhost)\\([^\\]+)(\\.*)?$/i.exec(cwd);
  if (unc) return { host: wslHost(unc[1]), style: 'posix', segments: posixSegments((unc[2] || '').replace(/\\/g, '/')) };
  const mnt = /^\/mnt\/([a-z])(\/.*)?$/i.exec(cwd);
  if (mnt) return { host: PC, style: 'win', segments: [`${mnt[1].toUpperCase()}:`, ...posixSegments(mnt[2] || '')] };
  if (/^[a-z]:([\\/]|$)/i.test(cwd)) {
    const [drive, ...rest] = cwd.split(/[\\/]+/).filter(Boolean);
    return { host: PC, style: 'win', segments: [drive.toUpperCase(), ...rest] };
  }
  if (cwd.startsWith('/')) return { host: null, style: 'posix', segments: posixSegments(cwd) };
  return null;
}

function posixSegments(p) {
  return p.split('/').filter(Boolean);
}

// ---------------------------------------------------------------- placing sessions

// { host, place } for a Claude session from SessionTracker.all.
function placeClaude(s, ctx) {
  const where = splitPath(s.cwd, ctx);
  const ssh = /^ssh:(.+):(\d+)$/.exec(s.machineKey || '');
  if (ssh) return { host: sshHost({ target: ssh[1], port: Number(ssh[2]), labels: [s.machine] }, ctx), where };
  const wsl = /^wsl:(.+)$/.exec(s.machineKey || '');
  if (wsl) return { host: wslHost(wsl[1]), where: where && { ...where, host: null } };
  return { host: where?.host || PC, where };
}

// { host, place } for a Codex thread from CodexTracker.all.
function placeCodex(s, ctx) {
  if (s.machineKey) return placeClaude(s, ctx);   // a VS Code or terminal chat in WSL
  const where = splitPath(s.cwd, ctx);
  if (!s.hostId || s.hostId === 'local') {
    // The app runs its local threads on Windows, or in WSL (then its paths are Linux paths).
    return { host: where?.host || (where?.style === 'posix' ? wslHost(ctx.defaultWsl) : PC), where };
  }
  const c = ctx.codexConnections.find((x) => x.hostId === s.hostId);
  const target = c?.target || s.hostId.replace(/^remote-ssh-discovered:/, '');
  return { host: sshHost({ target, port: c?.port ?? null, labels: [c?.name, s.remote] }, ctx), where };
}

// `app`: claude or codex, or a web chat's site; a Claude Code session outside the desktop app
// says which app it runs in instead (vscode or terminal, sessions.js's clientOf), and a Codex chat
// outside the Codex app does too (codex-vscode or codex-terminal, rollout.js's clientOf).
function itemOf(s, app) {
  return {
    id: s.id,
    app: s.client ? (app === 'codex' ? `codex-${s.client}` : s.client) : app,
    title: s.title,
    status: s.status,
    detail: s.detail || '',
    since: s.since || 0,
    lastActivityAt: s.lastActivityAt || 0,
    ...(s.siteName && { siteName: s.siteName }),   // a web chat's site
    ...(s.forkOf && { forkOf: s.forkOf }),         // the session it was forked from (see nest)
  };
}

// ---------------------------------------------------------------- the tree

function newNode(key, label, pathText) {
  return { key, label, path: pathText, sessions: [], children: new Map() };
}

// `claude`, `codex`: the trackers' full lists. `chats`: the web chats' (WebChats.all), which go
// first, right under "Chat" (as its `loose`). `sshHosts`: from ~/.ssh/config (sshConfigHosts).
// `codexConnections`: CodexTracker.connections. `defaultWsl`: the distro Codex's local threads
// and loopback SSH hosts run in. `marked`: the sessions you marked as Ready, and when (marks.js).
// `now`: for which folders start out open.
function buildTree({
  claude = [], codex = [], chats = [], sshHosts = [], codexConnections = [], defaultWsl = null, marked = {}, now = Date.now(),
} = {}) {
  const ctx = { sshHosts, codexConnections, defaultWsl };
  // A quiet session you marked shows as Ready; one with news of its own shows that.
  const item = (s, app) => {
    const it = itemOf(s, app);
    return Object.hasOwn(marked, s.id) && it.status === 'idle' ? { ...it, status: 'review', detail: 'Marked as Ready', since: marked[s.id] } : it;
  };
  const hosts = new Map();   // key -> { host, root, loose }
  const add = (s, app, { host, where }) => {
    let h = hosts.get(host.key);
    if (!h) hosts.set(host.key, (h = { host, root: newNode(host.key, '', ''), loose: [] }));
    if (!where || projectName(s.cwd) == null) {   // no folder, or one the app made for a session without one
      h.loose.push(item(s, app));
      return;
    }
    const win = where.style === 'win';
    let node = h.root;
    let text = '';
    for (const seg of where.segments) {
      text = win ? (text ? `${text}\\${seg}` : seg) : `${text}/${seg}`;
      const k = win ? seg.toLowerCase() : seg;
      if (!node.children.has(k)) node.children.set(k, newNode(`${host.key}|${win ? text.toLowerCase() : text}`, seg, text));
      node = node.children.get(k);
    }
    node.sessions.push(item(s, app));
  };
  for (const s of claude) add(s, 'claude', placeClaude(s, ctx));
  for (const s of codex) add(s, 'codex', placeCodex(s, ctx));

  const order = { pc: 0, wsl: 1, ssh: 2 };
  const machines = [...hosts.values()]
    .map(({ host, root, loose }) => {
      const folders = [...root.children.values()].map((n) => finish(compact(n, null), now));
      folders.sort(byLatest);
      const all = [...folders.flatMap(allSessions), ...loose];
      return { ...host, folders, loose: nest(loose), ...counts(all), latest: latestOf(all) };
    });
  const wsl = machines.filter((m) => m.kind === 'wsl');
  if (wsl.length > 1) for (const m of wsl) if (m.distro) m.label = `WSL · ${m.distro}`;
  machines.sort((a, b) => order[a.kind] - order[b.kind] || a.label.localeCompare(b.label));
  const chat = chatHost(chats, item);
  return chat ? [chat, ...machines] : machines;
}

// The web chats as the first heading, "Chat", their conversations right under it, newest first;
// a dot in each site's color tells claude.ai's, ChatGPT's and Gemini's apart.
const CHAT_APP = { claude: 'claude-web', chatgpt: 'chatgpt', gemini: 'gemini' };

function chatHost(chats, item) {
  const sessions = chats.filter((c) => CHAT_APP[c.site]).map((c) => item(c, CHAT_APP[c.site])).sort(byActivity);
  if (!sessions.length) return null;
  return { key: 'chat', kind: 'chat', label: 'Chat', folders: [], loose: sessions, ...counts(sessions), latest: latestOf(sessions) };
}

// A folder with no sessions of its own and one folder in it becomes one row with it. A top row
// shows its whole path, one inside another the part below its parent's.
function compact(node, parentPath) {
  let n = node;
  while (!n.sessions.length && n.children.size === 1) [n] = n.children.values();
  n.label = parentPath == null ? n.path : n.path.slice(parentPath.length).replace(/^[\\/]/, '');
  n.children = new Map([...n.children].map(([k, c]) => [k, compact(c, n.path)]));
  return n;
}

function finish(n, now) {
  const children = [...n.children.values()].map((c) => finish(c, now)).sort(byLatest);
  const sessions = nest(n.sessions);
  const all = [...sessions, ...children.flatMap(allSessions)];
  const latest = latestOf(all);
  return {
    key: n.key,
    label: n.label,
    path: n.path,
    sessions,
    children,
    latest,
    open: now - latest < OPEN_DAYS * DAY_MS,
    ...counts(all),
  };
}

// A folder's sessions, newest first, each fork or side chat right under the session it came from
// when that one is in the same list (Claude's forks, side chats and btw questions; the Codex
// threads you forked). `nest` says how far below: 1 for a fork, 2 for a fork of that. A family sits
// where its newest session would.
function nest(sessions) {
  const ids = new Set(sessions.map((s) => s.id));
  const kids = new Map();
  for (const s of sessions) if (s.forkOf && ids.has(s.forkOf)) kids.set(s.forkOf, [...(kids.get(s.forkOf) ?? []), s]);
  const newest = (s, seen = new Set()) => {
    seen.add(s.id);
    return Math.max(s.lastActivityAt || 0, ...(kids.get(s.id) ?? []).filter((k) => !seen.has(k.id)).map((k) => newest(k, seen)));
  };
  const out = [];
  const placed = new Set();
  const place = (s, depth) => {
    if (placed.has(s.id)) return;
    placed.add(s.id);
    out.push(depth ? { ...s, nest: depth } : s);
    for (const k of (kids.get(s.id) ?? []).sort(byActivity)) place(k, depth + 1);
  };
  sessions.filter((s) => !s.forkOf || !ids.has(s.forkOf))
    .map((s) => [s, newest(s)])
    .sort((a, b) => b[1] - a[1])
    .forEach(([s]) => place(s, 0));
  for (const s of [...sessions].sort(byActivity)) place(s, 0);   // forks that name each other in a loop
  return out;
}

function allSessions(n) {
  return [...n.sessions, ...n.children.flatMap(allSessions)];
}

// How many need you, and how many are working, so a folded folder can still say so.
function counts(sessions) {
  return {
    attention: sessions.filter((s) => ATTENTION.has(s.status)).length,
    busy: sessions.filter((s) => BUSY.has(s.status)).length,
  };
}

// The sessions in `hosts` (buildTree's) that show Needs you, Error or Ready: what Mark all as done
// settles.
function attentionIds(hosts) {
  return hosts.flatMap((h) => [...h.folders.flatMap(allSessions), ...h.loose]).filter((s) => ATTENTION.has(s.status)).map((s) => s.id);
}

// The tray menu's Hidden from the sidebar: the hidden sessions as the sidebar would show them,
// machine › folder › session (`hosts`: buildTree's, of the hidden sessions only). A row that opens
// a submenu can't be clicked itself, so each machine and folder starts with Show all here.
// `show(ids)` brings those sessions back.
function hiddenMenu(hosts, show) {
  const sessionItem = (s) => ({ label: `${s.nest ? '↳ ' : ''}${clip(s.title, 42)}`, click: () => show([s.id]) });
  const group = (label, sessions, items) => ({
    label: `${label}  (${sessions.length})`,
    submenu: [
      { label: sessions.length === 1 ? 'Show it' : `Show all ${sessions.length} here`, click: () => show(sessions.map((s) => s.id)) },
      { type: 'separator' },
      ...items,
    ],
  });
  const folderItem = (n) => group(clipPath(n.label, 42), allSessions(n), [...n.sessions.map(sessionItem), ...n.children.map(folderItem)]);
  return hosts.map((h) => {
    const loose = h.kind === 'chat' ? h.loose.map(sessionItem)
      : h.loose.length ? [group('No folder', h.loose, h.loose.map(sessionItem))] : [];
    return group(h.label, [...h.folders.flatMap(allSessions), ...h.loose], [...h.folders.map(folderItem), ...loose]);
  });
}

function clip(s, n) {
  const t = String(s ?? '');
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

// A long path keeps its end, where the folder's own name is.
function clipPath(s, n) {
  return s.length > n ? `…${s.slice(s.length - n + 1)}` : s;
}

function latestOf(sessions) {
  return sessions.reduce((m, s) => Math.max(m, s.lastActivityAt || 0, s.status !== 'idle' ? s.since || 0 : 0), 0);
}

function byLatest(a, b) {
  return b.latest - a.latest;
}

function byActivity(a, b) {
  return b.lastActivityAt - a.lastActivityAt;
}

module.exports = { buildTree, splitPath, sshMachine, attentionIds, hiddenMenu };
