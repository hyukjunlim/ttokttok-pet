'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { pushEvents } = require('../src/phone/notify');
const { phoneView, openTarget, opensOf, openOfKind } = require('../src/phone/view');
const { PhoneFeature } = require('../src/phone/feature');
const { allowedHost } = require('../src/phone/server');
const { TAILSCALE_LINK } = require('../src/onboarding');
const { decrypt } = require('./push-decrypt');

// ---------------------------------------------------------------- what buzzes

test('nothing buzzes for what is already there; a session turning Ready, Needs you or Error does', () => {
  let { memory, events } = pushEvents(null, [
    { id: 'local_a', kind: 'desktop', status: 'review', since: 1, title: 'Old', project: 'p' },
    { id: 'etl:ann:1', kind: 'etl', badge: '새 공지', title: 'Old notice' },
  ], 1000);
  assert.deepEqual(events, []);
  ({ memory, events } = pushEvents(memory, [
    { id: 'local_a', kind: 'desktop', status: 'review', since: 1, title: 'Old', project: 'p' },
    { id: 'local_b', kind: 'desktop', status: 'running', since: 2, title: 'Working' },
    { id: 'codex:c', kind: 'codex', client: 'vscode', status: 'waiting', since: 3, title: 'Asks', project: 'q' },
    { id: 'cli:d', kind: 'cli', client: 'terminal', status: 'failed', since: 4, title: 'Broke' },
    { id: 'web:e', kind: 'web', siteName: 'ChatGPT', status: 'review', since: 5, title: 'Answer' },
  ], 2000));
  assert.deepEqual(events.map((e) => [e.id, e.title, e.body]), [
    ['codex:c', 'Needs you · Asks', 'Codex · VS Code · q'],
    ['cli:d', 'Error · Broke', 'Claude Code · Terminal'],
    ['web:e', 'Ready · Answer', 'ChatGPT'],
  ]);
  ({ memory, events } = pushEvents(memory, [{ id: 'local_b', kind: 'desktop', status: 'review', since: 9, title: 'Working', project: 'p' }], 3000));
  assert.deepEqual(events.map((e) => e.title), ['Ready · Working']);
  assert.equal(events[0].tag, 'local_b');
});

test('a session that drops out and comes back as it was doesn\'t buzz again; its next turn does', () => {
  const ready = { id: 'local_a', kind: 'desktop', status: 'review', since: 5, title: 'T' };
  let { memory } = pushEvents(null, [], 0);
  let events;
  ({ memory, events } = pushEvents(memory, [ready], 1));
  assert.equal(events.length, 1);
  ({ memory, events } = pushEvents(memory, [], 2));
  ({ memory, events } = pushEvents(memory, [ready], 3));
  assert.equal(events.length, 0);
  ({ memory, events } = pushEvents(memory, [{ ...ready, status: 'running', since: 6 }], 4));
  ({ memory, events } = pushEvents(memory, [{ ...ready, since: 7 }], 5));
  assert.equal(events.length, 1);
});

test('a session hidden from the sidebar doesn\'t buzz, nor for what it did while hidden once it\'s back', () => {
  const s = { id: 'codex:h', kind: 'codex', status: 'running', since: 1, title: 'H' };
  const hidden = new Set(['codex:h']);
  let { memory } = pushEvents(null, [s], 0);
  let events;
  ({ memory, events } = pushEvents(memory, [{ ...s, status: 'review', since: 500_000 }], 1, (s2) => hidden.has(s2.id)));
  assert.equal(events.length, 0);
  hidden.clear();
  ({ memory, events } = pushEvents(memory, [{ ...s, status: 'review', since: 500_000 }], 2, (s2) => hidden.has(s2.id)));
  assert.equal(events.length, 0);
  ({ memory, events } = pushEvents(memory, [{ ...s, status: 'running', since: 600_000 }], 3));
  ({ memory, events } = pushEvents(memory, [{ ...s, status: 'waiting', since: 700_000 }], 4));
  assert.deepEqual(events.map((e) => [e.title, e.kind]), [['Needs you · H', 'codex']]);
});

