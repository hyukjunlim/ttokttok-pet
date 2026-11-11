'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const { CodexRpc } = require('../src/codex-accounts/rpc');
const { probe, probeSeparate } = require('../tools/codex-account-probe');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function transport() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const sent = [];
  child.stdin = new Writable({ write(chunk, _encoding, cb) { sent.push(JSON.parse(String(chunk))); cb(); } });
  child.stdin.on('finish', () => child.emit('close', 0));
  child.kill = () => child.emit('close', 0);
  return { child, sent };
}

test('RPC handles fragmented replies and never forwards remote error text', async () => {
  const { child, sent } = transport();
  const rpc = new CodexRpc({ executable: 'codex', home: '/private/test', spawnFn: () => child });
  const request = rpc.request('account/read');
  child.stdout.write('{"id":');
  child.stdout.write(`${sent[0].id},"result":{"account":null}}\n`);
  assert.deepEqual(await request, { account: null });
  const rejected = rpc.request('account/login/start');
  child.stdout.write(JSON.stringify({ id: sent[1].id, error: { code: -32000, message: 'secret-token-example' } }) + '\n');
  await assert.rejects(rejected, (error) => error.rpcCode === -32000 && !error.message.includes('secret-token'));
  rpc.close();
});

test('RPC times out and closes the process instead of leaving requests running', async () => {
  const { child } = transport();
  const rpc = new CodexRpc({ executable: 'codex', home: '/private/test', spawnFn: () => child, timeoutMs: 10 });
  await assert.rejects(rpc.request('account/read'), /timed out/);
  assert.equal(rpc.closed, true);
  assert.equal(rpc.pending.size, 0);
});

test('RPC pins OS credential storage and isolates CODEX_HOME', () => {
  const { child } = transport();
  let invocation;
  const rpc = new CodexRpc({ executable: 'codex', home: '/private/test', spawnFn: (...args) => { invocation = args; return child; } });
  assert.equal(invocation[2].env.CODEX_HOME, '/private/test');
  assert.ok(invocation[1].includes('cli_auth_credentials_store="keyring"'));
  rpc.close();
});

test('RPC rejects malformed JSON values without throwing in the data handler', async () => {
  const { child } = transport();
  const rpc = new CodexRpc({ executable: 'codex', home: '/private/test', spawnFn: () => child });
  const pending = rpc.request('account/read');
  child.stdout.write('null\n');
  await assert.rejects(pending, /closed/);
});

test('subscription monitor does not inherit API-key or custom-provider routing', () => {
  const keys = ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', 'OPENAI_BASE_URL'];
  const previous = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  try {
    for (const key of keys) process.env[key] = 'test-example';
    const { child } = transport();
    const rpc = new CodexRpc({ executable: 'codex', home: '/private/test', spawnFn: (_cmd, _args, options) => {
      for (const key of keys) assert.equal(options.env[key], undefined);
      return child;
    } });
    rpc.close();
  } finally { for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; } }
});

function scenario({ retain = true, shared = false } = {}) {
  let current = null;
  const sessions = [];
  const clients = [];
  const factory = () => {
    const client = new EventEmitter();
    client.selected = current;
    client.initialize = async () => {};
    client.close = () => { client.closed = true; };
    client.request = async (method, params) => {
      switch (method) {
        case 'account/login/start': {
          const n = sessions.length + 1;
          const session = { sessionId: `login-${n}`, selectedWorkspaceAccountId: `workspace-${n}` };
          sessions.push(session);
          current = client.selected = session.sessionId;
          setImmediate(() => client.emit('notification', { method: 'account/login/completed', params: { success: true } }));
          return { verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'EXAMPLE-CODE' };
        }
        case 'accountSession/list':
          return { activeSessionId: shared ? current : client.selected, sessions: retain ? sessions : sessions.slice(-1) };
        case 'account/rateLimits/read': return { rateLimits: { primary: { usedPercent: 20 } } };
        case 'accountSession/switch': current = client.selected = params.sessionId; return {};
        default: throw new Error('Unexpected method');
      }
    };
    clients.push(client);
    return client;
  };
  return { factory, clients };
}

test('probe accepts arbitrary account counts and distinguishes default from running selection', async () => {
  const { factory, clients } = scenario();
  const result = await probe({ executable: 'codex', home: '/private/test', count: 5, write() {}, factory });
  assert.equal(result.accountCount, 5);
  assert.equal(result.selectedLoginChanged, true);
  assert.equal(result.otherProcessSelectionUnchanged, true);
  assert.equal(result.defaultSelectionChanged, true);
  assert.equal(result.isolationVerified, false); // metadata is not inference proof
  assert.equal(result.conversationContinuityVerified, false);
  assert.ok(clients.every((c) => c.closed));
  assert.doesNotMatch(JSON.stringify(result), /login-|workspace-|EXAMPLE-CODE/);
});

test('probe detects switching that affects another running process', async () => {
  const result = await probe({ executable: 'codex', home: '/private/test', factory: scenario({ shared: true }).factory, write() {} });
  assert.equal(result.otherProcessSelectionUnchanged, false);
});

test('probe stops before switching when signing in replaces the previous saved login', async () => {
  const { factory, clients } = scenario({ retain: false });
  const result = await probe({ executable: 'codex', home: '/private/test', factory, write() {} });
  assert.equal(result.savedLoginsRetained, false);
  assert.equal(clients.length, 1);
  assert.equal(clients[0].closed, true);
});

test('probe requires two accounts for isolation testing, without restricting supported account count', async () => {
  for (const count of [0, 1, -1, 2.5, NaN]) {
    await assert.rejects(probe({ executable: 'codex', home: '/private/test', count }), /at least two/);
  }
});

test('probe rejects an incompatible executable before asking for sign-in', async () => {
  let loginRequested = false;
  let closed = false;
  await assert.rejects(probe({ executable: 'old-codex', home: '/private/test', factory: () => ({
    initialize: async () => {}, close: () => { closed = true; },
    request: async (method) => { if (method === 'account/login/start') loginRequested = true; throw new Error('Unsupported account-list method'); },
  }) }), /Unsupported/);
  assert.equal(loginRequested, false);
  assert.equal(closed, true);
});

test('probe reuses an existing test login after a failed attempt', async () => {
  const { factory } = scenario();
  const existing = factory();
  await existing.request('account/login/start');
  const output = [];
  const result = await probe({ executable: 'codex', home: '/private/test', reuseExisting: true, factory, write: (s) => output.push(s) });
  assert.equal(result.accountCount, 2);
  assert.equal(output.filter((s) => s.startsWith('Sign in to account')).length, 1);
  assert.ok(output.some((s) => s.startsWith('Sign in to account 2')));
});

test('separate stores support five independent account logins and usage reads', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-account-test-'));
  const homes = [];
  const clients = [];
  let reads = 0;
  try {
    const result = await probeSeparate({ executable: 'codex', home, count: 5, write() {}, factory: (options) => {
      homes.push(options.home);
      const ordinal = homes.length;
      const client = scenario().factory();
      const request = client.request;
      client.request = async (method, params) => {
        const result = await request(method, params);
        if (method === 'account/rateLimits/read') reads++;
        if (method === 'accountSession/list') return { ...result, sessions: result.sessions.map((s) => ({ ...s, selectedWorkspaceAccountId: `account-${ordinal}` })) };
        return result;
      };
      clients.push(client);
      return client;
    } });
    assert.equal(result.independentUsageVerified, true);
    assert.equal(result.conversationContinuityVerified, false);
    assert.equal(new Set(homes).size, 5);
    assert.equal(reads, 10);
    assert.ok(clients.every((c) => c.closed));
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
