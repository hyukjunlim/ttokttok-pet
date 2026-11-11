'use strict';
// This PC's Codex login slots: the Windows counterpart of target.py, run in the pet's own process.
// It keeps target.py's rules: switch only a file-based ChatGPT login, keep the outgoing login in its
// slot, journal the switch so an interrupted one is finished or undone, never overwrite a newer
// login, and refuse while an unverified Codex is running. Credentials never leave this PC.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { createHash, randomBytes } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { CodexRpc } = require('./rpc');
const { findCodex } = require('./locate');
const { asciiJson } = require('../ssh-watcher');

const VERIFIED = /^0\.(166|167)\./;
const LOCK_WAIT_MS = 10_000;
const MANAGED_KEYS = ['forced_login_method', 'forced_chatgpt_workspace_id', 'chatgpt_base_url'];

class Problem extends Error {
  constructor(code, { blockers = [], version = null } = {}) {
    super(code);
    this.code = code; this.blockers = blockers; this.version = version;
  }
}

// Python truthiness, as target.py tests JSON values with it: {} and [] count as missing.
const present = (v) => Array.isArray(v) ? v.length > 0 : v && typeof v === 'object' ? Object.keys(v).length > 0 : Boolean(v);

function identity(auth) {
  try {
    const tokens = auth.tokens;
    const part = tokens.id_token.split('.')[1];
    if (typeof part !== 'string') throw new Error();
    const claims = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    const user = claims?.['https://api.openai.com/auth']?.chatgpt_user_id ?? null;
    const account = tokens.account_id;
    if (typeof account !== 'string' || !account || typeof tokens.refresh_token !== 'string') throw new Error();
    if ((Object.hasOwn(auth, 'auth_mode') ? auth.auth_mode : 'chatgpt') !== 'chatgpt' || present(auth.OPENAI_API_KEY)) throw new Error();
    return createHash('sha256').update(JSON.stringify([user, account])).digest('hex');
  } catch { throw new Problem('unsupported_auth'); }
}

