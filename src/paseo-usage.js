'use strict';

// Polls the local Paseo daemon (`paseo usage ls --json`) in the background for Claude (Fable
// preferred), Codex, and Antigravity Gemini weekly limits, keeping the last reading cached on disk
// so restarts aren't blank.
//
// On Windows, invokes Paseo's bundled Electron executable with `ELECTRON_RUN_AS_NODE=1` directly
// when available so polling never spawns cmd.exe or flashes a terminal window. This module never
// reads provider credentials or calls upstream APIs itself; if Paseo is not installed or its local
// daemon is not running, the pet falls back to its existing usage sources.

const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { parsePaseoUsage } = require('./usage');

const WEEK_MS = 7 * 24 * 60 * 60_000;
const POLL_MS = 5 * 60_000;
const INITIAL_FRESH_MS = 60_000;
const FETCH_TIMEOUT_MS = 25_000;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const DAEMON_OFFLINE_RE = /daemon.*not running|not running|econnrefused|enoent|cannot connect|failed to connect|unable to connect|no daemon/i;

// How to run `paseo usage ls --json` on this machine: explicit override, Windows desktop bundle
// (run directly via ELECTRON_RUN_AS_NODE=1 without cmd.exe), standard install paths, then PATH.
function findPaseoLaunch({
  env = process.env, home = os.homedir(), platform = process.platform, existsSync = fs.existsSync,
} = {}) {
  const safeExists = (p) => {
    try {
      return Boolean(p) && existsSync(p);
    } catch {
      return false;
    }
  };

  if (typeof env?.PASEO_BIN === 'string' && env.PASEO_BIN.trim()) {
    const custom = env.PASEO_BIN.trim();
    if (safeExists(custom)) return launchForBinary(custom, platform);
  }

  if (platform === 'win32') {
    const localAppData = env?.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    const appDir = path.join(localAppData, 'Programs', 'Paseo');
    const exe = path.join(appDir, 'Paseo.exe');
    const runner = path.join(appDir, 'resources', 'app.asar.unpacked', 'dist', 'daemon', 'node-entrypoint-runner.js');
    const cli = path.join(appDir, 'resources', 'app.asar', 'node_modules', '@getpaseo', 'cli', 'dist', 'index.js');
    // `app.asar` is a single archive file on disk; Node inside Electron reads paths within it.
    const asar = path.join(appDir, 'resources', 'app.asar');
    if (safeExists(exe) && safeExists(runner) && safeExists(asar)) {
      return {
        kind: 'electron-node',
        command: exe,
        args: ['--disable-warning=DEP0040', runner, 'node-script', cli],
        env: { ELECTRON_RUN_AS_NODE: '1', PASEO_NODE_ENV: 'production' },
      };
    }
  }

  const candidates = [];
  if (platform === 'win32') {
    candidates.push(
      path.join(home, '.local', 'bin', 'paseo.cmd'),
      path.join(home, '.local', 'bin', 'paseo.exe'),
    );
  } else {
    candidates.push(
      path.join(home, '.local', 'bin', 'paseo'),
      '/opt/homebrew/bin/paseo',
      '/usr/local/bin/paseo',
    );
  }

  const binNames = platform === 'win32' ? ['paseo.exe', 'paseo.cmd', 'paseo.bat'] : ['paseo'];
  const pathEnv = env?.PATH || env?.Path || '';
  if (typeof pathEnv === 'string' && pathEnv) {
    for (const dir of pathEnv.split(platform === 'win32' ? ';' : ':')) {
      const clean = dir.trim().replace(/^"|"$/g, '');
      if (!clean) continue;
      for (const binName of binNames) candidates.push(path.join(clean, binName));
    }
  }

  const seen = new Set();
  for (const candidate of candidates) {
    const key = platform === 'win32' ? candidate.toLowerCase() : candidate;
    if (seen.has(key)) continue;
    seen.add(key);
    if (safeExists(candidate)) return launchForBinary(candidate, platform);
  }
  return null;
}