test('eTL: new notices, assignments, grades, deadline changes and 마감 임박 buzz; classes and handed-in work don\'t', () => {
  let { memory } = pushEvents(null, [{ id: 'etl:ann:1', kind: 'etl', badge: '새 공지', title: 'seen' }], 0);
  let events;
  ({ memory, events } = pushEvents(memory, [
    { id: 'etl:ann:1', kind: 'etl', badge: '새 공지', title: 'seen' },
    { id: 'etl:ann:2', kind: 'etl', badge: '휴강 공지', title: '휴강', project: '자료구조' },
    { id: 'etl:new:7', kind: 'etl', badge: '새 과제', title: 'HW3' },
    { id: 'etl:grade:7:90', kind: 'etl', badge: '성적', title: 'HW2' },
    { id: 'etl:due:7:123', kind: 'etl', badge: '마감 변경', title: 'HW3' },
    { id: 'etl:token', kind: 'etl', badge: '토큰 만료', title: 'token' },
    { id: 'etl:deadline:8', kind: 'etl', badge: '마감 임박', title: 'HW4' },
    { id: 'etl:deadline:9', kind: 'etl', badge: '제출함', title: 'HW5' },
    { id: 'etl:timetable:2026-10-28:10:00:정규:1', kind: 'etl', badge: '10:00', title: '자료구조' },
    { id: 'etl:connected', kind: 'etl', badge: 'eTL 연결됨', title: '마감 전 미제출 2건' },
    { id: 'etl:assistant', kind: 'etl', assistant: true, badge: 'eTL 비서', title: '물어보기' },
  ], 1));
  assert.deepEqual(events.map((e) => e.title), [
    '휴강 공지 · 휴강', '새 과제 · HW3', '성적 · HW2', '마감 변경 · HW3', '토큰 만료 · token', '마감 임박 · HW4',
  ]);
  assert.equal(events[0].body, '자료구조');
  ({ events } = pushEvents(memory, [{ id: 'etl:deadline:8', kind: 'etl', badge: '마감 임박', title: 'HW4' }], 2));
  assert.equal(events.length, 0, 'each notice once');
});

test('Slack: each presentation reminder and 순서 변경 buzz once; token and table trouble don\'t', () => {
  let { memory } = pushEvents(null, [], 0);
  let events;
  const d7 = { id: 'slack:remind:2026-11-10:짧은 발표 2:d7', kind: 'slack', status: 'review', badge: 'D-7', title: '11/10(화) 짧은 발표 2', project: '10:00-11:00 · 발표 순서' };
  ({ memory, events } = pushEvents(memory, [
    d7,
    { id: 'slack:change:2026-12-22:긴 발표:5', kind: 'slack', status: 'waiting', badge: '순서 변경', title: '12/22(화) 긴 발표', project: '빠짐' },
    { id: 'slack:token', kind: 'slack', status: 'waiting', badge: '토큰 확인', title: 'token' },
    { id: 'slack:format', kind: 'slack', status: 'failed', badge: '표 확인 필요', title: 'table' },
  ], 1));
  assert.deepEqual(events.map((e) => [e.title, e.body]), [
    ['D-7 · 11/10(화) 짧은 발표 2', '10:00-11:00 · 발표 순서'],
    ['순서 변경 · 12/22(화) 긴 발표', '빠짐'],
  ]);
  ({ memory, events } = pushEvents(memory, [d7], 2));
  assert.equal(events.length, 0, 'each reminder once');
  ({ events } = pushEvents(memory, [{ ...d7, id: d7.id.replace(':d7', ':d3'), badge: 'D-3' }], 3));
  assert.deepEqual(events.map((e) => e.title), ['D-3 · 11/10(화) 짧은 발표 2'], 'the next reminder buzzes again');
});

test("Slack's other days' D-X and TodoMate's D-Day countdowns buzz once each morning; TodoMate's trouble doesn't", () => {
  let { memory } = pushEvents(null, [], 0);
  let events;
  const daily = (day) => ({ id: `slack:daily:2026-12-22:긴 발표:${day}`, kind: 'slack', status: 'idle', badge: 'D-49', title: '12/22(화) 긴 발표' });
  const dday = (day) => ({ id: `todomate:dday:2026-11-06:t1:${day}`, kind: 'todomate', status: 'review', badge: 'D-3', title: '11/6(금) 저널클럽 발표', project: '' });
  ({ memory, events } = pushEvents(memory, [
    daily('2026-11-03'),
    dday('2026-11-03'),
    { id: 'todomate:auth', kind: 'todomate', status: 'waiting', badge: '연결 필요', title: 'PlayMCP' },
  ], 1));
  assert.deepEqual(events.map((e) => [e.title, e.body]), [
    ['D-49 · 12/22(화) 긴 발표', 'Slack'],
    ['D-3 · 11/6(금) 저널클럽 발표', '투두메이트'],
  ]);
  ({ memory, events } = pushEvents(memory, [daily('2026-11-03'), dday('2026-11-03')], 2));
  assert.equal(events.length, 0, 'once a day');
  ({ events } = pushEvents(memory, [daily('2026-11-04'), dday('2026-11-04')], 3));
  assert.equal(events.length, 2, 'and again the next morning');
});