function readJson(file) {
  let info;
  try { info = fs.lstatSync(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  if (!info.isFile() || info.size > 2 * 1024 * 1024) throw new Problem('unsafe_file');
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  try { return JSON.parse(text); } catch { throw new Problem('invalid_store'); }
}

// Antivirus or a reader can hold the file for a moment; rename waits for it, briefly.
function replaceFile(from, to) {
  for (let attempt = 0; ; attempt++) {
    try { fs.renameSync(from, to); return; } catch (e) {
      if (attempt >= 20 || !['EPERM', 'EACCES', 'EBUSY'].includes(e.code)) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
}

function atomicJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.auth-${randomBytes(6).toString('hex')}`);
  try {
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try { fs.writeSync(fd, JSON.stringify(data)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    replaceFile(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
}

// Codex takes auth.lock, then auth.json.lock; both guard a login folder.
const authLocks = (dir) => [path.join(dir, 'auth.lock'), path.join(dir, 'auth.json.lock')];

// A TOML basic string's escapes (TOML 1.0 and 1.1); null if it has one TOML does not allow.
function unescapeBasic(text) {
  if (!/^(?:[^"\\]|\\(?:u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8}|x[0-9A-Fa-f]{2}|[btnfre"\\]))*$/.test(text)) return null;
  const simple = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', e: '\x1b', '"': '"', '\\': '\\' };
  try {
    return text.replace(/\\(?:[uUx]([0-9A-Fa-f]+)|(.))/g, (_, hex, c) => (hex ? String.fromCodePoint(parseInt(hex, 16)) : simple[c]));
  } catch { return null; }
}

// Every `key = value` line for the settings below, as lists of values. Over-matching (a key inside
// a table or a multi-line string) only refuses a switch; a top-level setting is never missed, also
// when its key or value is quoted with escapes. A quoted key that cannot be read refuses.
function settings(text) {
  const found = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([A-Za-z0-9_-]+))\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1] != null ? unescapeBasic(m[1]) : m[2] ?? m[3];
    if (key === null) throw new Problem('invalid_config');
    if (!['cli_auth_credentials_store', ...MANAGED_KEYS].includes(key)) continue;
    const rest = m[4];
    let value;
    if ((value = /^"((?:[^"\\]|\\.)*)"\s*(?:#.*)?$/.exec(rest))) value = unescapeBasic(value[1]) ?? rest;
    else if ((value = /^'([^']*)'\s*(?:#.*)?$/.exec(rest))) value = value[1];
    else if ((value = /^(true|false)\s*(?:#.*)?$/.exec(rest))) value = value[1] === 'true';
    else value = rest; // anything else (a multi-line string, a number) counts as set
    (found[key] ||= []).push(value);
  }
  return found;
}

class Store {
  constructor(home, root, { locker, signal = null, env = process.env,
    systemRequirements = path.join(process.env.ProgramData || 'C:\\ProgramData', 'OpenAI', 'Codex', 'requirements.toml') } = {}) {
    Object.assign(this, { home, root, locker, signal, env, systemRequirements });
    this.active = path.join(home, 'auth.json');
    this.journal = path.join(root, 'transaction.json');
    this.slotsLock = path.join(root, 'slots.lock');
  }

  slot(key) {
    if (typeof key !== 'string' || !/^[0-9a-f]{64}$/.test(key)) throw new Problem('invalid_identity');
    return path.join(this.root, 'slots', key);
  }

  checkConfig() {
    let text = '';
    try { text = fs.readFileSync(path.join(this.home, 'config.toml'), 'utf8'); }
    catch (e) { if (e.code !== 'ENOENT') throw new Problem('invalid_config'); }
    const config = settings(text);
    if ((config.cli_auth_credentials_store || []).some((v) => v !== 'file')) throw new Problem('unsupported_store');
    if (MANAGED_KEYS.some((k) => (config[k] || []).some(present))) throw new Problem('managed_auth');
    if (['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN'].some((k) => this.env[k])) throw new Problem('environment_auth');
    // Managed authentication requirements are not overridden by this helper.
    for (const file of [this.systemRequirements, path.join(this.home, 'requirements.toml'), path.join(this.home, 'managed_config.toml')]) {
      if (fs.existsSync(file)) throw new Problem('managed_auth');
    }
  }

  // Holds the locks in order for `fn`, then releases them in reverse.
  async hold(files, fn) {
    const held = [];
    try {
      for (const file of files) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        await this.locker.lock(file);
        held.push(file);
      }
      if (this.signal?.aborted) throw new Problem('cancelled');
      return await fn();
    } finally {
      for (const file of held.reverse()) await this.locker.unlock(file).catch(() => {});
    }
  }

  async recover() {
    const journal = readJson(this.journal);
    if (!present(journal)) return;
    const { before, after } = journal;
    const previous = journal.previous_slot ?? null;
    const outgoing = present(before) ? path.join(this.slot(identity(before)), 'auth.json') : null;
    const incoming = path.join(this.slot(identity(after)), 'auth.json');
    const dirs = [...new Set([outgoing, incoming].filter(Boolean).map((p) => path.dirname(p)))].sort();
    await this.hold(dirs.flatMap(authLocks), () => {
      const current = readJson(this.active);
      const currentId = present(current) ? identity(current) : null;
      const beforeId = present(before) ? identity(before) : null;
      const afterId = identity(after);
      const storedOutgoing = outgoing ? readJson(outgoing) : null;
      const untouched = [before, previous, null].some((v) => isDeepStrictEqual(storedOutgoing, v));
      if (beforeId && currentId === beforeId) {
        // Native refresh may have advanced this login; preserve the active file.
        if (outgoing && untouched) {
          if (previous === null) fs.rmSync(outgoing, { force: true });
          else atomicJson(outgoing, previous);
        }
      } else {
        // Finish only the slot side. Never overwrite a later login or logout.
        if (outgoing && untouched) atomicJson(outgoing, before);
        if (currentId === afterId) {
          if (isDeepStrictEqual(readJson(incoming), after)) fs.rmSync(incoming, { force: true });
        } else if (!fs.existsSync(incoming)) atomicJson(incoming, after);
      }
      fs.unlinkSync(this.journal);
    });
  }

  async status(key) {
    this.slot(key);
    this.checkConfig();
    return this.hold([this.slotsLock, ...authLocks(this.home)], async () => {
      await this.recover();
      const active = readJson(this.active);
      const current = present(active) ? identity(active) : null;
      const saved = readJson(path.join(this.slot(key), 'auth.json'));
      return { current, ready: current === key || (present(saved) && identity(saved) === key) };
    });
  }

  async inspect() {
    // Reading the selected login must work even when switching is blocked.
    this.checkConfig();
    return this.hold(authLocks(this.home), () => {
      const active = readJson(this.active);
      return { current: present(active) ? identity(active) : null };
    });
  }

  async commit(key, validate = null, guard = null) {
    const slot = this.slot(key);
    this.checkConfig();
    const unchanged = { current: key, applied: true, unchanged: true };
    return this.hold([this.slotsLock], async () => {
      const already = await this.hold(authLocks(this.home), async () => {
        await this.recover();
        const active = readJson(this.active);
        return present(active) && identity(active) === key;
      });
      if (already) return unchanged;
      const incoming = path.join(slot, 'auth.json');
      const saved = readJson(incoming);
      if (!present(saved)) throw new Problem('needs_login');
      if (identity(saved) !== key) throw new Problem('wrong_account');
      // Validate/refresh the inactive login before changing the default login.
      if (validate) await validate(slot);
      return this.hold([...authLocks(this.home), ...authLocks(slot)], async () => {
        const before = readJson(this.active);
        if (present(before) && identity(before) === key) return unchanged;
        if (guard) await guard();
        const after = readJson(incoming);
        if (!present(after) || identity(after) !== key) throw new Problem('needs_login');
        const outgoing = present(before) ? path.join(this.slot(identity(before)), 'auth.json') : null;
        const outgoingLocks = outgoing ? authLocks(path.dirname(outgoing)) : [];
        return this.hold(outgoingLocks, async () => {
          // The helper holds the locks for this process; confirm it still has every one of them.
          await this.locker.confirm([this.slotsLock, ...authLocks(this.home), ...authLocks(slot), ...outgoingLocks]);
          if (this.signal?.aborted) throw new Problem('cancelled');
          const previous = outgoing ? readJson(outgoing) : null;
          // Synchronous from here: nothing else in the pet runs between these writes, and a
          // crash in between leaves the journal for recover().
          atomicJson(this.journal, { before: present(before) ? before : null, after, previous_slot: previous });
          if (outgoing) atomicJson(outgoing, before);
          atomicJson(this.active, after);
          fs.unlinkSync(incoming);
          fs.unlinkSync(this.journal);
          const check = readJson(this.active);
          if (!present(check) || identity(check) !== key) throw new Problem('verification_failed');
          return { current: key, applied: true, unchanged: false };
        });
      });
    });
  }
}

// One PowerShell helper per operation (windows-target.ps1). Answers come in request order.
// `onLost` runs if the helper ends before close(): its locks are gone, so the operation must stop.
class WindowsHelper {
  constructor({ spawnFn = spawn, script = path.join(__dirname, 'windows-target.ps1'), onLost = () => {} } = {}) {
    Object.assign(this, { spawnFn, script, onLost });
    this.child = null; this.waiting = []; this.buffer = ''; this.closed = false;
  }

  start() {
    if (this.child) return;
    this.child = this.spawnFn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.script],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => {
      this.buffer += chunk;
      let n;
      while ((n = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, n).trim(); this.buffer = this.buffer.slice(n + 1);
        if (!line) continue;
        const next = this.waiting.shift();
        if (!next) continue;
        try { next.resolve(JSON.parse(line)); } catch { next.reject(new Problem('helper_failed')); }
      }
    });
    const lost = () => { if (!this.closed) { this.close(); this.onLost(); } };
    this.child.stdin.on('error', lost);
    this.child.on('error', lost);
    this.child.on('exit', lost);
  }

  request(message) {
    if (this.closed) return Promise.reject(new Problem('helper_failed'));
    this.start();
    return new Promise((resolve, reject) => {
      this.waiting.push({ resolve, reject });
      this.child.stdin.write(`${asciiJson(message)}\n`);
    });
  }

  async lock(file) {
    const answer = await this.request({ op: 'lock', path: file, waitMs: LOCK_WAIT_MS });
    if (answer?.ok !== true) throw new Problem(answer?.error === 'busy' ? 'busy' : 'lock_failed');
  }

  async unlock(file) { await this.request({ op: 'unlock', path: file }); }

  async confirm(files) {
    const answer = await this.request({ op: 'held', paths: files });
    if (answer?.ok !== true) throw new Problem('lock_failed');
  }

  async processes() {
    const answer = await this.request({ op: 'processes' });
    if (!Array.isArray(answer?.processes)) throw new Problem('helper_failed');
    return answer.processes;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const next of this.waiting.splice(0)) next.reject(new Problem('helper_failed'));
    if (!this.child) return;
    this.child.stdin.end();
    this.child.kill(); // Windows releases its locks with the process.
  }
}

function versionOf(executable) {
  return new Promise((resolve) => {
    try {
      execFile(executable, ['--version'], { timeout: 10_000, windowsHide: true }, (error, stdout) => {
        const found = /codex-cli ([0-9A-Za-z.-]+)/.exec(String(stdout || ''));
        resolve(error && !found ? null : found?.[1] || null);
      });
    } catch { resolve(null); }
  });
}

async function codexExecutable({ find = findCodex, version = versionOf } = {}) {
  const executable = find();
  if (!executable) throw new Problem('codex_missing');
  const found = await version(executable);
  if (!found) throw new Problem('codex_failed');
  if (!VERIFIED.test(found)) throw new Problem('unsupported_version', { version: found });
  return executable;
}

// Unlike Linux, another process's CODEX_HOME cannot be read here, so every Codex this user runs
// counts. The pet's own usage monitor runs the verified Codex, so it never blocks.
async function checkRunningWriters(helper, version = versionOf) {
  const versions = new Map();
  const blockers = [];
  for (const p of await helper.processes()) {
    if (!Number.isSafeInteger(p?.pid) || p.pid <= 0 || p.mine === false) continue;
    if (typeof p.path !== 'string' || !p.path) { blockers.push({ pid: p.pid, version: 'unverified', client: 'Codex' }); continue; }
    const key = p.path.toLowerCase();
    if (!versions.has(key)) versions.set(key, (await version(p.path)) || 'unverified');
    const found = versions.get(key);
    if (!VERIFIED.test(found)) blockers.push({ pid: p.pid, version: found, client: /vscode/i.test(p.path) ? 'VS Code extension' : 'Codex' });
  }
  if (blockers.length) throw new Problem('unknown_running_version', { blockers });
}

function rpcFailure(signal) {
  return (error) => {
    if (error instanceof Problem) throw error;
    if (signal.aborted) throw new Problem('cancelled');
    throw new Problem(error?.rpcCode != null ? 'codex_request_failed' : 'codex_closed');
  };
}

// Waits until this Codex has exited; quickly when the operation was cancelled.
const stopCodex = (rpc, signal) => rpc.shutdown(signal.aborted ? 2_000 : 15_000);

async function openRpc(executable, home, signal, factory) {
  if (signal.aborted) throw new Problem('cancelled');
  const rpc = factory({ executable, home, store: 'file' });
  const close = () => rpc.close();
  signal.addEventListener('abort', close, { once: true });
  rpc.once('closed', () => signal.removeEventListener('abort', close));
  try { await rpc.initialize().catch(rpcFailure(signal)); return rpc; }
  catch (e) { await stopCodex(rpc, signal); throw e; }
}

function login(rpc, signal, onLogin) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (error) => {
      if (done) return;
      done = true; clearTimeout(timer);
      rpc.off('notification', notified); rpc.off('closed', closed);
      error ? reject(error) : resolve();
    };
    const notified = (m) => { if (m.method === 'account/login/completed') finish(m.params?.success === true ? null : new Problem('login_failed')); };
    const closed = () => finish(new Problem(signal.aborted ? 'cancelled' : 'codex_closed'));
    const timer = setTimeout(() => finish(new Problem('timeout')), 600_000);
    rpc.on('notification', notified);
    rpc.on('closed', closed);
    rpc.request('account/login/start', { type: 'chatgptDeviceCode' }).then((response) => {
      let url;
      try { url = new URL(response?.verificationUrl); } catch { url = null; }
      const code = response?.userCode;
      if (url?.protocol !== 'https:' || !['auth.openai.com', 'chatgpt.com'].includes(url.hostname) || typeof code !== 'string' || code.length > 100) {
        finish(new Problem('invalid_response')); return;
      }
      onLogin({ target: 'Windows', url: url.href, code });
    }, (error) => { try { rpcFailure(signal)(error); } catch (e) { finish(e); } });
  });
}

async function perform(operation, key, { signal, onLogin, helper, deps }) {
  const home = deps.home || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const root = deps.root || path.join(os.homedir(), '.ttokttok-pet', 'codex-target-accounts');
  const store = new Store(home, root, { locker: helper, signal, ...(deps.env && { env: deps.env }), ...(deps.systemRequirements && { systemRequirements: deps.systemRequirements }) });
  if (operation === 'inspect') return store.inspect();
  const factory = deps.rpc || ((o) => new CodexRpc(o));
  const version = deps.version || versionOf;
  const executable = await codexExecutable({ find: deps.find || findCodex, version });
  const guard = () => checkRunningWriters(helper, version);
  const state = await store.status(key);
  if (state.current !== key) await guard();
  if (operation === 'status') return state;
  if (operation === 'enroll') {
    if (state.ready) return state;
    await store.hold([store.slotsLock], async () => {
      const slot = store.slot(key);
      fs.mkdirSync(slot, { recursive: true });
      const rpc = await openRpc(executable, slot, signal, factory);
      try {
        await login(rpc, signal, onLogin);
        if (identity(readJson(path.join(slot, 'auth.json'))) !== key) {
          try { await rpc.request('account/logout').catch(() => {}); }
          finally { await store.hold(authLocks(slot), () => fs.rmSync(path.join(slot, 'auth.json'), { force: true })); }
          throw new Problem('wrong_account');
        }
        await rpc.request('account/rateLimits/read').catch(rpcFailure(signal));
      } finally { await stopCodex(rpc, signal); }
    });
    return store.status(key);
  }
  return store.commit(key, async (slot) => {
    const rpc = await openRpc(executable, slot, signal, factory);
    try { await rpc.request('account/rateLimits/read').catch(rpcFailure(signal)); }
    finally { await stopCodex(rpc, signal); }
  }, guard);
}

// Same contract as runTarget for the other hosts: resolves with the result or rejects with a
// Problem. Cancel and timeout stop Codex, then wait for the operation to unwind with its locks
// still held, so a following inspection sees what was actually written. Losing the helper stops
// the operation before it can write without them.
async function runWindowsTarget(operation, key, { signal, onLogin = () => {}, timeoutMs = 120_000, deps = {} } = {}) {
  if (signal?.aborted) throw new Problem('cancelled');
  const controller = new AbortController();
  let reason = null;
  const stop = (why) => { if (!reason) { reason = why; controller.abort(); } };
  const cancel = () => stop('cancelled');
  signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => stop('timeout'), timeoutMs);
  const helper = deps.helper ? deps.helper(() => stop('helper_failed')) : new WindowsHelper({ onLost: () => stop('helper_failed') });
  try {
    const result = await perform(operation, key, { signal: controller.signal, onLogin, helper, deps });
    if (reason) throw new Problem(reason);
    return result;
  } catch (error) {
    throw reason ? new Problem(reason) : error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
    helper.close();
  }
}

module.exports = { runWindowsTarget, Store, Problem, WindowsHelper, identity, readJson, atomicJson, settings, codexExecutable, checkRunningWriters };