function launchForBinary(binary, platform = process.platform) {
  if (platform === 'win32' && /\.(?:cmd|bat)$/i.test(binary)) {
    return { kind: 'cmd', command: binary, args: [], env: {} };
  }
  return { kind: 'binary', command: binary, args: [], env: {} };
}

function parseCachedProvider(entry, repeats = false) {
  if (!entry || typeof entry !== 'object' || !Number.isFinite(entry.at) || !entry.weekly || typeof entry.weekly !== 'object') {
    return null;
  }
  if (!Number.isFinite(entry.weekly.percent)) return null;
  const percent = Math.min(100, Math.max(0, entry.weekly.percent));
  const resetsAt = Number.isFinite(entry.weekly.resetsAt) ? entry.weekly.resetsAt : null;
  const windowMs = Number.isFinite(entry.weekly.windowMs) && entry.weekly.windowMs > 0 ? entry.weekly.windowMs : WEEK_MS;
  const weekly = repeats && resetsAt != null ? { percent, resetsAt, windowMs, repeats: true } : { percent, resetsAt, windowMs };
  return { weekly, fiveHour: null, at: entry.at };
}

function serializeProvider(reading) {
  if (!reading?.weekly || !Number.isFinite(reading.at) || !Number.isFinite(reading.weekly.percent)) return null;
  return {
    at: reading.at,
    weekly: {
      percent: reading.weekly.percent,
      resetsAt: Number.isFinite(reading.weekly.resetsAt) ? reading.weekly.resetsAt : null,
      windowMs: Number.isFinite(reading.weekly.windowMs) && reading.weekly.windowMs > 0 ? reading.weekly.windowMs : WEEK_MS,
    },
  };
}

// Parse a cached ~/.ttokttok-pet/paseo-usage.json payload back into { at, claude, codex, gemini }.
function parsePaseoCache(j) {
  if (j?.version !== 1 || !Number.isFinite(j.at)) return null;
  const claude = parseCachedProvider(j.claude, true);
  const codex = parseCachedProvider(j.codex, false);
  const gemini = parseCachedProvider(j.gemini, false);
  return claude || codex || gemini ? { at: j.at, claude, codex, gemini } : null;
}

function serializePaseoCache(reading) {
  if (!reading || !Number.isFinite(reading.at)) return null;
  const claude = serializeProvider(reading.claude);
  const codex = serializeProvider(reading.codex);
  const gemini = serializeProvider(reading.gemini);
  if (!claude && !codex && !gemini) return null;
  return { version: 1, at: reading.at, claude, codex, gemini };
}

function runPaseoUsage(launch, { timeoutMs = FETCH_TIMEOUT_MS, onChild = () => {} } = {}) {
  return new Promise((resolve, reject) => {
    let command = launch.command;
    let args = [...(launch.args || []), 'usage', 'ls', '--json'];
    if (launch.kind === 'cmd') {
      command = process.env.ComSpec || 'cmd.exe';
      args = ['/d', '/s', '/c', launch.command, 'usage', 'ls', '--json'];
    }
    const child = execFile(
      command,
      args,
      {
        timeout: timeoutMs,
        maxBuffer: MAX_OUTPUT_BYTES,
        cwd: os.tmpdir(),
        windowsHide: true,
        env: { ...process.env, ...(launch.env || {}) },
      },
      (err, stdout, stderr) => {
        onChild(null);
        if (err) {
          const detail = [stderr && String(stderr).trim(), err.message].filter(Boolean).join(': ');
          reject(new Error(detail || 'paseo usage ls failed'));
          return;
        }
        resolve(String(stdout || ''));
      },
    );
    onChild(child);
  });
}

