'use strict';

const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');

// No stderr or remote error messages are forwarded: authentication failures can contain secrets.
class CodexRpc extends EventEmitter {
  constructor({ executable, home, spawnFn = spawn, timeoutMs = 60_000 }) {
    super();
    this.timeoutMs = timeoutMs;
    this.pending = new Map();
    this.sequence = 0;
    this.buffer = '';
    this.closed = false;
    const env = { ...process.env, CODEX_HOME: home };
    for (const key of Object.keys(env)) if (/^(OPENAI|CODEX)_.*(KEY|TOKEN|BASE_URL)$/i.test(key)) delete env[key];
    this.child = spawnFn(executable, ['app-server', '-c', 'cli_auth_credentials_store="keyring"'], {
      env,
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => this.receive(chunk));
    this.child.stderr.on('data', () => {});
    this.child.stdin.on('error', () => this.close());
    this.child.on('error', () => this.close());
    this.child.on('close', () => this.close());
  }

  async initialize() {
    await this.request('initialize', {
      clientInfo: { name: 'ttokttok_accounts_probe', version: '1' },
      capabilities: { experimentalApi: true },
    });
    this.send({ method: 'initialized' });
  }

  send(message) {
    if (this.closed) throw new Error('Codex process is closed.');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params = {}) {
    if (this.closed) return Promise.reject(new Error('Codex process is closed.'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex request timed out: ${method}`));
        // Do not leave a potentially mutating request running after its caller gives up.
        this.close();
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      try { this.send({ id, method, params }); }
      catch { this.close(); }
    });
  }

  receive(chunk) {
    this.buffer += chunk;
    if (this.buffer.length > 8 * 1024 * 1024) { this.close(); return; }
    let index;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      let message;
      try { message = JSON.parse(line); } catch { this.close(); return; }
      if (!message || typeof message !== 'object' || Array.isArray(message)) { this.close(); return; }
      const pending = this.pending.get(message.id);
      if (pending && !message.method) {
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) {
          const error = new Error(`Codex rejected ${pending.method} (code ${Number(message.error.code) || 0}).`);
          error.rpcCode = message.error.code;
          pending.reject(error);
        } else pending.resolve(message.result);
      } else if (message.method && message.id == null) {
        this.emit('notification', message);
      } else if (message.method && message.id != null) {
        this.send({ id: message.id, error: { code: -32601, message: 'Unsupported client request' } });
      }
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Codex process closed before answering.'));
    }
    this.pending.clear();
    this.child.stdin.end();
    const timer = setTimeout(() => this.child.kill('SIGKILL'), 15_000);
    timer.unref?.();
    this.child.once('close', () => clearTimeout(timer));
    this.emit('closed');
  }
}

module.exports = { CodexRpc };
