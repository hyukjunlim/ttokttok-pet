'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { AccountManager, windowsOf, resetCreditsOf, STALE_MS } = require('../src/codex-accounts/manager');

function setup(t, count = 0, request) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-manager-'));
  let live = 0, maximum = 0;
  const clients = [];
  const manager = new AccountManager({ root, executable: () => 'fake-codex', now: () => 100_000,
    factory: () => {
      const rpc = new EventEmitter();
      live++; maximum = Math.max(maximum, live);
      rpc.initialize = async () => {};
      rpc.close = () => { if (!rpc.closed) { rpc.closed = true; live--; rpc.emit('closed'); } };
      rpc.request = async (method) => request ? request(method, rpc) : { rateLimits: { primary: { usedPercent: clients.length * 10, windowDurationMins: 300, resetsAt: 500 } } };
      clients.push(rpc); return rpc;
    } });
  manager.accounts = Array.from({ length: count }, (_, i) => ({ id: `a${i}`, label: `Account ${i}`, home: path.join(root, `a${i}`), enabled: true }));
  t.after(() => { manager.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  return { manager, clients, maximum: () => maximum, root };
}

test('usage preserves dynamic windows and does not fabricate unknown durations or reset times', () => {
  assert.deepEqual(windowsOf({ rateLimits: { primary: { usedPercent: 25 } } }), [
    { id: 'codex:primary', label: 'codex', slot: 'primary', usedPercent: 25, minutes: null, resetsAt: null },
  ]);
  const parsed = windowsOf({ rateLimitsByLimitId: { x: { primary: { usedPercent: 40 }, secondary: { usedPercent: 70, windowDurationMins: 10080 } }, y: { primary: { usedPercent: null } } } });
  assert.equal(parsed.length, 2);
  assert.equal(parsed[1].minutes, 10080);
});

test('banked reset counts remain authoritative when detail rows are capped', () => {
  const resets = resetCreditsOf({ rateLimitResetCredits: { availableCount: 4, credits: [
    { id: 'example-credit', status: 'available', grantedAt: 100, expiresAt: 300, title: 'Example reset' },
  ] } });
  assert.equal(resets.availableCount, 4);
  assert.equal(resets.credits.length, 1);
  assert.equal(resets.credits[0].grantedAt, 100_000);
  assert.equal(resets.credits[0].expiresAt, 300_000);
  assert.equal(resets.credits[0].expiryKnown, true);
  assert.equal(resets.credits[0].id, undefined);
});

test('banked resets distinguish unavailable, zero, count-only, and no-expiry data', () => {
  assert.equal(resetCreditsOf({}), null);
  assert.equal(resetCreditsOf({ rateLimitResetCredits: null }), null);
  assert.deepEqual(resetCreditsOf({ rateLimitResetCredits: { availableCount: 0, credits: [] } }), { availableCount: 0, credits: [] });
  assert.deepEqual(resetCreditsOf({ rateLimitResetCredits: { availableCount: 2, credits: null } }), { availableCount: 2, credits: null });
  const resets = resetCreditsOf({ rateLimitResetCredits: { availableCount: 2, credits: [{ expiresAt: null }, {}] } });
  assert.equal(resets.credits[0].expiryKnown, true);
  assert.equal(resets.credits[1].expiryKnown, false);
  assert.equal(resetCreditsOf({ rateLimitResetCredits: { availableCount: -1 } }), null);
});

test('zero, one and many accounts refresh independently through one bounded queue', async (t) => {
  for (const count of [0, 1, 7]) {
    const { manager, maximum } = setup(t, count);
    const first = manager.refresh();
    assert.equal(manager.refresh(), first);
    await first;
    assert.equal(manager.snapshot().accounts.length, count);
    assert.ok(maximum() <= 1);
    manager.snapshot().accounts.forEach((a, i) => assert.equal(a.windows[0].usedPercent, (i + 1) * 10));
    assert.equal(manager.snapshot().automaticSwitchingAvailable, false);
  }
});

test('failed refresh retains last reading with unavailable status; reset does not fabricate zero usage', async (t) => {
  let fail = false;
  const { manager } = setup(t, 1, () => {
    if (fail) throw new Error('secret-example');
    return { rateLimits: { primary: { usedPercent: 90, resetsAt: 101 } } };
  });
  await manager.refresh(); fail = true;
  manager.now = () => 100_000 + STALE_MS + 1;
  await manager.refresh();
  const a = manager.snapshot().accounts[0];
  assert.equal(a.status, 'unavailable');
  assert.equal(a.stale, true);
  assert.equal(a.windows[0].expired, true);
  assert.equal(a.windows[0].usedPercent, 90);
  assert.doesNotMatch(JSON.stringify(manager.snapshot()), /secret-example/);
});

test('paused accounts are not polled; disconnect logs out only the chosen store', async (t) => {
  const calls = [];
  const { manager, clients } = setup(t, 2, (method) => { calls.push(method); return {}; });
  manager.update('a0', { enabled: false });
  await manager.refresh();
  assert.equal(clients.length, 1);
  await manager.remove('a0');
  assert.ok(calls.includes('account/logout'));
  assert.deepEqual(manager.accounts.map((a) => a.id), ['a1']);
});

test('corrupt registry is preserved rather than silently replaced', (t) => {
  const { root } = setup(t);
  fs.writeFileSync(path.join(root, 'codex-accounts.json'), 'bad registry');
  const manager = new AccountManager({ root });
  assert.ok(manager.snapshot().error);
  assert.throws(() => manager.save());
  assert.equal(fs.readFileSync(manager.file, 'utf8'), 'bad registry');
});

test('simultaneous sign-in requests cannot create two credential flows', async (t) => {
  const { manager } = setup(t, 0, (method) => method === 'account/login/start'
    ? { verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'EXAMPLE-CODE' } : {});
  const first = manager.connect({ label: 'Example' });
  await assert.rejects(manager.connect({ label: 'Other' }), /Finish or cancel/);
  await first;
  assert.equal(manager.snapshot().pending.code, 'EXAMPLE-CODE');
  await manager.cancel();
  assert.equal(manager.snapshot().pending, null);
  assert.equal(manager.accounts.length, 0);
});

test('an unavailable account can be removed without claiming its credentials were cleared', async (t) => {
  const { manager } = setup(t, 1, () => { throw new Error('offline'); });
  await manager.remove('a0');
  assert.equal(manager.accounts.length, 0);
  assert.match(manager.snapshot().error, /could not clear/);
});

test('duplicate subscription stores do not produce two independent allowance readings', async (t) => {
  const { manager } = setup(t, 2, (method) => method === 'accountSession/list'
    ? { activeSessionId: 'example-login', sessions: [{ sessionId: 'example-login', userId: 'example-user', selectedWorkspaceAccountId: 'example-workspace' }] }
    : { rateLimits: { primary: { usedPercent: 30 } } });
  await manager.refresh();
  const accounts = manager.snapshot().accounts;
  assert.equal(accounts[0].status, 'ready');
  assert.equal(accounts[1].status, 'duplicate');
  assert.equal(accounts[1].windows.length, 0);
  assert.doesNotMatch(fs.readFileSync(manager.file, 'utf8'), /example-user|example-workspace/);
});
