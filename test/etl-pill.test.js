'use strict';

// The bubbles src/renderer/pet.js draws for eTL notices and web chats. test/renderer-fixture.js stands in for
// the page only as far as the pet's shape needs, so this runs the page against elements that
// also keep their children, text and attributes.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function element(tag = 'div') {
  const classes = new Set();
  const attributes = new Map();
  let text = '';
  const el = {
    tag,
    style: { setProperty() {} },
    children: [],
    hidden: false,
    scrollHeight: 0,
    clientHeight: 0,
    get className() { return [...classes].join(' '); },
    set className(value) {
      classes.clear();
      for (const c of String(value).split(/\s+/).filter(Boolean)) classes.add(c);
    },
    classList: {
      add: (s) => classes.add(s),
      remove: (s) => classes.delete(s),
      contains: (s) => classes.has(s),
      toggle: (s, on) => (on ? classes.add(s) : classes.delete(s)),
    },
    get textContent() { return text + el.children.map((c) => c.textContent).join(''); },
    set textContent(value) {
      el.children = [];
      text = String(value);
    },
    set innerHTML(value) { throw new Error(`innerHTML set to ${value}`); },
    setAttribute: (name, value) => attributes.set(name, String(value)),
    getAttribute: (name) => attributes.get(name) ?? null,
    append(...nodes) { el.children.push(...nodes); },
    replaceChildren(...nodes) { el.children = nodes; },
    addEventListener() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }),
  };
  return el;
}