class PaseoUsage extends EventEmitter {
  constructor({
    cacheFile = null,
    findLaunch = findPaseoLaunch,
    runUsage = runPaseoUsage,
    powerMonitor = null,
    pollMs = POLL_MS,
    initialFreshMs = INITIAL_FRESH_MS,
    now = Date.now,
  } = {}) {
    super();
    Object.assign(this, { cacheFile, findLaunch, runUsage, powerMonitor, pollMs, initialFreshMs, now });
    this.reading = null;
    this.running = false;
    this.busy = false;
    this.timer = null;
    this.child = null;
    this.#onResume = () => {
      if (!this.running) return;
      if (!this.reading || this.now() - this.reading.at >= this.pollMs) this.refresh();
    };
  }

  #onResume;

  start() {
    if (this.running) return;
    this.running = true;
    this.#loadCache();
    this.timer = setInterval(() => this.refresh(), this.pollMs);
    this.timer.unref?.();
    this.powerMonitor?.on('resume', this.#onResume);
    if (!this.reading || this.now() - this.reading.at >= this.initialFreshMs) {
      this.refresh();
    }
  }

  stop() {
    this.running = false;
    clearInterval(this.timer);
    this.timer = null;
    this.powerMonitor?.removeListener('resume', this.#onResume);
    if (this.child) {
      try {
        this.child.kill();
      } catch {
        // already exited
      }
      this.child = null;
    }
  }

  current() {
    return this.reading;
  }

  #set(reading) {
    if (JSON.stringify(this.reading) === JSON.stringify(reading ?? null)) return;
    this.reading = reading ?? null;
    this.emit('change', this.reading);
  }

  #loadCache() {
    if (!this.cacheFile) return;
    try {
      const parsed = parsePaseoCache(JSON.parse(fs.readFileSync(this.cacheFile, 'utf8')));
      if (parsed) this.#set(parsed);
    } catch {
      // missing or unreadable cache; wait for the live poll
    }
  }

  async #saveCache(reading) {
    if (!this.cacheFile) return;
    const payload = serializePaseoCache(reading);
    if (!payload) return;
    try {
      await fsp.mkdir(path.dirname(this.cacheFile), { recursive: true });
      const tmp = `${this.cacheFile}.tmp`;
      await fsp.writeFile(tmp, `${JSON.stringify(payload)}\n`, 'utf8');
      await fsp.rename(tmp, this.cacheFile);
    } catch (err) {
      this.emit('error', err);
    }
  }

  async #clearCache() {
    if (!this.cacheFile) return;
    try {
      await fsp.rm(this.cacheFile, { force: true });
    } catch {
      // ignore cleanup failures
    }
  }

  async refresh() {
    if (this.busy || !this.running) return;
    const launch = this.findLaunch();
    if (!launch) {
      await this.#clearCache();
      if (this.running) this.#set(null);
      return;
    }
    this.busy = true;
    try {
      const stdout = await this.runUsage(launch, {
        onChild: (child) => { this.child = child; },
      });
      if (!this.running) return;
      const at = this.now();
      const parsed = parsePaseoUsage(stdout, at);
      if (parsed) {
        const next = { at, ...parsed };
        await this.#saveCache(next);
        if (!this.running) return;
        this.#set(next);
        return;
      }
      if (DAEMON_OFFLINE_RE.test(stdout)) {
        await this.#clearCache();
        if (!this.running) return;
        this.#set(null);
        this.emit('error', new Error('Paseo daemon is not running'));
        return;
      }
      this.emit('error', new Error('paseo usage ls returned no weekly limits'));
    } catch (err) {
      if (!this.running) return;
      const message = err instanceof Error ? err.message : String(err);
      if (DAEMON_OFFLINE_RE.test(message)) {
        // Daemon is offline: fall back to the pet's built-in sources instead of pinning stale data.
        await this.#clearCache();
        if (!this.running) return;
        this.#set(null);
      }
      this.emit('error', err instanceof Error ? err : new Error(message));
    } finally {
      this.child = null;
      this.busy = false;
    }
  }
}

module.exports = {
  POLL_MS,
  PaseoUsage,
  findPaseoLaunch,
  parsePaseoCache,
  runPaseoUsage,
  serializePaseoCache,
};
