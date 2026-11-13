'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { TodomateFeature, AUTH_ID, TOOLBOX_ID } = require('../src/todomate/feature');
const { MCP_URL, TOOLBOX_URL } = require('../src/todomate/mcp');

const kst = (s) => Date.parse(`${s}+09:00`);
const TIMERS = { setInterval: () => 1, clearInterval() {} };
const OTT = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

function settingsStore(initial = {}) {
  const values = { ...initial };
  return { get: (k) => values[k], set: (patch) => Object.assign(values, patch), values };
}

// A plain stand-in for safeStorage: "encrypts" by reversing the bytes.
const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(s).reverse(),
  decryptString: (b) => Buffer.from(b).reverse().toString(),
};

function json(id, result) {
  return {
    status: 200,
    ok: true,
    headers: { get: (k) => (k.toLowerCase() === 'content-type' ? 'application/json' : null) },
    json: async () => ({ jsonrpc: '2.0', id, result }),
  };
}

// PlayMCP answering with `todos` for loadTodoItems, or 401 when `refuse` is set. With `noTool`, its
// tool list has no TodoMate (the toolbox lost it); with `down`, it answers HTTP 500.
function playmcp(state) {
  return async (url, init) => {
    if (url.includes('otts:exchange')) {
      state.exchanges.push(JSON.parse(init.body).tokenValue);
      return { status: 200, ok: true, headers: { get: () => 'application/json' }, json: async () => ({
        accessToken: { tokenValue: 'a1', expiresAt: '2026-11-03T22:59:09.067Z' },
        refreshToken: { tokenValue: 'r1', expiresAt: '2027-02-01T10:59:09.069Z' },
      }) };
    }
    if (url.includes('/oauth2/token')) return { status: 400, ok: false, headers: { get: () => null }, json: async () => ({ error: 'invalid_grant' }) };
    assert.equal(url, MCP_URL);
    if (init.method === 'DELETE') return { status: 200, ok: true, headers: { get: () => null } };
    if (state.refuse) return { status: 401, ok: false, headers: { get: () => null } };
    if (state.down) return { status: 500, ok: false, headers: { get: () => null } };
    const body = JSON.parse(init.body);
    if (!body.id) return { status: 202, ok: true, headers: { get: () => null } };
    if (body.method === 'tools/list' && state.noTool) return json(body.id, { tools: [{ name: 'someOtherTool' }] });
    if (body.method === 'tools/list') return json(body.id, { tools: [{ name: 'loadTodoItems' }, { name: 'loadTodoItemsByDateRange' }, { name: 'loadGoals' }] });
    if (body.method === 'tools/call' && body.params.name === 'loadTodoItemsByDateRange') {
      state.ranges.push(body.params.arguments);
      const a = body.params.arguments;
      const span = (Date.UTC(a.end_year, a.end_month - 1, a.end_day) - Date.UTC(a.start_year, a.start_month - 1, a.start_day)) / 86400000;
      // With `capWide`, a window of more than a week is full: 100 items, the way the real tool stops.
      if (state.capWide && span > 7) return json(body.id, { structuredContent: { items: Array.from({ length: 100 }, (_, i) => ({ id: `f${i}`, content: 'filler', goal_id: 'g2' })) } });
      return json(body.id, { structuredContent: { items: state.recent } });
    }
    if (body.method === 'tools/call' && body.params.name === 'loadTodoItems') {
      return json(body.id, { structuredContent: { items: state.todos } });
    }
    if (body.method === 'tools/call') return json(body.id, { structuredContent: { goals: [{ id: 'g1', title: 'Schedule' }, { id: 'g2', title: 'Logistics' }, { id: 'g3', title: 'D-Day' }] } });
    return json(body.id, {});
  };
}

function setUp(t, { todos, recent = [], now = kst('2026-11-03T09:00:00') }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'todomate-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const state = { todos, recent, refuse: false, now, prompts: 0, exchanges: [], ranges: [], lists: [], opened: [] };
  const electron = {
    app: { getPath: () => dir, getVersion: () => '0.1.0' },
    powerMonitor: new EventEmitter(),
    safeStorage,
    shell: { openExternal: async (url) => { state.opened.push(url); } },
  };
  const settings = settingsStore();
  const feature = new TodomateFeature({
    electron,
    settings,
    fetch: playmcp(state),
    now: () => state.now,
    timers: TIMERS,
    askForPrompt: async () => {
      state.prompts++;
      return `mcp-gateway에 연결해 줘.

oneTimeToken: ${OTT}`;
    },
  });
  feature.on('change', (list) => state.lists.push(list));
  return { feature, settings, state, dir };
}