test('a TodoMate schedule item buzzes once, 15 minutes before it starts', () => {
  const start = Date.parse('2026-11-05T13:00:00+09:00');
  const item = (startsAt, project) => ({ id: 'todomate:2026-11-05:t2', kind: 'todomate', status: 'review', badge: '13:00', title: '프로젝트 미팅', project, startsAt });
  const at = (min) => start - min * 60_000;
  let { memory, events } = pushEvents(null, [item(start, '16분 후')], at(16));
  assert.equal(events.length, 0, 'not yet');
  ({ memory, events } = pushEvents(memory, [item(start, '15분 후')], at(15)));
  assert.deepEqual(events.map((e) => [e.title, e.body, e.kind]), [['13:00 · 프로젝트 미팅', '15분 후', 'todomate']]);
  ({ memory, events } = pushEvents(memory, [item(start, '14분 후')], at(14)));
  assert.equal(events.length, 0, 'once');
  const later = start + 60 * 60_000;
  ({ memory, events } = pushEvents(memory, [item(later, '1시간 10분 후')], at(10)));
  assert.equal(events.length, 0, 'moved an hour later: not yet');
  ({ events } = pushEvents(memory, [item(later, '10분 후')], later - 10 * 60_000));
  assert.equal(events.length, 1, 'and buzzes before its new time');

  ({ events } = pushEvents(null, [item(start, '5분 후')], at(5)));
  assert.equal(events.length, 1, 'one about to start buzzes even when the companion just started');
  ({ events } = pushEvents(null, [item(start, '진행 중 · ~14:00')], start + 60_000));
  assert.equal(events.length, 0, 'one already under way doesn\'t');
});

test('a Slack notice opens its canvas in Slack, and nothing outside a workspace', () => {
  const canvas = 'https://team.slack.com/docs/T01EXAMPLE0/F01EXAMPLE0';
  const view = phoneView({
    notices: [
      { id: 'slack:remind:a:d7', kind: 'slack', status: 'review', badge: 'D-7', title: 'a', url: canvas },
      { id: 'slack:remind:b:d7', kind: 'slack', status: 'review', badge: 'D-7', title: 'b', url: 'https://evil.example/docs/x' },
    ],
  });
  assert.deepEqual(view.notices.map((n) => n.open), [{ app: 'slack', url: canvas }, { app: 'slack', url: null }]);
});

// ---------------------------------------------------------------- what the phone shows

test('a tap opens the app: Claude Code at its Remote Control session, Codex in ChatGPT, a web chat at its conversation', () => {
  assert.deepEqual(openTarget('claude'), { app: 'claude', url: 'https://claude.ai/code' });
  assert.deepEqual(openTarget('claude', 'https://claude.ai/code/session_01AbCdEfGhIjKlMnOpQrStUv'), { app: 'claude', url: 'https://claude.ai/code/session_01AbCdEfGhIjKlMnOpQrStUv' });
  assert.deepEqual(openTarget('vscode', 'https://claude.ai/code/session_01AbCdEfGhIjKlMnOpQrStUv').url, 'https://claude.ai/code/session_01AbCdEfGhIjKlMnOpQrStUv');
  assert.deepEqual(openTarget('claude', 'https://claude.ai/code/../settings'), { app: 'claude', url: 'https://claude.ai/code' }, 'only a session\'s address');
  assert.deepEqual(openTarget('terminal'), { app: 'claude', url: 'https://claude.ai/code' });
  assert.deepEqual(openTarget('codex-vscode'), { app: 'chatgpt', url: 'https://chatgpt.com/codex' });
  assert.deepEqual(openTarget('chatgpt', 'https://chatgpt.com/c/abc'), { app: 'chatgpt', url: 'https://chatgpt.com/c/abc' });
  assert.deepEqual(openTarget('claude-web', 'https://evil.example/x'), { app: 'claude', url: 'https://claude.ai/' });
  assert.deepEqual(openTarget('gemini'), { app: 'gemini', url: 'https://gemini.google.com/app' });
});

