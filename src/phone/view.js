'use strict';

// What the phone shows: the sidebar's machine › folder tree (folder-tree.js), eTL's and Slack's
// notices and the weekly limits, cut down to what the page draws. Each session and notice says which
// app a tap opens and at which page (`open`); the page turns that into a link for the phone it runs on
// (src/phone/www/app.js). A Claude Code session with Remote Control on opens at itself in the
// Claude app (https://claude.ai/code/<its Remote Control session>), one without at the Code tab.
// Codex has no link to one thread on a phone, so a Codex thread opens the ChatGPT app's Codex
// screen. A web chat lives in the account, so it opens at its own conversation.

const ETL_HOME = 'https://myetl.snu.ac.kr/';
const ETL_LINK = /^https:\/\/myetl\.snu\.ac\.kr\//;
const SLACK_LINK = /^https:\/\/[a-z0-9-]+\.(enterprise\.)?slack\.com\/docs\//;
const TODOMATE_HOME = 'https://www.todomate.net/';
const CLAUDE_SESSION = /^https:\/\/claude\.ai\/code\/session_[A-Za-z0-9]{8,64}$/;
const OWN_LINK = {
  claude: CLAUDE_SESSION,
  vscode: CLAUDE_SESSION,
  terminal: CLAUDE_SESSION,
  'claude-web': /^https:\/\/claude\.ai\//,
  chatgpt: /^https:\/\/chatgpt\.com\//,
  gemini: /^https:\/\/gemini\.google\.com\//,
};

// app (folder-tree.js's itemOf) -> [the phone app, the page it opens at]
const OPEN = {
  claude: ['claude', 'https://claude.ai/code'],
  vscode: ['claude', 'https://claude.ai/code'],
  terminal: ['claude', 'https://claude.ai/code'],
  codex: ['chatgpt', 'https://chatgpt.com/codex'],
  'codex-vscode': ['chatgpt', 'https://chatgpt.com/codex'],
  'codex-terminal': ['chatgpt', 'https://chatgpt.com/codex'],
  'claude-web': ['claude', 'https://claude.ai/'],
  chatgpt: ['chatgpt', 'https://chatgpt.com/'],
  gemini: ['gemini', 'https://gemini.google.com/app'],
};

// An eTL notice opens in LearningX; a Slack reminder at its canvas in Slack, or nowhere without one;
// a TodoMate schedule item in TodoMate.
function noticeOpen(s) {
  if (s.kind === 'todomate') return { app: 'todomate', url: TODOMATE_HOME };
  if (s.kind === 'slack') return { app: 'slack', url: SLACK_LINK.test(s.url || '') ? s.url : null };
  return { app: 'learningx', url: ETL_LINK.test(s.url || '') ? s.url : ETL_HOME };
}

// `link`: the session's own address, if it has one (a web chat's, a Claude session's Remote Control).
function openTarget(app, link = null) {
  const [phoneApp, url] = OPEN[app] || OPEN.claude;
  const own = OWN_LINK[app]?.test(link || '') ? link : null;
  return { app: phoneApp, url: own || url };
}

function sessionOf(s, linkOf) {
  return {
    id: s.id,
    app: s.app,
    title: s.title || '',
    status: s.status,
    detail: s.detail || '',
    since: s.since || 0,
    lastActivityAt: s.lastActivityAt || 0,
    ...(s.siteName && { siteName: s.siteName }),
    ...(s.nest && { nest: s.nest }),
    open: openTarget(s.app, linkOf(s.id)),
  };
}

function folderOf(n, linkOf) {
  return {
    key: n.key,
    label: n.label,
    path: n.path,
    open: n.open,
    attention: n.attention,
    busy: n.busy,
    sessions: n.sessions.map((s) => sessionOf(s, linkOf)),
    children: n.children.map((c) => folderOf(c, linkOf)),
  };
}

// `hosts`: buildTree's. `notices`: the eTL, Slack and TodoMate items (etl/feature.js,
// slack/feature.js, todomate/feature.js).
// `usage`: usageView's.
// `linkOf(id)`: a session's own address: a web chat's, if a tab shows it, or a Claude session's
// Remote Control session.
function phoneView({ hosts = [], notices = [], usage = [], linkOf = () => null } = {}) {
  return {
    hosts: hosts.map((h) => ({
      key: h.key,
      kind: h.kind,
      label: h.label,
      attention: h.attention,
      busy: h.busy,
      folders: h.folders.map((n) => folderOf(n, linkOf)),
      loose: h.loose.map((s) => sessionOf(s, linkOf)),
    })),
    // The eTL assistant opens a Codex chat on the PC; there's nothing for it on the phone.
    notices: notices.filter((s) => !s.assistant).map((s) => ({
      id: s.id,
      status: s.status,
      badge: s.badge || '',
      title: s.title || '',
      project: s.project || '',
      open: noticeOpen(s),
    })),
    usage: usage.map(({ app, name, percent, elapsed, resetsIn, age }) => ({ app, name, percent, elapsed, resetsIn, age })),
  };
}

// What a tap on each row opens: id -> `open`, for the notifications, which open the same.
function opensOf(view) {
  const opens = new Map();
  const add = (s) => opens.set(s.id, s.open);
  const walk = (n) => {
    n.sessions.forEach(add);
    n.children.forEach(walk);
  };
  for (const h of view.hosts) {
    h.folders.forEach(walk);
    h.loose.forEach(add);
  }
  view.notices.forEach(add);
  return opens;
}

// For a notification whose session has no row (a Codex thread in the cloud, say): its app's own
// screen, by the kind of session (notify.js's events). Null for the rest; the page opens instead.
function openOfKind(kind) {
  if (kind === 'codex') return openTarget('codex');
  if (kind === 'desktop' || kind === 'cli') return openTarget('claude');
  if (kind === 'etl') return { app: 'learningx', url: ETL_HOME };
  return null;
}

module.exports = { phoneView, openTarget, opensOf, openOfKind, ETL_HOME };
