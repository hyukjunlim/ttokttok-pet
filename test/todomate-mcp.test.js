'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { MCP_URL, TodomateAuthError, createClient, exchangeOneTimeToken, messageOf, oneTimeTokenOf, payloadOf, refreshTokens, toolNamed } = require('../src/todomate/mcp');

const NOW = Date.parse('2026-11-03T09:00:00+09:00');

function response(status, body, headers = {}) {
  const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (k) => h.get(k.toLowerCase()) ?? null },
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

// A stand-in for PlayMCP's gateway: answers initialize, tools/list and tools/call, and records
// every request.
function gateway({ tools, results, sse = false, refuseFirst = false }) {
  const calls = [];
  let refused = false;
  const fetch = async (url, init) => {
    const body = init.body && url === MCP_URL ? JSON.parse(init.body) : init.body;
    calls.push({ url, method: init.method, headers: init.headers, body });
    if (url.startsWith('https://playauth.kakao.com/playmcp/oauth2/token')) {
      return response(200, { access_token: 'fresh', refresh_token: 'r2', expires_in: 3600 });
    }
    if (url !== MCP_URL) throw new Error(`unexpected ${url}`);
    if (init.method === 'DELETE') return response(200, '');
    if (refuseFirst && !refused) {
      refused = true;
      return response(401, '');
    }
    if (!body.id) return response(202, '');
    let result;
    if (body.method === 'initialize') result = { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'playmcp' } };
    else if (body.method === 'tools/list') result = { tools };
    else if (body.method === 'tools/call') result = results[body.params.name];
    const msg = { jsonrpc: '2.0', id: body.id, result };
    return sse
      ? response(200, `event: message\ndata: ${JSON.stringify(msg)}\n\n`, { 'content-type': 'text/event-stream', 'mcp-session-id': 's1' })
      : response(200, msg, { 'content-type': 'application/json', 'mcp-session-id': 's1' });
  };
  return { fetch, calls };
}

const TOOLS = [
  { name: 'todomate_loadTodoItems', description: '투두메이트 사용자의 할 일 목록' },
  { name: 'todomate_loadTodoItemsByDateRange' },
  { name: 'todomate_addTodoItem' },
  { name: 'todomate_loadGoals' },
  { name: 'other_loadGoals', description: 'something else' },
];

test('toolNamed finds the gateway name of a TodoMate tool, not a longer one', () => {
  assert.equal(toolNamed(TOOLS, 'loadTodoItems'), 'todomate_loadTodoItems');
  assert.equal(toolNamed([{ name: 'loadGoals' }], 'loadGoals'), 'loadGoals');
  assert.equal(toolNamed([{ name: 'xloadGoals' }], 'loadGoals'), null);
  assert.equal(toolNamed([{ name: 'loadTodoItemsByDateRange' }], 'loadTodoItems'), null);
});

test('messageOf reads a JSON answer or an SSE stream', async () => {
  const msg = { jsonrpc: '2.0', id: 3, result: { ok: true } };
  assert.deepEqual(await messageOf(response(200, msg, { 'content-type': 'application/json' }), 3), msg);
  const stream = `event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\n\nevent: message\ndata: ${JSON.stringify(msg)}\n\n`;
  assert.deepEqual(await messageOf(response(200, stream, { 'content-type': 'text/event-stream' }), 3), msg);
});

test('payloadOf prefers structuredContent, parses JSON text, and reports a tool error', () => {
  assert.deepEqual(payloadOf({ structuredContent: { a: 1 }, content: [] }), { a: 1 });
  assert.deepEqual(payloadOf({ content: [{ type: 'text', text: '{"b":2}' }, { type: 'text', text: 'plain' }] }), [{ b: 2 }, 'plain']);
  assert.throws(() => payloadOf({ isError: true, content: [{ type: 'text', text: 'not linked' }] }), /not linked/);
});

test('the client connects once, calls only the read tools, and sends the session id', async () => {
  const items = { content: [{ type: 'text', text: JSON.stringify([{ id: 't1', content: '13:00 프로젝트 미팅' }]) }] };
  const { fetch, calls } = gateway({ tools: TOOLS, results: { todomate_loadTodoItems: items, todomate_loadGoals: { structuredContent: { goals: [] } } }, sse: true });
  let tokens = { accessToken: 'a1', refreshToken: 'r1', expiresAt: NOW + 3600_000, clientId: 'c1' };
  const client = createClient({ getTokens: () => tokens, saveTokens: (t) => { tokens = t; }, fetch, now: () => NOW });

  assert.deepEqual(await client.loadTodoItems({ year: 2026, month: 11, day: 3 }), [[{ id: 't1', content: '13:00 프로젝트 미팅' }]]);
  assert.deepEqual(await client.loadGoals(), { goals: [] });
  const methods = calls.map((c) => c.body?.method ?? c.method);
  assert.deepEqual(methods, ['initialize', 'notifications/initialized', 'tools/list', 'tools/call', 'tools/call']);
  const toolCalls = calls.filter((c) => c.body?.method === 'tools/call');
  assert.deepEqual(toolCalls.map((c) => c.body.params), [
    { name: 'todomate_loadTodoItems', arguments: { year: 2026, month: 11, day: 3, limit: 500 } },
    { name: 'todomate_loadGoals', arguments: {} },
  ]);
  assert.equal(calls[0].headers['Mcp-Session-Id'], undefined);
  assert.equal(calls[2].headers['Mcp-Session-Id'], 's1');
  assert.equal(calls[2].headers.Authorization, 'Bearer a1');
  await client.close();
  assert.equal(calls.at(-1).method, 'DELETE');
});