test('the view keeps the tree, drops the eTL assistant, and sends eTL notices to LearningX', () => {
  const s = (id, app, extra = {}) => ({ id, app, title: id, status: 'review', detail: '', since: 1, lastActivityAt: 2, ...extra });
  const view = phoneView({
    hosts: [
      { key: 'chat', kind: 'chat', label: 'Chat', attention: 1, busy: 0, folders: [], loose: [s('web:1', 'chatgpt', { siteName: 'ChatGPT' })] },
      {
        key: 'pc', kind: 'pc', label: 'Local', attention: 1, busy: 0, loose: [],
        folders: [{ key: 'pc|c:', label: 'C:\\pet', path: 'C:\\pet', open: true, attention: 1, busy: 0, sessions: [s('local_1', 'claude')], children: [] }],
      },
    ],
    notices: [
      { id: 'etl:ann:1', kind: 'etl', status: 'review', badge: '새 공지', title: '공지', project: '자료구조', url: 'https://myetl.snu.ac.kr/courses/1/discussion_topics/2' },
      { id: 'etl:token', kind: 'etl', status: 'waiting', badge: '토큰 만료', title: '토큰', url: 'https://myetl.snu.ac.kr/profile/settings' },
      { id: 'etl:x', kind: 'etl', status: 'review', badge: '새 과제', title: 'x', url: 'https://elsewhere.example/' },
      { id: 'etl:assistant', kind: 'etl', assistant: true, status: 'background', title: '물어보기' },
    ],
    usage: [{ app: 'claude', name: 'Claude', percent: 42, elapsed: 55, resetsIn: '3d', age: null, extra: 'dropped' }],
    linkOf: (id) => ({ 'web:1': 'https://chatgpt.com/c/1', local_1: 'https://claude.ai/code/session_01AbCdEfGhIjKlMn' })[id] ?? null,
  });
  assert.equal(view.hosts[0].loose[0].open.url, 'https://chatgpt.com/c/1');
  assert.equal(view.hosts[1].folders[0].sessions[0].open.url, 'https://claude.ai/code/session_01AbCdEfGhIjKlMn');
  assert.deepEqual(view.notices.map((n) => n.id), ['etl:ann:1', 'etl:token', 'etl:x']);
  assert.deepEqual(view.notices[0].open, { app: 'learningx', url: 'https://myetl.snu.ac.kr/courses/1/discussion_topics/2' });
  assert.equal(view.notices[2].open.url, 'https://myetl.snu.ac.kr/', 'a link outside eTL goes to eTL\'s front page');
  assert.deepEqual(view.usage, [{ app: 'claude', name: 'Claude', percent: 42, elapsed: 55, resetsIn: '3d', age: null }]);

  const opens = opensOf(view);
  assert.deepEqual(opens.get('local_1'), { app: 'claude', url: 'https://claude.ai/code/session_01AbCdEfGhIjKlMn' });
  assert.deepEqual(opens.get('web:1'), { app: 'chatgpt', url: 'https://chatgpt.com/c/1' });
  assert.deepEqual(opens.get('etl:ann:1'), { app: 'learningx', url: 'https://myetl.snu.ac.kr/courses/1/discussion_topics/2' });
  assert.equal(opens.has('etl:assistant'), false);
});

test('a notification without a row opens its kind\'s app, or the page', () => {
  assert.deepEqual(openOfKind('codex'), { app: 'chatgpt', url: 'https://chatgpt.com/codex' });
  assert.deepEqual(openOfKind('cli'), { app: 'claude', url: 'https://claude.ai/code' });
  assert.deepEqual(openOfKind('desktop'), { app: 'claude', url: 'https://claude.ai/code' });
  assert.equal(openOfKind('etl').app, 'learningx');
  assert.equal(openOfKind('web'), null);
  assert.equal(openOfKind('practice'), null);
});

test('only this PC and its tailnet name may ask', () => {
  assert.ok(allowedHost('127.0.0.1:47823'));
  assert.ok(allowedHost('localhost:47823'));
  assert.ok(allowedHost('desktop-pc.tail1234.ts.net'));
  assert.ok(allowedHost('desktop-pc.tail1234.ts.net:443'));
  assert.ok(!allowedHost('evil.example.com'));
  assert.ok(!allowedHost('ts.net.evil.example.com'));
  assert.ok(!allowedHost('192.168.0.10:47823'));
  assert.ok(!allowedHost(undefined));
});

// ---------------------------------------------------------------- the server, end to end

function fakePush() {
  const sent = [];
  const request = (url, opts, onResponse) => {
    const req = new EventEmitter();
    req.end = (body) => {
      sent.push({ url: String(url), headers: opts.headers, body });
      const res = new EventEmitter();
      res.statusCode = 201;
      res.resume = () => {};
      onResponse(res);
      res.emit('end');
    };
    req.destroy = () => {};
    return req;
  };
  return { request, sent };
}

async function running(t, snapshot = () => ({})) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-'));
  const data = { phone: true };
  const settings = { get: (k) => data[k], set: (p) => Object.assign(data, p) };
  const push = fakePush();
  const f = new PhoneFeature({ electron: {}, settings, userData: dir, snapshot, port: 0, request: push.request });
  await f.start();
  t.after(() => f.stop());
  return { f, dir, push, port: f.listening };
}