function page() {
  const filename = path.join(__dirname, '../src/renderer/pet.js');
  const callbacks = {};
  const nodes = Object.fromEntries(['stage', 'pet', 'sprite', 'tray', 'badge'].map((id) => [id, element()]));
  const api = {};
  for (const event of ['Pet', 'Motion', 'Layout', 'Sessions', 'Usage', 'Wake', 'Landed']) {
    api[`on${event}`] = (fn) => { callbacks[event] = fn; };
  }
  for (const method of ['ready', 'setShape', 'dragStart', 'dragMove', 'dragEnd', 'activate', 'dismiss', 'traySize', 'contextMenu']) {
    api[method] = () => {};
  }
  class SpritePlayer {
    hitTest() { return false; }
    shapeRects() { return []; }
    setBase() {}
    playOnce() {}
  }
  const context = {
    window: { pet: api, SpritePlayer, innerWidth: 400, innerHeight: 500, addEventListener() {} },
    document: { getElementById: (id) => nodes[id], createElement: element, documentElement: element() },
    setInterval() {},
    matchMedia: () => ({ addEventListener() {} }),
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  // The bubbles for these sessions, in order.
  return (sessions) => {
    callbacks.Sessions({ sessions, showActivity: true });
    return nodes.tray.children;
  };
}

function find(el, className) {
  if (el.classList.contains(className)) return el;
  for (const child of el.children) {
    const found = find(child, className);
    if (found) return found;
  }
  return null;
}

const NOTICE = {
  id: 'etl:deadline:100001:200001',
  kind: 'etl',
  status: 'waiting',
  badge: '마감 임박',
  title: '6주차 보고서 제출',
  detail: '공학 세미나 · 2시간 남음',
  url: 'https://myetl.snu.ac.kr/courses/100001/assignments/200001',
  since: Date.now(),
};

test('an eTL notice is marked as coming from eTL', () => {
  const [bubble] = page()([NOTICE]);
  assert.equal(find(bubble, 'what').textContent, 'eTL');
});

test("today's classes and TodoMate schedule don't say which app they come from", () => {
  const at = Date.parse('2026-11-03T13:00:00+09:00');
  const [cls, todo] = page()([
    { id: 'etl:timetable:c', kind: 'etl', status: 'review', badge: '13:00', title: '가상현실공학', project: '000-101 · 30분 후', startsAt: at },
    { id: 'todomate:2026-11-03:b', kind: 'todomate', status: 'idle', badge: '13:00', title: '랩미팅', project: '30분 후', startsAt: at },
  ]);
  assert.equal(find(cls, 'what').textContent, '000-101 · 30분 후');
  assert.equal(find(todo, 'what').textContent, '30분 후');
});

test('an eTL notice shows its badge where a session shows its status', () => {
  const [bubble] = page()([NOTICE]);
  assert.equal(find(bubble, 'label').textContent, '마감 임박');
  assert.equal(find(bubble, 'title').textContent, '6주차 보고서 제출');
  assert.equal(bubble.className, 'pill status-waiting enter');
});

test('an eTL notice without a badge falls back to the status label', () => {
  const [bubble] = page()([{ ...NOTICE, badge: undefined, status: 'review' }]);
  assert.equal(find(bubble, 'label').textContent, 'Ready');
});

test('text from eTL is shown as text, never read as HTML', () => {
  const title = '<img src=x onerror="alert(1)"><b>과제</b>';
  const [bubble] = page()([{ ...NOTICE, title, badge: '<i>새 공지</i>' }]);
  assert.equal(find(bubble, 'title').textContent, title);
  assert.equal(find(bubble, 'title').children.length, 0);
  assert.equal(find(bubble, 'label').textContent, '<i>새 공지</i>');
  assert.match(bubble.getAttribute('aria-label'), /^<img src=x onerror="alert\(1\)"><b>과제<\/b>, /);
});

test('screen readers hear that an eTL notice opens in eTL', () => {
  const [bubble] = page()([NOTICE]);
  assert.equal(bubble.getAttribute('aria-label'), '6주차 보고서 제출, 공학 세미나 · 2시간 남음, Click to open in eTL');
});

test('an eTL notice whose link is not on eTL is not offered as a link', () => {
  const show = page();
  for (const url of [undefined, '', 'http://myetl.snu.ac.kr/courses/1', 'https://myetl.snu.ac.kr.evil.example/', 'javascript:alert(1)', 'file:///C:/x']) {
    const [bubble] = show([{ ...NOTICE, url }]);
    assert.match(bubble.getAttribute('aria-label'), /, eTL notice \(no link\)$/, String(url));
  }
});

test('the eTL 비서 bubble has a × to turn it off; a running session still has none', () => {
  const [assistant, running] = page()([
    { id: 'etl:assistant', kind: 'etl', assistant: true, status: 'background', badge: 'eTL 비서', title: '과제·공지·강의자료 물어보기', since: Date.now() },
    { id: 'a', status: 'running', title: 'Refactor auth', since: Date.now() },
  ]);
  assert.equal(find(assistant, 'close').getAttribute('aria-label'), 'Turn off this bubble');
  assert.equal(find(running, 'close'), null);
  assert.equal(find(page()([NOTICE])[0], 'close').getAttribute('aria-label'), 'Dismiss');
});

test('a web chat says which chat it is, and only a Ready one has a ×', () => {
  const [ready, running] = page()([
    { id: 'web:chatgpt:1', kind: 'web', site: 'chatgpt', siteName: 'ChatGPT', status: 'review', title: 'Essay outline', detail: 'Reply ready', since: Date.now() },
    { id: 'web:claude:2', kind: 'web', site: 'claude', siteName: 'Claude Chat', status: 'running', title: 'Trip ideas', detail: 'Writing a reply', since: Date.now() },
  ]);
  assert.equal(find(ready, 'what').textContent, 'ChatGPT');
  assert.equal(ready.getAttribute('aria-label'), 'Essay outline, Reply ready, Click to open in the browser');
  assert.ok(find(ready, 'close'));
  assert.equal(find(running, 'what').textContent, 'Claude Chat');
  assert.equal(find(running, 'close'), null);
});

test('Claude and Codex bubbles are as before; Claude Code outside the app says where it runs', () => {
  const [claude, codex, cli, vscode] = page()([
    { id: 'a', status: 'review', title: 'Refactor auth', detail: 'All tests pass', project: 'auth-service', remote: 'lab', since: Date.now() },
    { id: 'b', kind: 'codex', status: 'waiting', title: 'Port tokenizer', detail: 'Which crate?', project: 'tokenizer', remote: 'lab', since: Date.now(), url: 'codex://threads/1' },
    { id: 'c', kind: 'cli', client: 'terminal', status: 'failed', title: 'Dataset cleanup', project: 'datasets', since: Date.now() },
    { id: 'd', kind: 'cli', client: 'vscode', status: 'review', title: 'Model identifier', project: 'projects', remote: 'lab', since: Date.now() },
  ]);
  assert.equal(find(claude, 'what').textContent, 'Claude · auth-service');
  assert.equal(find(claude, 'label').textContent, 'Ready');
  assert.equal(claude.getAttribute('aria-label'), 'Refactor auth, All tests pass, SSH · lab, Click to open in Claude');
  assert.equal(find(codex, 'what').textContent, 'Codex · tokenizer');
  assert.equal(find(codex, 'label').textContent, 'Needs you');
  assert.equal(codex.getAttribute('aria-label'), 'Port tokenizer, Which crate?, on lab, Click to open in Codex');
  assert.equal(find(cli, 'what').textContent, 'Terminal · datasets');
  assert.equal(cli.getAttribute('aria-label'), 'Dataset cleanup, Terminal session (no link)');
  assert.equal(find(vscode, 'what').textContent, 'VS Code · projects');
  assert.equal(vscode.getAttribute('aria-label'), 'Model identifier, SSH · lab, Click to open in VS Code');
});

test("Codex's chats in VS Code or a terminal say so", () => {
  const [ext, tui] = page()([
    { id: 'e', kind: 'codex', client: 'vscode', status: 'review', title: 'Reframe', project: 'urban-map', since: Date.now(), url: 'vscode://openai.chatgpt/local/x' },
    { id: 't', kind: 'codex', client: 'terminal', status: 'review', title: 'Notes', project: 'notes', remote: 'lab', since: Date.now(), url: null },
  ]);
  assert.equal(find(ext, 'what').textContent, 'Codex · VS Code · urban-map');
  assert.equal(ext.getAttribute('aria-label'), 'Reframe, Click to open in VS Code');
  assert.equal(find(tui, 'what').textContent, 'Codex · Terminal · notes');
  assert.equal(tui.getAttribute('aria-label'), 'Notes, on lab, Terminal session (no link)');
});