test('without TodoMate in the toolbox the client says so', async () => {
  const { fetch } = gateway({ tools: [{ name: 'kakaotalk_send' }], results: {} });
  const client = createClient({ getTokens: () => ({ accessToken: 'a1', expiresAt: null, clientId: 'c1' }), saveTokens() {}, fetch, now: () => NOW });
  await assert.rejects(client.loadTodoItems({ year: 2026, month: 11, day: 3 }), /도구함에 투두메이트가 없습니다/);
});

test('a refused token is refreshed once and the request sent again', async () => {
  const { fetch, calls } = gateway({ tools: TOOLS, results: { todomate_loadTodoItems: { structuredContent: [] } }, refuseFirst: true });
  let tokens = { accessToken: 'old', refreshToken: 'r1', expiresAt: NOW + 3600_000, clientId: 'c1' };
  const client = createClient({ getTokens: () => tokens, saveTokens: (t) => { tokens = t; }, fetch, now: () => NOW });
  await client.loadTodoItems({ year: 2026, month: 11, day: 3 });
  assert.equal(tokens.accessToken, 'fresh');
  assert.equal(tokens.refreshToken, 'r2');
  const refresh = calls.find((c) => c.url.includes('/oauth2/token'));
  assert.match(refresh.body, /grant_type=refresh_token/);
  assert.match(refresh.body, /client_id=c1/);
});

test('refreshTokens keeps tokens that are still good and gives up on a refused refresh', async () => {
  const good = { accessToken: 'a', refreshToken: 'r', expiresAt: NOW + 3600_000, clientId: 'c' };
  assert.equal(await refreshTokens(good, { fetch: () => assert.fail('no request'), now: NOW }), good);
  const expired = { ...good, expiresAt: NOW - 1 };
  const refuse = async () => response(400, { error: 'invalid_grant' });
  await assert.rejects(refreshTokens(expired, { fetch: refuse, now: NOW }), TodomateAuthError);
  await assert.rejects(refreshTokens({ ...expired, refreshToken: null }, { fetch: refuse, now: NOW }), TodomateAuthError);
});

test('oneTimeTokenOf takes the token from a pasted connection prompt, or the token alone', () => {
  const ott = 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';
  assert.equal(oneTimeTokenOf(`아래 oneTimeToken을 가지고 …에 연결해줘.

oneTimeToken: ${ott}
`), ott);
  assert.equal(oneTimeTokenOf(`  ${ott}  `), ott);
  assert.equal(oneTimeTokenOf('oneTimeToken: not-hex'), null);
  assert.equal(oneTimeTokenOf(''), null);
});

test('exchangeOneTimeToken trades the token as the guide says, and reports an expired one', async () => {
  const ott = 'ab'.repeat(32);
  let sent;
  const ok = async (url, init) => {
    sent = { url, body: JSON.parse(init.body) };
    return { status: 200, ok: true, json: async () => ({
      accessToken: { tokenValue: 'acc', expiresAt: '2026-11-03T22:59:09.067Z' },
      refreshToken: { tokenValue: 'ref', expiresAt: '2027-02-01T10:59:09.069Z' },
    }) };
  };
  const tokens = await exchangeOneTimeToken(ott, { fetch: ok });
  assert.equal(sent.url, 'https://playmcp.kakao.com/api/v1/auths/otts:exchange');
  assert.deepEqual(sent.body, { tokenValue: ott });
  assert.deepEqual(tokens, {
    accessToken: 'acc', refreshToken: 'ref', expiresAt: Date.parse('2026-11-03T22:59:09.067Z'),
    clientId: 'HElMUWdVoroTsrXxezeTSemg8gXzzCKWARb5MJux8gY',
  });
  const expired = async () => ({ status: 400, ok: false, json: async () => ({}) });
  await assert.rejects(exchangeOneTimeToken(ott, { fetch: expired }), /만료되었거나 이미 쓰였습니다/);
});