function call(port, { method = 'GET', path: p = '/', host = `127.0.0.1:${port}`, origin, cookie, body, etag } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { Host: host };
    if (origin) headers.Origin = origin;
    if (cookie) headers.Cookie = cookie;
    if (etag) headers['If-None-Match'] = etag;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

// A phone's subscription, and how that phone reads what's pushed to it.
function phoneSubscription() {
  const ua = crypto.createECDH('prime256v1');
  ua.generateKeys();
  const auth = crypto.randomBytes(16);
  const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/xyz', keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } };
  return { sub, read: (body) => JSON.parse(decrypt(body, { uaPrivate: ua.getPrivateKey(), uaPublic: ua.getPublicKey(), auth })) };
}

const subscription = () => phoneSubscription().sub;

test('the page is served; data only to a paired phone, and only from this PC or the tailnet', async (t) => {
  const { f, port } = await running(t, () => ({ hosts: [], notices: [], usage: [{ app: 'claude', name: 'Claude', percent: 10 }] }));
  const page = await call(port);
  assert.equal(page.status, 200);
  assert.match(page.text, /<title>Ttokttok Pet<\/title>/);
  assert.match(page.headers['content-security-policy'], /default-src 'self'/);
  assert.equal((await call(port, { host: 'attacker.example' })).status, 421);
  assert.equal((await call(port, { path: '/api/state' })).status, 401);

  const origin = `http://127.0.0.1:${port}`;
  assert.equal((await call(port, { method: 'POST', path: '/api/pair', body: { code: '000000' } })).status, 403, 'no Origin, no change');
  assert.equal((await call(port, { method: 'POST', path: '/api/pair', origin, body: { code: '123456' } })).status, 403, 'no code asked for yet');

  const code = f.newCode();
  const paired = await call(port, { method: 'POST', path: '/api/pair', origin, body: { code: `${code.slice(0, 3)} ${code.slice(3)}`, name: 'iPhone' } });
  assert.equal(paired.status, 200);
  const cookie = paired.headers['set-cookie'][0].split(';')[0];
  assert.match(paired.headers['set-cookie'][0], /HttpOnly; SameSite=Strict/);
  assert.equal((await call(port, { method: 'POST', path: '/api/pair', origin, body: { code } })).status, 403, 'a code works once');

  f.changed();
  await new Promise((r) => setTimeout(r, 400));
  const state = await call(port, { path: '/api/state', cookie });
  assert.equal(state.status, 200);
  assert.equal(JSON.parse(state.text).usage[0].percent, 10);
  assert.equal((await call(port, { path: '/api/state', cookie, etag: state.headers.etag })).status, 304);
  assert.equal(f.devices[0].name, 'iPhone');
});

test('wrong codes use the code up', async (t) => {
  const { f, port } = await running(t);
  const origin = `http://127.0.0.1:${port}`;
  const code = f.newCode();
  const wrong = code === '000000' ? '111111' : '000000';
  for (let i = 0; i < 5; i++) assert.equal((await call(port, { method: 'POST', path: '/api/pair', origin, body: { code: wrong } })).status, 403);
  assert.equal((await call(port, { method: 'POST', path: '/api/pair', origin, body: { code } })).status, 403);
});

test('a paired phone subscribes, gets pushes for what turns Ready, and can unpair', async (t) => {
  const { f, dir, push, port } = await running(t);
  const origin = `http://127.0.0.1:${port}`;
  const code = f.newCode();
  const cookie = (await call(port, { method: 'POST', path: '/api/pair', origin, body: { code } })).headers['set-cookie'][0].split(';')[0];
  const key = JSON.parse((await call(port, { path: '/api/push-key', cookie })).text);
  assert.equal(Buffer.from(key.key, 'base64url').length, 65);
  assert.equal(key.subscribed, false);
  assert.equal((await call(port, { method: 'POST', path: '/api/push', origin, cookie, body: { subscription: { endpoint: 'https://evil.example/x', keys: {} } } })).status, 400);
  const sub = subscription();
  assert.equal((await call(port, { method: 'POST', path: '/api/push', origin, cookie, body: { subscription: sub } })).status, 200);

  const saved = fs.readFileSync(path.join(dir, 'phone.json'), 'utf8');
  assert.ok(!saved.includes(cookie.split('=')[1]), 'only the cookie\'s hash is kept');
  assert.equal(JSON.parse(saved).devices[0].subscription.endpoint, sub.endpoint);

  f.observe([{ id: 'local_a', kind: 'desktop', status: 'running', since: 1, title: 'Fix it' }]);
  f.observe([{ id: 'local_a', kind: 'desktop', status: 'review', since: 2, title: 'Fix it', project: 'pet' }]);
  await new Promise((r) => setImmediate(r));
  assert.equal(push.sent.length, 1);
  assert.equal(push.sent[0].url, sub.endpoint);
  assert.equal(push.sent[0].headers['Content-Encoding'], 'aes128gcm');

  assert.equal((await call(port, { method: 'POST', path: '/api/test-push', origin, cookie, body: {} })).status, 200);
  assert.equal(push.sent.length, 2);

  assert.equal((await call(port, { method: 'POST', path: '/api/unpair', origin, cookie, body: {} })).status, 200);
  assert.equal(f.devices.length, 0);
  assert.equal((await call(port, { path: '/api/state', cookie })).status, 401);
});

test('a notification opens what its row opens; a hidden session sends none', async (t) => {
  const row = { id: 'cli:a', app: 'terminal', title: 'A', status: 'review', since: 2 };
  const hosts = [{
    key: 'ssh:lab:22', kind: 'ssh', label: 'lab', attention: 1, busy: 0, loose: [],
    folders: [{ key: 'ssh:lab:22|~/p', label: '~/p', path: '~/p', open: true, attention: 1, busy: 0, sessions: [row], children: [] }],
  }];
  const link = 'https://claude.ai/code/session_01AbCdEfGhIjKlMn';
  const { f, push, port } = await running(t, () => ({ hosts, linkOf: (id) => (id === 'cli:a' ? link : null) }));
  const origin = `http://127.0.0.1:${port}`;
  const code = f.newCode();
  const cookie = (await call(port, { method: 'POST', path: '/api/pair', origin, body: { code } })).headers['set-cookie'][0].split(';')[0];
  const phone = phoneSubscription();
  await call(port, { method: 'POST', path: '/api/push', origin, cookie, body: { subscription: phone.sub } });

  const at = (status, since) => [
    { id: 'cli:a', kind: 'cli', client: 'terminal', status, since, title: 'A' },
    { id: 'codex:hidden', kind: 'codex', status, since, title: 'Hidden' },
    { id: 'codex:cloud', kind: 'codex', status, since, title: 'Cloud' },
  ];
  f.observe(at('running', 1), { 'codex:hidden': 1 });
  f.observe(at('review', 2), { 'codex:hidden': 1 });
  await new Promise((r) => setImmediate(r));
  const got = push.sent.map((p) => phone.read(p.body));
  assert.deepEqual(got.map((m) => [m.id, m.title, m.open]), [
    ['cli:a', 'Ready · A', { app: 'claude', url: link }],
    ['codex:cloud', 'Ready · Cloud', { app: 'chatgpt', url: 'https://chatgpt.com/codex' }],
  ]);
});

test('statuses turned off under Session notifications don\'t buzz; eTL notices and the other statuses still do', async (t) => {
  const { f, push, port } = await running(t);
  const origin = `http://127.0.0.1:${port}`;
  const code = f.newCode();
  const cookie = (await call(port, { method: 'POST', path: '/api/pair', origin, body: { code } })).headers['set-cookie'][0].split(';')[0];
  const phone = phoneSubscription();
  await call(port, { method: 'POST', path: '/api/push', origin, cookie, body: { subscription: phone.sub } });

  // Untick Ready in the tray menu.
  const checks = () => f.menu().submenu.find((i) => i.label === 'Notifications').submenu.filter((i) => i.type === 'checkbox');
  const sub = f.menu().submenu.find((i) => i.label === 'Notifications');
  assert.equal(sub.enabled, true);
  assert.deepEqual(checks().map((i) => i.checked), [true, true, true, true, true, true]);
  checks()[0].click({ checked: false });
  assert.deepEqual(checks().map((i) => i.checked), [false, true, true, true, true, true]);

  f.observe([{ id: 'cli:a', kind: 'cli', status: 'running', since: 1, title: 'A' }, { id: 'cli:b', kind: 'cli', status: 'running', since: 1, title: 'B' }]);
  f.observe([
    { id: 'cli:a', kind: 'cli', status: 'review', since: 2, title: 'A' },
    { id: 'cli:b', kind: 'cli', status: 'waiting', since: 2, title: 'B' },
    { id: 'etl:ann:9', kind: 'etl', badge: '새 공지', title: 'Notice' },
  ]);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(push.sent.map((p) => phone.read(p.body).title), ['Needs you · B', '새 공지 · Notice']);

  // Ticking it again doesn't buzz for the turn that finished while it was off.
  checks()[0].click({ checked: true });
  f.observe([{ id: 'cli:a', kind: 'cli', status: 'review', since: 2, title: 'A' }]);
  await new Promise((r) => setImmediate(r));
  assert.equal(push.sent.length, 2);
});

test('eTL, Slack and TodoMate notices each turn off on their own, and the list is looked at every minute', async (t) => {
  const { f, push, port } = await running(t);
  const origin = `http://127.0.0.1:${port}`;
  const code = f.newCode();
  const cookie = (await call(port, { method: 'POST', path: '/api/pair', origin, body: { code } })).headers['set-cookie'][0].split(';')[0];
  const phone = phoneSubscription();
  await call(port, { method: 'POST', path: '/api/push', origin, cookie, body: { subscription: phone.sub } });

  const todomate = f.menu().submenu.find((i) => i.label === 'Notifications').submenu.find((i) => i.label?.startsWith('투두메이트'));
  todomate.click({ checked: false });
  f.observe([]);
  assert.ok(f.clock, 'a clock while the companion runs');
  f.observe([
    { id: 'todomate:dday:2026-11-06:t1:2026-11-03', kind: 'todomate', status: 'review', badge: 'D-3', title: '저널클럽 발표' },
    { id: 'slack:daily:2026-12-22:긴 발표:2026-11-03', kind: 'slack', status: 'idle', badge: 'D-49', title: '긴 발표' },
    { id: 'etl:new:7', kind: 'etl', badge: '새 과제', title: 'HW3' },
  ]);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(push.sent.map((p) => phone.read(p.body).title), ['D-49 · 긴 발표', '새 과제 · HW3']);
  f.stop();
  assert.equal(f.clock, null, 'and none once it stops');
});

test('a sample eTL notice shows on the phone for a while and comes as a notification', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-'));
  const data = { phone: true };
  let clock = 1_000_000;
  const push = fakePush();
  const f = new PhoneFeature({
    electron: {},
    settings: { get: (k) => data[k], set: (p) => Object.assign(data, p) },
    userData: dir,
    port: 0,
    request: push.request,
    now: () => clock,
    snapshot: () => ({ notices: [{ id: 'etl:ann:1', kind: 'etl', status: 'review', badge: '새 공지', title: '공지', url: 'https://myetl.snu.ac.kr/courses/1/discussion_topics/2' }] }),
    sampleNotice: () => ({ title: 'HW3', project: '자료구조', url: 'https://myetl.snu.ac.kr/courses/7/assignments/8' }),
  });
  await f.start();
  t.after(() => f.stop());
  const origin = `http://127.0.0.1:${f.listening}`;
  const code = f.newCode();
  const cookie = (await call(f.listening, { method: 'POST', path: '/api/pair', origin, body: { code } })).headers['set-cookie'][0].split(';')[0];
  const phone = phoneSubscription();
  await call(f.listening, { method: 'POST', path: '/api/push', origin, cookie, body: { subscription: phone.sub } });

  const id = f.showSample();
  await new Promise((r) => setImmediate(r));
  const notices = JSON.parse((await call(f.listening, { path: '/api/state', cookie })).text).notices;
  assert.deepEqual(notices.map((n) => [n.id, n.badge, n.title]), [[id, '테스트', 'HW3'], ['etl:ann:1', '새 공지', '공지']]);
  assert.deepEqual(notices[0].open, { app: 'learningx', url: 'https://myetl.snu.ac.kr/courses/7/assignments/8' });
  assert.equal(push.sent.length, 1, 'and a notification for it');
  assert.deepEqual(phone.read(push.sent[0].body).open, notices[0].open, 'which opens the same');

  clock += 11 * 60_000;
  f.changed();
  await new Promise((r) => setTimeout(r, 400));
  const later = JSON.parse((await call(f.listening, { path: '/api/state', cookie })).text).notices;
  assert.deepEqual(later.map((n) => n.id), ['etl:ann:1'], 'gone after ten minutes');
});