const TODOS = [
  { id: 't1', content: '13:00 프로젝트 미팅', goal_id: 'g1' },
  { id: 't2', content: '10:00 팀 미팅', goal_id: 'g1', is_done: true },
  { id: 't3', content: '서류 발급', goal_id: 'g2' },
];

test('turning it on asks once for a connection prompt, then shows the timed Schedule items', async (t) => {
  const { feature, settings, state, dir } = setUp(t, { todos: TODOS });
  await feature.setEnabled(true);
  await feature.checkNow();
  assert.equal(state.prompts, 1);
  assert.deepEqual(state.exchanges, [OTT]);
  assert.equal(settings.values.todomateEnabled, true);
  assert.deepEqual(state.lists.at(-1).map((b) => [b.badge, b.title, b.status]), [
    ['10:00', '팀 미팅', 'review'],
    ['13:00', '프로젝트 미팅', 'idle'],
  ]);
  // The tokens are on disk only encrypted.
  const saved = fs.readFileSync(path.join(dir, 'todomate-token.bin'));
  assert.ok(!saved.toString().includes('accessToken'));
  feature.stop();
});

test('another category from the menu redoes the bubbles without a new request', async (t) => {
  const { feature, settings, state } = setUp(t, { todos: [...TODOS, { id: 't4', content: '09:30 짐 챙기기', goal_id: 'g2' }] });
  await feature.setEnabled(true);
  await feature.checkNow();
  const categories = feature.menu().submenu.find((m) => m.label.startsWith('카테고리')).submenu;
  assert.deepEqual(categories.map((m) => m.label), ['Schedule', 'Logistics', 'D-Day']);
  categories[1].click();
  assert.equal(settings.values.todomateCategory, 'Logistics');
  assert.deepEqual(state.lists.at(-1).map((b) => b.title), ['짐 챙기기']);
  feature.stop();
});

test('a connection that stops working shows one bubble, and clicking it connects again', async (t) => {
  const { feature, state } = setUp(t, { todos: TODOS });
  await feature.setEnabled(true);
  await feature.checkNow();
  state.refuse = true;
  feature.client.close();
  feature.client = null;
  await feature.checkNow();
  const list = state.lists.at(-1);
  assert.equal(list[0].id, AUTH_ID);
  assert.equal(list[0].status, 'failed');
  state.refuse = false;
  assert.equal(feature.open(AUTH_ID), true);
  await feature.signingIn;
  await feature.inflight;
  assert.equal(state.prompts, 2);
  assert.ok(!state.lists.at(-1).some((b) => b.id === AUTH_ID));
  feature.stop();
});

test('turned off, it stops and clears its bubbles', async (t) => {
  const { feature, settings, state } = setUp(t, { todos: TODOS });
  await feature.setEnabled(true);
  await feature.checkNow();
  await feature.setEnabled(false);
  assert.equal(settings.values.todomateEnabled, false);
  assert.deepEqual(state.lists.at(-1), []);
});

test('a cancelled prompt, or one without a token, leaves it off', async (t) => {
  const { feature, settings, state } = setUp(t, { todos: TODOS });
  feature.askForPrompt = async () => null;
  await feature.setEnabled(true);
  assert.notEqual(settings.values.todomateEnabled, true);
  feature.askForPrompt = async () => 'nothing to see';
  await feature.setEnabled(true);
  assert.notEqual(settings.values.todomateEnabled, true);
  assert.match(feature.error, /연결 프롬프트가 없습니다/);
  assert.deepEqual(state.exchanges, []);
});

test('D-Day items from the last 30 days count down; a click clears one until the next morning, past a restart', async (t) => {
  const recent = [
    { id: 'd1', content: '11/6 저널클럽 발표', goal_id: 'g3', formattedDate: '2026-10-30' },
    { id: 'd2', content: '12/22 긴 발표', goal_id: 'g3', formattedDate: '2026-11-01' },
  ];
  const { feature, settings, state } = setUp(t, { todos: TODOS, recent });
  await feature.setEnabled(true);
  await feature.checkNow();
  assert.deepEqual(state.ranges, [{ start_year: 2026, start_month: 10, start_day: 5, end_year: 2026, end_month: 11, end_day: 2, limit: 2000 }]);
  const countdowns = () => state.lists.at(-1).filter((b) => b.id.startsWith('todomate:dday:')).map((b) => `${b.badge} ${b.title}`);
  assert.deepEqual(countdowns(), ['D-3 11/6(금) 저널클럽 발표', 'D-49 12/22(화) 긴 발표']);

  feature.dismiss('todomate:dday:2026-11-06:d1:2026-11-03');
  assert.deepEqual(countdowns(), ['D-49 12/22(화) 긴 발표']);
  assert.ok(settings.values.todomateHidden['todomate:dday:2026-11-06:d1:2026-11-03']);
  feature.stop();

  // The next morning it's back, as D-2.
  state.now = kst('2026-11-04T06:00:00');
  await feature.setEnabled(true);
  await feature.checkNow();
  assert.deepEqual(countdowns(), ['D-2 11/6(금) 저널클럽 발표', 'D-48 12/22(화) 긴 발표']);
  feature.stop();
});

