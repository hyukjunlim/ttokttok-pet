'use strict';

// Polls Antigravity CLI (`agy -p "/quota"`) in the background for Gemini's weekly usage limit,
// keeping the last reading cached on disk so restarts aren't blank.
//
// `agy` refreshes quota through its own signed-in backend and prints tab-separated rows without
// creating a conversation; this module never reads OAuth tokens or calls private endpoints.

const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { parseAgyQuota } = require('./usage');

const WEEK_MS = 7 * 24 * 60 * 60_000;
const POLL_MS = 15 * 60_000;
const INITIAL_FRESH_MS = 60_000;
const FETCH_TIMEOUT_MS = 20_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const AUTH_ERROR_RE = /not logged in|sign in|login required|unauthenticated|authentication/i;

// Where `agy` lives: explicit override, default install paths, then PATH.
function findAgyBinary({
  env = process.env, home = os.homedir(), platform = process.platform, existsSync = fs.existsSync,
} = {}) {
  const candidates = [];
  if (typeof env?.AGY_BIN === 'string' && env.AGY_BIN.trim()) candidates.push(env.AGY_BIN.trim());
  if (platform === 'win32') {
    const localAppData = env?.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    candidates.push(
      path.join(localAppData, 'agy', 'bin', 'agy.exe'),
      path.join(home, '.local', 'bin', 'agy.exe'),
    );
  } else {
    candidates.push(
      path.join(home, '.local', 'bin', 'agy'),
      '/opt/homebrew/bin/agy',
      '/usr/local/bin/agy',
    );
  }
  const binName = platform === 'win32' ? 'agy.exe' : 'agy';
  const pathEnv = env?.PATH || env?.Path || '';
  if (typeof pathEnv === 'string' && pathEnv) {
    for (const dir of pathEnv.split(platform === 'win32' ? ';' : ':')) {
      const clean = dir.trim().replace(/^"|"$/g, '');
      if (clean) candidates.push(path.join(clean, binName));
    }
  }
  const seen = new Set();
  for (const candidate of candidates) {
    const key = platform === 'win32' ? candidate.toLowerCase() : candidate;
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      // unreadable path entry
    }
  }
  return null;
}

// Parse a cached ~/.ttokttok-pet/gemini-usage.json payload back into a reading for usageView().
function parseGeminiCache(j) {
  if (j?.version !== 1 || !Number.isFinite(j.at) || !j.weekly || typeof j.weekly !== 'object') return null;
  if (!Number.isFinite(j.weekly.percent)) return null;
  const percent = Math.min(100, Math.max(0, j.weekly.percent));
  const resetsAt = Number.isFinite(j.weekly.resetsAt) ? j.weekly.resetsAt : null;
  return {
    weekly: { percent, resetsAt, windowMs: WEEK_MS },
    fiveHour: null,
    at: j.at,
  };
}

function serializeGeminiCache(reading) {
  if (!reading?.weekly || !Number.isFinite(reading.at) || !Number.isFinite(reading.weekly.percent)) return null;
  return {
    version: 1,
    at: reading.at,
    weekly: {
      percent: reading.weekly.percent,
      resetsAt: Number.isFinite(reading.weekly.resetsAt) ? reading.weekly.resetsAt : null,
    },
  };
}

function runAgyQuota(binary, { timeoutMs = FETCH_TIMEOUT_MS, onChild = () => {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      binary,
      ['-p', '/quota'],
      {
        timeout: timeoutMs,
        maxBuffer: MAX_OUTPUT_BYTES,
        cwd: os.tmpdir(),
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        onChild(null);
        if (err) {
          const detail = [stderr && String(stderr).trim(), err.message].filter(Boolean).join(': ');
          reject(new Error(detail || 'agy /quota failed'));
          return;
        }
        resolve(String(stdout || ''));
      },
    );
    onChild(child);
  });
}

class GeminiUsage extends EventEmitter {
  constructor({
    cacheFile = null,
    findBinary = findAgyBinary,
    runQuota = runAgyQuota,
    powerMonitor = null,
    pollMs = POLL_MS,
    initialFreshMs = INITIAL_FRESH_MS,
    now = Date.now,
  } = {}) {
    super();
    Object.assign(this, { cacheFile, findBinary, runQuota, powerMonitor, pollMs, initialFreshMs, now });
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
      const parsed = parseGeminiCache(JSON.parse(fs.readFileSync(this.cacheFile, 'utf8')));
      if (parsed) this.#set(parsed);
    } catch {
      // missing or unreadable cache; wait for the live poll
    }
  }

  async #saveCache(reading) {
    if (!this.cacheFile) return;
    const payload = serializeGeminiCache(reading);
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
    const binary = this.findBinary();
    if (!binary) return;
    this.busy = true;
    try {
      const stdout = await this.runQuota(binary, {
        onChild: (child) => { this.child = child; },
      });
      if (!this.running) return;
      const parsed = parseAgyQuota(stdout, this.now());
      if (parsed?.weekly) {
        const weeklyOnly = { weekly: parsed.weekly, fiveHour: null, at: parsed.at };
        await this.#saveCache(weeklyOnly);
        if (!this.running) return;
        this.#set(weeklyOnly);
        return;
      }
      if (AUTH_ERROR_RE.test(stdout)) {
        await this.#clearCache();
        if (!this.running) return;
        this.#set(null);
        this.emit('error', new Error('agy is not signed in'));
        return;
      }
      this.emit('error', new Error('agy /quota returned no Gemini weekly limit'));
    } catch (err) {
      if (!this.running) return;
      const message = err instanceof Error ? err.message : String(err);
      if (AUTH_ERROR_RE.test(message)) {
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
  GeminiUsage, POLL_MS, findAgyBinary, parseGeminiCache, runAgyQuota, serializeGeminiCache,
};