// ---------------------------------------------------------------- Getting started's Phone step

// A stand-in for the tailscale CLI: `installed` false makes every call fail, as with none on PATH.
function fakeTailscale({ installed = true, running = true, serveError = null } = {}) {
  const calls = [];
  let served = false;
  const execFileFn = (exe, args, opts, cb) => {
    calls.push(args.join(' '));
    if (!installed) return cb(Object.assign(new Error('spawn tailscale ENOENT'), { code: 'ENOENT' }), '', '');
    if (args[0] === 'version') return cb(null, '1.90.0\n', '');
    if (args[0] === 'status') return cb(null, JSON.stringify({ BackendState: running ? 'Running' : 'NeedsLogin', Self: { DNSName: running ? 'desktop-pc.tail1234.ts.net.' : '' } }), '');
    if (args[0] === 'serve' && args[1] === 'status') return cb(null, served ? '{"Web":{"desktop-pc.tail1234.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:47823"}}}}}' : '{}', '');
    if (args[0] === 'serve' && args[1] === '--bg') {
      if (serveError) return cb(new Error('exit 1'), '', serveError);
      served = true;
      return cb(null, 'Available within your tailnet\n', '');
    }
    return cb(new Error(`unexpected: ${args.join(' ')}`), '', '');
  };
  return { execFileFn, calls };
}

