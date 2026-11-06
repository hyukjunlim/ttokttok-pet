'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { TargetAccounts, runTarget, targetError } = require('../src/codex-accounts/targets');
const ACCOUNT = { id: 'example', identity: 'a'.repeat(64) };

test('Apply targets both fixed hosts and does not commit until both are ready', async () => {
  const calls = [];
  const targets = new TargetAccounts({ run: async (host, op, identity, options) => {
    calls.push([host, op]);
    if (op === 'status') return { ready: false };
    if (op === 'enroll') { options.onLogin({ target: host, url: 'https://auth.openai.com/codex/device', code: 'EXAMPLE' }); return { ready: true }; }
    return { applied: true, current: identity };
  } });
  targets.begin(ACCOUNT);
  assert.throws(() => targets.begin(ACCOUNT));
  await targets.task;
  assert.deepEqual(calls, [['WSL', 'status'], ['micc-beta', 'status'], ['WSL', 'enroll'], ['micc-beta', 'enroll'], ['WSL', 'apply'], ['micc-beta', 'apply']]);
  assert.equal(targets.snapshot().phase, 'done');
  assert.equal(targets.snapshot().busy, false);
  assert.equal(targets.snapshot().pending, null);
});

test('offline preflight does not change the reachable host', async () => {
  const calls = [];
  const targets = new TargetAccounts({ run: async (host, op) => {
    calls.push(op);
    if (host === 'micc-beta') throw new Error('Offline');
    return { ready: true };
  } });
  targets.begin(ACCOUNT); await targets.task;
  assert.deepEqual(calls, ['status', 'status']);
  assert.equal(targets.snapshot().phase, 'failed');
});

test('a failure on the first target marks the unvisited target as not checked', async () => {
  const calls = [];
  const targets = new TargetAccounts({ run: async (host) => { calls.push(host); throw new Error('Blocked'); } });
  targets.begin(ACCOUNT); await targets.task;
  assert.deepEqual(calls, ['WSL']);
  assert.equal(targets.snapshot().targets['micc-beta'].status, 'not_checked');
});

test('blocking-process errors expose only validated PID, version and client fields', () => {
  const error = targetError({ error: 'unknown_running_version', blockers: [
    { pid: 1234, version: '0.164.0-alpha.1', client: 'VS Code extension', token: 'example-secret' },
    { pid: 5678, version: '0.159.2', client: 'Codex' },
    { pid: 9999, version: 'example-secret', client: 'Codex' },
  ] });
  assert.match(error, /PID 1234, version 0\.164\.0-alpha\.1/);
  assert.match(error, /PID 5678, version 0\.159\.2/);
  assert.doesNotMatch(error, /example-secret/);
});

test('a failed second commit reports partial success rather than both applied', async () => {
  const current = {};
  const targets = new TargetAccounts({ run: async (host, op, identity) => {
    if (op === 'status' || op === 'inspect') return { ready: true, current: current[host] || null };
    if (host === 'micc-beta') throw new Error('Connection lost');
    current[host] = identity;
    return { applied: true, current: identity };
  } });
  targets.begin(ACCOUNT); await targets.task;
  assert.equal(targets.snapshot().phase, 'partial');
  assert.equal(targets.snapshot().targets.WSL.status, 'applied');
  assert.equal(targets.snapshot().targets['micc-beta'].status, 'not_applied');
});

test('lost response after commit is reconciled against actual target selection', async () => {
  const current = {};
  const targets = new TargetAccounts({ run: async (host, op, identity) => {
    if (op === 'status' || op === 'inspect') return { ready: true, current: current[host] || null };
    current[host] = identity;
    throw new Error('Response lost after write');
  } });
  targets.begin(ACCOUNT); await targets.task;
  assert.equal(targets.snapshot().targets.WSL.status, 'applied');
  assert.equal(targets.snapshot().targets['micc-beta'].status, 'not_applied');
  assert.equal(targets.snapshot().phase, 'partial');
});

test('a target returning another account is not reported as applied', async () => {
  const targets = new TargetAccounts({ run: async (_host, op) => op === 'status' ? { ready: true } : { applied: true, current: 'b'.repeat(64) } });
  targets.begin(ACCOUNT); await targets.task;
  assert.equal(targets.snapshot().phase, 'failed');
});

test('bridge sends only fingerprint and action and validates target sign-in links', async () => {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {};
  let input = ''; child.stdin.on('data', (chunk) => { input += chunk; });
  let argv;
  const result = runTarget('micc-beta', 'enroll', ACCOUNT.identity, { spawnFn: (cmd, args) => { argv = [cmd, ...args]; return child; } });
  child.stdout.write(JSON.stringify({ event: 'login', url: 'https://example.com', code: 'EXAMPLE' }) + '\n');
  await assert.rejects(result, /Invalid target sign-in/);
  child.emit('close');
  assert.equal(argv[0], 'wsl.exe');
  assert.ok(argv.includes('micc-beta'));
  assert.ok(argv.includes('ClearAllForwardings=yes'));
  assert.deepEqual(JSON.parse(input.split('\n')[1]), { operation: 'enroll', identity: ACCOUNT.identity });
});

test('applied state is read from both targets without running apply preflight or switching', async () => {
  const calls = [];
  let now = 1000;
  const targets = new TargetAccounts({ now: () => now, run: async (host, op) => {
    calls.push([host, op]); return { current: ACCOUNT.identity };
  } });
  await targets.refreshStatus();
  assert.deepEqual(calls, [['WSL', 'inspect'], ['micc-beta', 'inspect']]);
  assert.equal(targets.currentAccounts([ACCOUNT]).example.appliedEverywhere, true);
  now += 60_000;
  assert.equal(targets.currentAccounts([ACCOUNT]).example.appliedEverywhere, false);
});

test('a partial match or unreachable target does not disable Apply as already applied', async () => {
  for (const unreachable of [false, true]) {
    const targets = new TargetAccounts({ run: async (host) => {
      if (host === 'WSL') return { current: ACCOUNT.identity };
      if (unreachable) throw new Error('offline');
      return { current: 'b'.repeat(64) };
    } });
    await targets.refreshStatus();
    const state = targets.currentAccounts([ACCOUNT]).example;
    assert.equal(state.appliedEverywhere, false);
    assert.equal(state.targets.WSL.status, 'applied');
    assert.equal(state.targets['micc-beta'].status, unreachable ? 'unknown' : 'other');
  }
});

test('a delayed inspection cannot overwrite the verified result of an Apply', async () => {
  const finish = [];
  const targets = new TargetAccounts({ run: async (_host, op, identity) => {
    if (op === 'inspect') return new Promise((resolve) => finish.push(resolve));
    if (op === 'status') return { ready: true, current: null };
    return { applied: true, current: identity };
  } });
  const inspection = targets.refreshStatus();
  targets.begin(ACCOUNT); await targets.task;
  finish.forEach((resolve) => resolve({ current: 'b'.repeat(64) }));
  await inspection;
  assert.equal(targets.currentAccounts([ACCOUNT]).example.appliedEverywhere, true);
});
