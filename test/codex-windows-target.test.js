'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const {
  runWindowsTarget, Store, Problem, WindowsHelper, identity, readJson, atomicJson, codexExecutable, checkRunningWriters,
} = require('../src/codex-accounts/windows-target');
const { runTarget } = require('../src/codex-accounts/targets');
const { CodexRpc } = require('../src/codex-accounts/rpc');

function auth(name, revision = 1) {
  const claims = { 'https://api.openai.com/auth': { chatgpt_user_id: `example-user-${name}` } };
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return { auth_mode: 'chatgpt', OPENAI_API_KEY: null, tokens: {
    id_token: `example.${payload}.signature`, account_id: `example-workspace-${name}`,
    access_token: `example-access-${revision}`, refresh_token: `example-refresh-${name}${revision}` } };
}

// Locks in memory: a lock already held is busy, as for a second helper.
class MemoryLocker {
  constructor() { this.held = new Set(); this.log = []; }
  async lock(file) { if (this.held.has(file)) throw new Problem('busy'); this.held.add(file); this.log.push(file); }
  async unlock(file) { this.held.delete(file); }
  async confirm(files) { if (!files.every((f) => this.held.has(f))) throw new Problem('lock_failed'); }
}

function setup() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ttokttok-windows-target-'));
  const locker = new MemoryLocker();
  const store = new Store(path.join(base, 'codex'), path.join(base, 'pet'), { locker, env: {}, systemRequirements: path.join(base, 'none.toml') });
  const a = auth('a'); const b = auth('b');
  const ka = identity(a); const kb = identity(b);
  atomicJson(store.active, a);
  atomicJson(path.join(store.slot(kb), 'auth.json'), b);
  const history = path.join(store.home, 'sessions', 'example.jsonl');
  fs.mkdirSync(path.dirname(history), { recursive: true });
  fs.writeFileSync(history, 'example conversation');
  return { base, store, locker, a, b, ka, kb, history, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

test('identity matches target.py for the same login, so every host names a slot alike', () => {
  assert.equal(identity(auth('a')), 'c1a9351f5a3153f1b847725624695c66df408fe2b4a06fc748c7d2c525c16c3e');
  for (const bad of [null, {}, { ...auth('a'), auth_mode: 'apikey' }, { ...auth('a'), auth_mode: null }, { ...auth('a'), OPENAI_API_KEY: 'example-key' }]) {
    assert.throws(() => identity(bad), (e) => e.code === 'unsupported_auth');
  }
});

test('switch moves credentials, keeps conversations and releases every lock', async (t) => {
  const s = setup(); t.after(s.cleanup);
  const result = await s.store.commit(s.kb);
  assert.deepEqual(result, { current: s.kb, applied: true, unchanged: false });
  assert.deepEqual(readJson(s.store.active), s.b);
  assert.deepEqual(readJson(path.join(s.store.slot(s.ka), 'auth.json')), s.a);
  assert.equal(fs.existsSync(path.join(s.store.slot(s.kb), 'auth.json')), false);
  assert.equal(fs.readFileSync(s.history, 'utf8'), 'example conversation');
  assert.ok(s.locker.log.includes(path.join(s.store.home, 'auth.lock')));
  assert.ok(s.locker.log.includes(path.join(s.store.home, 'auth.json.lock')));
  assert.equal(s.locker.held.size, 0);
  assert.equal((await s.store.commit(s.kb)).unchanged, true);
  await s.store.commit(s.ka);
  assert.deepEqual(readJson(s.store.active), s.a);
});

test('a login refreshed during validation is archived, not a stale snapshot', async (t) => {
  const s = setup(); t.after(s.cleanup);
  const updated = auth('a', 2);
  await s.store.commit(s.kb, async () => atomicJson(s.store.active, updated));
  assert.deepEqual(readJson(path.join(s.store.slot(s.ka), 'auth.json')), updated);
});

test('failed validation or a blocking Codex changes neither login', async (t) => {
  const s = setup(); t.after(s.cleanup);
  await assert.rejects(s.store.commit(s.kb, async () => { throw new Problem('needs_login'); }));
  await assert.rejects(s.store.commit(s.kb, null, async () => { throw new Problem('unknown_running_version'); }));
  assert.deepEqual(readJson(s.store.active), s.a);
  assert.deepEqual(readJson(path.join(s.store.slot(s.kb), 'auth.json')), s.b);
  assert.equal(s.locker.held.size, 0);
});

test('a Codex holding the login lock makes the switch busy without changing anything', async (t) => {
  const s = setup(); t.after(s.cleanup);
  s.locker.held.add(path.join(s.store.home, 'auth.json.lock'));
  await assert.rejects(s.store.commit(s.kb), (e) => e.code === 'busy');
  assert.deepEqual(readJson(s.store.active), s.a);
});

test('an interrupted switch before the active write is undone on the next check', async (t) => {
  const s = setup(); t.after(s.cleanup);
  // As commit leaves it when the pet dies after writing the journal and the outgoing slot.
  atomicJson(s.store.journal, { before: s.a, after: s.b, previous_slot: null });
  atomicJson(path.join(s.store.slot(s.ka), 'auth.json'), s.a);
  await s.store.status(s.kb);
  assert.deepEqual(readJson(s.store.active), s.a);
  assert.equal(fs.existsSync(path.join(s.store.slot(s.ka), 'auth.json')), false);
  assert.equal(fs.existsSync(s.store.journal), false);
});

test('an interrupted switch after the active write is finished without duplicating the login', async (t) => {
  const s = setup(); t.after(s.cleanup);
  atomicJson(s.store.journal, { before: s.a, after: s.b, previous_slot: null });
  atomicJson(path.join(s.store.slot(s.ka), 'auth.json'), s.a);
  atomicJson(s.store.active, s.b);
  await s.store.status(s.kb);
  assert.equal(fs.existsSync(path.join(s.store.slot(s.kb), 'auth.json')), false);
  assert.deepEqual(readJson(path.join(s.store.slot(s.ka), 'auth.json')), s.a);
  assert.equal(fs.existsSync(s.store.journal), false);
});

test('recovery never overwrites a later login and keeps tokens refreshed after the switch', async (t) => {
  for (const later of [auth('c'), auth('b', 2)]) {
    const s = setup(); t.after(s.cleanup);
    atomicJson(s.store.journal, { before: s.a, after: s.b, previous_slot: null });
    atomicJson(s.store.active, later);
    await s.store.status(s.kb);
    assert.deepEqual(readJson(s.store.active), later);
    assert.deepEqual(readJson(path.join(s.store.slot(s.ka), 'auth.json')), s.a);
    assert.equal(fs.existsSync(s.store.journal), false);
  }
});

test('non-file, managed and environment logins are left alone', async (t) => {
  const s = setup(); t.after(s.cleanup);
  const config = path.join(s.store.home, 'config.toml');
  for (const [text, code] of [['cli_auth_credentials_store = "keyring"', 'unsupported_store'],
    ['model = "example"\ncli_auth_credentials_store = "file"\ncli_auth_credentials_store = "auto"', 'unsupported_store'],
    ['forced_login_method = "chatgpt"  # example', 'managed_auth'], ['"chatgpt_base_url" = \'https://example.com\'', 'managed_auth'],
    ['"cli_auth_credentials_stor\\u0065" = "keyring"', 'unsupported_store'], ['"forced_login_metho\\u0064" = "chatgpt"', 'managed_auth'],
    ['cli_auth_credentials_store = """file"""', 'unsupported_store'], ['"example\\q" = 1', 'invalid_config']]) {
    fs.writeFileSync(config, text);
    await assert.rejects(s.store.commit(s.kb), (e) => e.code === code, text);
  }
  fs.writeFileSync(config, 'cli_auth_credentials_store = "fil\\u0065" # example\nforced_login_method = ""\n[profiles.example]\nmodel = "a#b"\n');
  assert.equal((await s.store.status(s.kb)).ready, true);
  const env = new Store(s.store.home, s.store.root, { locker: s.locker, env: { CODEX_API_KEY: 'example-key' }, systemRequirements: path.join(s.base, 'none.toml') });
  await assert.rejects(env.commit(s.kb), (e) => e.code === 'environment_auth');
  fs.writeFileSync(path.join(s.base, 'requirements.toml'), '');
  const managed = new Store(s.store.home, s.store.root, { locker: s.locker, env: {}, systemRequirements: path.join(s.base, 'requirements.toml') });
  await assert.rejects(managed.commit(s.kb), (e) => e.code === 'managed_auth');
  assert.deepEqual(readJson(s.store.active), s.a);
});

test('invalid identities, wrong accounts in a slot and linked login files are refused', async (t) => {
  const s = setup(); t.after(s.cleanup);
  assert.throws(() => s.store.slot('../escape'), (e) => e.code === 'invalid_identity');
  atomicJson(path.join(s.store.slot(s.kb), 'auth.json'), s.a);
  assert.equal((await s.store.status(s.kb)).ready, false);
  await assert.rejects(s.store.commit(s.kb), (e) => e.code === 'wrong_account');
  assert.deepEqual(readJson(s.store.active), s.a);
  const link = path.join(s.base, 'link.json');
  try { fs.symlinkSync(s.store.active, link, 'file'); } catch { return; } // creating links needs Developer Mode on Windows
  assert.throws(() => readJson(link), (e) => e.code === 'unsafe_file');
});

test('inspect reads the current login without recovering or changing slots', async (t) => {
  const s = setup(); t.after(s.cleanup);
  const journal = { before: s.a, after: s.b, previous_slot: null };
  atomicJson(s.store.journal, journal);
  assert.deepEqual(await s.store.inspect(), { current: s.ka });
  assert.deepEqual(readJson(s.store.journal), journal);
});

test('this PC uses its own verified Codex and says when it cannot run or is another version', async () => {
  await assert.rejects(codexExecutable({ find: () => null }), (e) => e.code === 'codex_missing');
  await assert.rejects(codexExecutable({ find: () => 'codex.exe', version: async () => null }), (e) => e.code === 'codex_failed');
  await assert.rejects(codexExecutable({ find: () => 'codex.exe', version: async () => '0.170.0' }), (e) => e.code === 'unsupported_version' && e.version === '0.170.0');
  assert.equal(await codexExecutable({ find: () => 'codex.exe', version: async () => '0.167.0-alpha.3.2' }), 'codex.exe');
});

test('a running unverified Codex of this user blocks; verified ones and other users do not', async () => {
  const helper = (processes) => ({ processes: async () => processes });
  const version = async (file) => (file.includes('old') ? '0.159.2' : file.includes('broken') ? null : '0.167.0');
  await checkRunningWriters(helper([{ pid: 10, path: 'C:\\example\\codex.exe', mine: true }, { pid: 11, path: 'C:\\old\\codex.exe', mine: false }]), version);
  await assert.rejects(checkRunningWriters(helper([
    { pid: 12, path: 'C:\\example\\.vscode\\extensions\\old\\codex.exe', mine: true },
    { pid: 13, path: 'C:\\broken\\codex.exe', mine: null },
    { pid: 14, path: null, mine: null },
  ]), version), (e) => e.code === 'unknown_running_version' && JSON.stringify(e.blockers) === JSON.stringify([
    { pid: 12, version: '0.159.2', client: 'VS Code extension' },
    { pid: 13, version: 'unverified', client: 'Codex' },
    { pid: 14, version: 'unverified', client: 'Codex' },
  ]));
});

// A fake app-server: device-code sign-in writes `login` to the slot it was started in.
function fakeCodex(login, { exit = Promise.resolve() } = {}) {
  const started = [];
  const factory = ({ home, store }) => {
    const rpc = new EventEmitter();
    started.push({ home, store });
    rpc.closed = false;
    rpc.initialize = async () => {};
    rpc.close = () => { if (!rpc.closed) { rpc.closed = true; rpc.emit('closed'); } };
    rpc.shutdown = async () => { rpc.close(); await exit; };
    rpc.request = async (method) => {
      if (rpc.closed) throw new Error('Codex process is closed.');
      if (method === 'account/login/start') {
        setImmediate(() => {
          if (rpc.closed || !login) return;
          atomicJson(path.join(home, 'auth.json'), login);
          rpc.emit('notification', { method: 'account/login/completed', params: { success: true } });
        });
        return { verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'EXAMPLE' };
      }
      return {};
    };
    return rpc;
  };
  return { factory, started };
}

function deps(s, rpc, extra = {}) {
  return { home: s.store.home, root: s.store.root, env: {}, systemRequirements: path.join(s.base, 'none.toml'),
    helper: () => Object.assign(s.locker, { processes: async () => [], close() {} }),
    find: () => 'codex.exe', version: async () => '0.167.0', rpc: rpc.factory, ...extra };
}

test('Windows enrolls a new account through device sign-in, then applies it', async (t) => {
  const s = setup(); t.after(s.cleanup);
  const kc = identity(auth('c'));
  const codex = fakeCodex(auth('c'));
  const logins = [];
  assert.deepEqual(await runWindowsTarget('status', kc, { deps: deps(s, codex) }), { current: s.ka, ready: false });
  const enrolled = await runWindowsTarget('enroll', kc, { onLogin: (p) => logins.push(p), deps: deps(s, codex) });
  assert.deepEqual(logins, [{ target: 'Windows', url: 'https://auth.openai.com/codex/device', code: 'EXAMPLE' }]);
  assert.equal(enrolled.ready, true);
  assert.deepEqual(codex.started[0], { home: s.store.slot(kc), store: 'file' });
  const applied = await runWindowsTarget('apply', kc, { deps: deps(s, codex) });
  assert.deepEqual(applied, { current: kc, applied: true, unchanged: false });
  assert.deepEqual(readJson(s.store.active), auth('c'));
  assert.deepEqual(readJson(path.join(s.store.slot(s.ka), 'auth.json')), s.a);
});

test('signing in with another account on Windows clears that slot', async (t) => {
  const s = setup(); t.after(s.cleanup);
  const kc = identity(auth('c'));
  await assert.rejects(runWindowsTarget('enroll', kc, { deps: deps(s, fakeCodex(auth('d'))) }), (e) => e.code === 'wrong_account');
  assert.equal(fs.existsSync(path.join(s.store.slot(kc), 'auth.json')), false);
  assert.deepEqual(readJson(s.store.active), s.a);
});

test('cancelling a Windows sign-in stops Codex and changes nothing', async (t) => {
  const s = setup(); t.after(s.cleanup);
  const kc = identity(auth('c'));
  const codex = fakeCodex(null);
  const controller = new AbortController();
  const result = runWindowsTarget('enroll', kc, { signal: controller.signal, onLogin: () => controller.abort(), deps: deps(s, codex) });
  await assert.rejects(result, (e) => e.code === 'cancelled');
  assert.equal(codex.started.length, 1);
  assert.equal(fs.existsSync(path.join(s.store.slot(kc), 'auth.json')), false);
  assert.deepEqual(readJson(s.store.active), s.a);
  assert.equal(s.locker.held.size, 0);
});

test('cancelling waits for the Windows Codex to exit before releasing the slot locks', async (t) => {
  const s = setup(); t.after(s.cleanup);
  const kc = identity(auth('c'));
  let exited;
  const codex = fakeCodex(null, { exit: new Promise((resolve) => { exited = resolve; }) });
  const controller = new AbortController();
  let settled = false;
  const result = runWindowsTarget('enroll', kc, { signal: controller.signal, onLogin: () => controller.abort(), deps: deps(s, codex) })
    .finally(() => { settled = true; });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(settled, false);
  assert.ok(s.locker.held.has(s.store.slotsLock));
  exited();
  await assert.rejects(result, (e) => e.code === 'cancelled');
  assert.equal(s.locker.held.size, 0);
});

test('losing the lock helper during the running-Codex check stops the switch before it writes', async (t) => {
  const s = setup(); t.after(s.cleanup);
  fs.rmSync(s.store.active); // logged out: the switch would take no outgoing-slot lock
  let lost;
  let checks = 0;
  const extra = {
    helper: (onLost) => { lost = onLost; return Object.assign(s.locker, { processes: async () => [{ pid: 20, path: 'C:\\example\\codex.exe', mine: true }], close() {} }); },
    version: async (file) => {
      if (file.includes('example') && ++checks === 2) { s.locker.held.clear(); lost(); } // the helper dies; Windows frees its locks
      return '0.167.0';
    },
  };
  await assert.rejects(runWindowsTarget('apply', s.kb, { deps: deps(s, fakeCodex(null), extra) }), (e) => e.code === 'helper_failed');
  assert.equal(checks, 2);
  assert.equal(fs.existsSync(s.store.active), false);
  assert.deepEqual(readJson(path.join(s.store.slot(s.kb), 'auth.json')), s.b);
  assert.equal(fs.existsSync(s.store.journal), false);
});

test('CodexRpc.shutdown resolves only once Codex has exited, killing it after the grace period', async () => {
  const child = new EventEmitter();
  child.pid = 1234;
  child.stdin = { write() {}, end() {}, on() {} };
  child.stdout = new EventEmitter(); child.stdout.setEncoding = () => {};
  child.stderr = new EventEmitter();
  const kills = [];
  child.kill = (sig) => { kills.push(sig); setImmediate(() => child.emit('exit', null, sig)); };
  const rpc = new CodexRpc({ executable: 'codex', home: 'C:\\example', store: 'file', spawnFn: () => child });
  await rpc.shutdown(20);
  assert.deepEqual(kills, ['SIGKILL']);
  await rpc.shutdown(20); // already gone
  assert.deepEqual(kills, ['SIGKILL']);
});

test('runTarget sends Windows to this PC and reports its problems like the other hosts', async () => {
  const calls = [];
  const windows = async (operation, key) => { calls.push([operation, key]); throw new Problem('unsupported_version', { version: '0.170.0' }); };
  await assert.rejects(runTarget('Windows', 'status', 'a'.repeat(64), { windows }), /verified for Codex 0\.166–0\.167[\s\S]*Found: 0\.170\.0/);
  await assert.rejects(runTarget('Windows', 'inspect', null, { windows: async () => { throw new Error('C:\\Users\\example\\.codex\\auth.json: secret'); } }),
    (e) => !/secret|auth\.json/.test(e.message));
  assert.deepEqual(calls, [['status', 'a'.repeat(64)]]);
  assert.deepEqual(await runTarget('Windows', 'inspect', null, { windows: async () => ({ current: null, extra: 'x' }) }),
    { current: null, ready: false, applied: false, unchanged: false });
});

test('the PowerShell helper excludes a second holder until the lock is released', { skip: process.platform !== 'win32' }, async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ttokttok-windows-lock-'));
  const first = new WindowsHelper(); const second = new WindowsHelper();
  t.after(() => { first.close(); second.close(); fs.rmSync(base, { recursive: true, force: true }); });
  const file = path.join(base, 'auth.lock');
  await first.lock(file);
  const answer = await second.request({ op: 'lock', path: file, waitMs: 200 });
  assert.deepEqual(answer, { error: 'busy' });
  await first.unlock(file);
  await second.lock(file);
  await second.confirm([file]);
  await assert.rejects(first.confirm([file]), (e) => e.code === 'lock_failed');
  assert.ok(Array.isArray(await second.processes()));
});
