'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { LOADER } = require('../ssh-watcher');

const TARGETS = ['WSL', 'micc-beta'];
const ERRORS = {
  needs_login: 'Sign in to this account on the target first.',
  wrong_account: 'A different subscription account was used. Try again with the selected account.',
  busy: 'Another login change is running on this target.',
  managed_auth: 'This target has managed authentication settings; they were not changed.',
  environment_auth: 'This target uses an environment-provided credential; it was not changed.',
  unsupported_store: 'This target does not use file-based Codex login storage.',
  unsupported_version: 'This action has been verified for Codex 0.166–0.167. Update compatibility before using another version.',
  unknown_running_version: 'An older or unverified Codex process is running. Close its session or update it (including the Codex extension in VS Code) before applying. It was not stopped.',
  unsupported_auth: 'The current target login is not a supported ChatGPT subscription login.',
  codex_missing: 'Codex could not be found on this target.',
  codex_request_failed: 'Codex could not validate this login. Reconnect the target account.',
  recovery_required: 'A previous login change needs recovery; no newer login was overwritten.',
  cancelled: 'Cancelled. Check the target status before retrying.',
  timeout: 'The target did not respond in time. Check its status before retrying.',
};

function targetError(message) {
  const base = ERRORS[message.error] || 'The target could not complete the login change.';
  if (message.error !== 'unknown_running_version' || !Array.isArray(message.blockers)) return base;
  const processes = message.blockers.filter((p) => Number.isSafeInteger(p?.pid) && p.pid > 0
    && typeof p.version === 'string' && /^(?:unverified|[0-9][0-9A-Za-z.\-]{0,60})$/.test(p.version)
    && ['Codex', 'VS Code extension'].includes(p.client))
    .map((p) => `${p.client}: PID ${p.pid}, version ${p.version}`);
  return processes.length ? `${base}\n${processes.join('\n')}` : base;
}