// `port` 47823 is only named to Tailscale here, never listened on; 0 listens on any free one.
function setupFeature(t, tailscale, { port = 47823, on = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-'));
  const data = { phone: on };
  const f = new PhoneFeature({
    electron: {},   // no dialogs: the step must never open one
    settings: { get: (k) => data[k], set: (p) => Object.assign(data, p) },
    userData: dir,
    port,
    env: {},
    execFileFn: tailscale.execFileFn,
  });
  let events = 0;
  f.on('setup', () => events++);
  t.after(() => f.stop());
  return { f, events: () => events };
}

test('the Phone step: no Tailscale says so, and nothing opens a dialog', async (t) => {
  const { f } = setupFeature(t, fakeTailscale({ installed: false }), { port: 0, on: false });
  await f.setEnabled(true, { quiet: true });
  await f.checkSetup();
  const s = f.setupState();
  assert.equal(s.on, true);
  assert.equal(s.serving, true);
  assert.deepEqual(s.tailscale, { installed: false, running: false, name: null, served: false });
  assert.equal(s.address, null);
  assert.equal(s.busy, null);
});

test('the Phone step: signed in, Serve set up, a code, then a paired phone', async (t) => {
  const tailscale = fakeTailscale();
  const { f, events } = setupFeature(t, tailscale);
  await f.checkSetup();
  let s = f.setupState();
  assert.deepEqual(s.tailscale, { installed: true, running: true, name: 'desktop-pc.tail1234.ts.net', served: false });
  assert.equal(s.address, 'https://desktop-pc.tail1234.ts.net/');

  await f.serveForSetup();
  assert.ok(tailscale.calls.includes('serve --bg http://127.0.0.1:47823'));
  s = f.setupState();
  assert.equal(s.tailscale.served, true);
  assert.equal(s.error, null);

  const code = f.codeForSetup();
  assert.equal(f.setupState().code, code);
  assert.equal(f.api().pair({ code, name: 'Galaxy' }) != null, true);
  s = f.setupState();
  assert.equal(s.code, null, 'a code works once');
  assert.equal(s.paired, 1);
  assert.equal(s.notifying, 0);
  assert.ok(events() >= 5, 'the page draws again as each part changes');
});

test('the Phone step: when Serve won\'t start, what Tailscale said is kept for the page', async (t) => {
  const said = 'Serve is not enabled on your tailnet.\nTo enable, visit:\n\n         https://login.tailscale.com/f/serve?node=n123\n';
  const { f } = setupFeature(t, fakeTailscale({ serveError: said }));
  await f.serveForSetup();
  const s = f.setupState();
  assert.match(s.error, /Serve is not enabled/);
  assert.match(s.error, /https:\/\/login\.tailscale\.com\/f\/serve\?node=n123/);
  assert.equal(s.tailscale.served, false);
  assert.equal(s.busy, null);
});

test('the Phone step opens Tailscale\'s pages and nothing else', () => {
  assert.ok(TAILSCALE_LINK.test('https://tailscale.com/download'));
  assert.ok(TAILSCALE_LINK.test('https://login.tailscale.com/admin/dns'));
  assert.ok(TAILSCALE_LINK.test('https://login.tailscale.com/f/serve?node=n123'));
  assert.ok(!TAILSCALE_LINK.test('https://login.tailscale.com.evil.example/x'));
  assert.ok(!TAILSCALE_LINK.test('http://tailscale.com/download'));
  assert.ok(!TAILSCALE_LINK.test('https://evil.example/?https://tailscale.com/'));
  assert.ok(!TAILSCALE_LINK.test('https://tailscale.com/download extra'));
});

test('off: nothing listens and nothing is written', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-'));
  const settings = { get: () => undefined, set() {} };
  const f = new PhoneFeature({ electron: {}, settings, userData: dir, port: 0 });
  await f.start();
  f.menu();
  f.observe([{ id: 'local_a', kind: 'desktop', status: 'review', since: 1, title: 'x' }]);
  assert.equal(f.server, null);
  assert.ok(!fs.existsSync(path.join(dir, 'phone.json')));
});