test('a full range answer is asked for again in halves, so no D-Day item is cut off', async (t) => {
  const recent = [{ id: 'd1', content: '11/6 저널클럽 발표', goal_id: 'g3' }];
  const { feature, state } = setUp(t, { todos: TODOS, recent });
  state.capWide = true;
  await feature.setEnabled(true);
  await feature.checkNow();
  const spans = state.ranges.map((a) => `${a.start_month}/${a.start_day}-${a.end_month}/${a.end_day}`);
  assert.deepEqual(spans, ['10/5-11/2', '10/5-10/19', '10/5-10/12', '10/13-10/19', '10/20-11/2', '10/20-10/26', '10/27-11/2']);
  assert.ok(state.lists.at(-1).some((b) => b.id.startsWith('todomate:dday:2026-11-06:')));
  feature.stop();
});

// A bubble as the tests read it: a countdown by what it says, anything else by its id.
const said = (list) => list.map((b) => (b.id.startsWith('todomate:dday:') ? `${b.badge} ${b.title}` : b.id));

test('a day whose reads fail still counts down from the last good read, without its schedule', async (t) => {
  const recent = [{ id: 'd1', content: '11/6 저널클럽 발표', goal_id: 'g3', formattedDate: '2026-10-30' }];
  const { feature, state } = setUp(t, { todos: TODOS, recent });
  await feature.setEnabled(true);
  await feature.checkNow();
  const first = state.lists.at(-1);
  assert.deepEqual(said(first.filter((b) => b.id.startsWith('todomate:dday:'))), ['D-3 11/6(금) 저널클럽 발표']);
  assert.deepEqual(first.filter((b) => !b.id.startsWith('todomate:dday:')).map((b) => b.title), ['팀 미팅', '프로젝트 미팅']);

  // Overnight PlayMCP loses TodoMate; the next morning's reads find no TodoMate tools.
  state.noTool = true;
  feature.client.close();
  feature.client = null;
  state.now = kst('2026-11-04T06:00:00');
  await feature.checkNow();
  assert.deepEqual(said(state.lists.at(-1)), [TOOLBOX_ID, 'D-2 11/6(금) 저널클럽 발표']);
  const menu = feature.menu().submenu.map((m) => m.label);
  assert.ok(menu.includes('D-Day 1개 (마지막으로 읽은 목록)'));
  feature.stop();
});

test('a toolbox without TodoMate shows one bubble that opens the toolbox, until TodoMate is back', async (t) => {
  const { feature, state } = setUp(t, { todos: TODOS });
  await feature.setEnabled(true);
  await feature.checkNow();

  // A passing HTTP 500 isn't a lost link: no bubble for it.
  state.down = true;
  feature.client.close();
  feature.client = null;
  await feature.checkNow();
  assert.ok(!state.lists.at(-1).some((b) => b.id === TOOLBOX_ID));

  state.down = false;
  state.noTool = true;
  await feature.checkNow();
  const bubble = state.lists.at(-1).find((b) => b.id === TOOLBOX_ID);
  assert.equal(bubble.status, 'failed');
  assert.equal(bubble.badge, '연결 필요');
  assert.equal(feature.open(TOOLBOX_ID), true);
  assert.deepEqual(state.opened, [TOOLBOX_URL]);

  // × leaves it, and so does a 500 in between.
  feature.dismiss(TOOLBOX_ID);
  state.noTool = false;
  state.down = true;
  await feature.checkNow();
  assert.ok(state.lists.at(-1).some((b) => b.id === TOOLBOX_ID));

  // Linked again on the site: the next read works and the bubble goes.
  state.down = false;
  await feature.checkNow();
  assert.ok(!state.lists.at(-1).some((b) => b.id === TOOLBOX_ID));
  assert.ok(state.lists.at(-1).some((b) => b.title === '프로젝트 미팅'));
  feature.stop();
});