function runTarget(target, operation, identity, { signal, onLogin = () => {}, spawnFn = spawn, timeoutMs = operation === 'enroll' ? 660_000 : 120_000 } = {}) {
  if (!TARGETS.includes(target) || !['inspect', 'status', 'enroll', 'apply'].includes(operation)
    || (operation !== 'inspect' && !/^[a-f0-9]{64}$/.test(identity))) return Promise.reject(new Error('Invalid target request.'));
  if (signal?.aborted) return Promise.reject(new Error(ERRORS.cancelled));
  const script = fs.readFileSync(path.join(__dirname, 'target.py'), 'utf8');
  const remote = `exec python3 -u -c '${LOADER}'`;
  const args = ['-d', 'Ubuntu', '-e', ...(target === 'WSL' ? ['python3', '-u', '-c', LOADER]
    : ['ssh', '-x', '-T', '-o', 'BatchMode=yes', '-o', 'ClearAllForwardings=yes', '-o', 'ConnectTimeout=8', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=2', 'micc-beta', remote])];
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawnFn('wsl.exe', args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch { reject(new Error('Could not start the target connection.')); return; }
    let buffer = '', done = false;
    const finish = (error, result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      child.stdin.end();
      const stop = setTimeout(() => child.kill(), 20_000);
      stop.unref?.();
      child.once('close', () => clearTimeout(stop));
      error ? reject(error) : resolve(result);
    };
    const cancel = () => finish(new Error(ERRORS.cancelled));
    const timer = setTimeout(() => finish(new Error(ERRORS.timeout)), timeoutMs);
    signal?.addEventListener('abort', cancel, { once: true });
    child.stdout.setEncoding('utf8');
    child.stderr.on('data', () => {}); // SSH/Codex diagnostics never reach renderer or logs.
    child.stdin.on('error', () => finish(new Error('The target connection closed.')));
    child.on('error', () => finish(new Error('Could not start the target connection.')));
    child.on('close', () => finish(new Error('The target connection closed; verify its status before retrying.')));
    child.stdout.on('data', (chunk) => {
      if (done) return;
      buffer += chunk;
      if (buffer.length > 64 * 1024) { finish(new Error('Invalid target response.')); return; }
      let n;
      while ((n = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, n); buffer = buffer.slice(n + 1);
        let message;
        try { message = JSON.parse(line); } catch { finish(new Error('Invalid target response.')); return; }
        if (!message || typeof message !== 'object') { finish(new Error('Invalid target response.')); return; }
        if (message.error) { finish(new Error(targetError(message))); return; }
        if (message.event === 'login') {
          let url;
          try { url = new URL(message.url); } catch { finish(new Error('Invalid target sign-in page.')); return; }
          if (url.protocol !== 'https:' || !['auth.openai.com', 'chatgpt.com'].includes(url.hostname) || typeof message.code !== 'string' || message.code.length > 100) {
            finish(new Error('Invalid target sign-in page.')); return;
          }
          onLogin({ target, url: url.href, code: message.code });
        } else if (message.result && typeof message.result === 'object') {
          finish(null, { current: typeof message.result.current === 'string' ? message.result.current : null,
            ready: message.result.ready === true, applied: message.result.applied === true, unchanged: message.result.unchanged === true });
          return;
        }
      }
    });
    child.stdin.write(`${JSON.stringify(script)}\n${JSON.stringify({ operation, identity })}\n`);
  });
}

class TargetAccounts extends EventEmitter {
  constructor({ run = runTarget, now = Date.now } = {}) {
    super(); this.run = run; this.now = now; this.state = null; this.controller = null;
    this.observed = {}; this.inspection = null; this.inspectionGeneration = 0;
  }
  get busy() { return Boolean(this.controller); }
  snapshot() { return this.state ? { ...this.state, busy: this.busy } : null; }
  changed() { this.emit('change', this.snapshot()); }
  currentAccounts(accounts) {
    return Object.fromEntries(accounts.map((a) => {
      const targets = Object.fromEntries(TARGETS.map((target) => {
        const observed = this.observed[target];
        const known = observed?.status === 'known' && this.now() - observed.at < 60_000;
        return [target, { status: known ? (a.identity && observed.current === a.identity ? 'applied' : 'other') : 'unknown',
          error: known ? null : observed?.error || null }];
      }));
      return [a.id, { targets, appliedEverywhere: TARGETS.every((t) => targets[t].status === 'applied') }];
    }));
  }
  refreshStatus() {
    if (this.busy) return Promise.resolve();
    if (this.inspection) return this.inspection.task;
    const generation = ++this.inspectionGeneration;
    const controller = new AbortController();
    const task = Promise.all(TARGETS.map(async (target) => {
      let result;
      try {
        const value = await this.run(target, 'inspect', null, { signal: controller.signal, timeoutMs: 20_000 });
        if (!Object.hasOwn(value, 'current') || (value.current !== null && !/^[a-f0-9]{64}$/.test(value.current))) throw new Error('Invalid current login response.');
        result = { status: 'known', current: value.current, at: this.now() };
      } catch { result = { status: 'unknown', error: 'Could not check the current login.', at: this.now() }; }
      if (generation !== this.inspectionGeneration) return;
      this.observed[target] = result; this.changed();
    })).finally(() => { if (generation === this.inspectionGeneration) this.inspection = null; });
    this.inspection = { controller, task };
    return task;
  }
  begin(account) {
    if (this.busy) throw new Error('Wait for the current apply operation.');
    if (!/^[a-f0-9]{64}$/.test(account?.identity)) throw new Error('Refresh this account’s usage before applying it.');
    this.inspectionGeneration++;
    this.inspection?.controller.abort(); this.inspection = null;
    this.controller = new AbortController();
    this.state = { accountId: account.id, pending: null, phase: 'checking', targets: Object.fromEntries(TARGETS.map((t) => [t, { status: 'checking' }])) };
    this.changed();
    this.task = this.perform(account).catch(() => {}).finally(() => { this.controller = null; this.state.pending = null; this.changed(); });
  }
  async perform(account) {
    const signal = this.controller.signal;
    const request = (target, operation) => this.run(target, operation, account.identity, { signal, onLogin: (pending) => {
      this.state.pending = pending; this.changed();
    } });
    const update = (target, value) => { this.state.targets[target] = value; this.changed(); };
    const observe = (target, current) => { this.observed[target] = { status: 'known', current, at: this.now() }; };
    let target;
    try {
      // Preflight both hosts before beginning sign-in or changing either default login.
      for (target of TARGETS) {
        const status = await request(target, 'status');
        observe(target, status.current);
        update(target, { status: status.ready ? 'ready' : 'needs_login' });
      }
      for (target of TARGETS) {
        if (this.state.targets[target].status !== 'needs_login') continue;
        this.state.phase = 'linking'; update(target, { status: 'signing_in' });
        const status = await request(target, 'enroll');
        this.state.pending = null;
        if (!status.ready) throw new Error('The target login is not ready.');
        update(target, { status: 'ready' });
      }
      this.state.phase = 'applying';
      for (target of TARGETS) {
        update(target, { status: 'applying' });
        const result = await request(target, 'apply');
        if (!result.applied || result.current !== account.identity) throw new Error('The selected target account could not be verified.');
        observe(target, result.current);
        update(target, { status: 'applied' });
      }
      this.state.phase = 'done';
    } catch (error) {
      if (target) update(target, { status: signal.aborted ? 'cancelled' : 'error', error: error.message });
      for (const host of TARGETS) if (this.state.targets[host].status === 'checking') update(host, { status: 'not_checked' });
      if (this.state.phase === 'applying') {
        // The write may have completed before the connection disappeared or Cancel was pressed.
        // Reconcile without the cancelled signal; never report a guessed rollback.
        this.state.phase = 'verifying'; this.changed();
        for (const host of TARGETS) {
          try {
            const actual = await this.run(host, 'inspect', null, {});
            observe(host, actual.current);
            update(host, { status: actual.current === account.identity ? 'applied' : 'not_applied' });
          } catch { this.observed[host] = { status: 'unknown' }; update(host, { status: 'unknown', error: 'Could not confirm the current target account. Check the connection before retrying.' }); }
        }
      }
      this.state.phase = TARGETS.every((t) => this.state.targets[t].status === 'applied') ? 'done'
        : TARGETS.some((t) => this.state.targets[t].status === 'applied') ? 'partial' : 'failed';
    }
    this.changed();
  }
  cancel() { this.controller?.abort(); }
  stop() { this.cancel(); this.inspectionGeneration++; this.inspection?.controller.abort(); }
}
module.exports = { TargetAccounts, runTarget, targetError, TARGETS };
