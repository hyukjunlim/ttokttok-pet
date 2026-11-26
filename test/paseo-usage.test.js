'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const {
  PaseoUsage, findPaseoLaunch, parsePaseoCache, serializePaseoCache,
} = require('../src/paseo-usage');

const T0 = Date.parse('2026-09-25T04:00:00.000Z');
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

const waitFor = async (pred, ms = 2000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 15))) {
    if (pred()) return true;
  }
  return false;
};

function tempCache(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ttokttok-pet-paseo-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'paseo-usage.json');
}

test('findPaseoLaunch checks PASEO_BIN, bundled Windows Paseo.exe, standard locations, and PATH', () => {
  const appDir = path.join('C:\\Users\\hong\\AppData\\Local', 'Programs', 'Paseo');
  const exe = path.join(appDir, 'Paseo.exe');
  const runner = path.join(appDir, 'resources', 'app.asar.unpacked', 'dist', 'daemon', 'node-entrypoint-runner.js');
  const asar = path.join(appDir, 'resources', 'app.asar');
  const cmd = path.join('C:\\Users\\hong', '.local', 'bin', 'paseo.cmd');

  const bundled = findPaseoLaunch({
    platform: 'win32',
    home: 'C:\\Users\\hong',
    env: { LOCALAPPDATA: 'C:\\Users\\hong\\AppData\\Local', PATH: '' },
    existsSync: (p) => p === exe || p === runner || p === asar,
  });
  assert.equal(bundled.kind, 'electron-node');
  assert.equal(bundled.command, exe);
  assert.equal(bundled.env.ELECTRON_RUN_AS_NODE, '1');

  const override = findPaseoLaunch({
    platform: 'win32',
    home: 'C:\\Users\\hong',
    env: { PASEO_BIN: 'D:\\custom\\paseo.cmd', LOCALAPPDATA: 'C:\\Users\\hong\\AppData\\Local' },
    existsSync: (p) => p === 'D:\\custom\\paseo.cmd' || p === exe || p === runner || p === asar,
  });
  assert.deepEqual(override, { kind: 'cmd', command: 'D:\\custom\\paseo.cmd', args: [], env: {} });

  const localCmd = findPaseoLaunch({
    platform: 'win32',
    home: 'C:\\Users\\hong',
    env: { LOCALAPPDATA: 'C:\\Users\\hong\\AppData\\Local', PATH: '' },
    existsSync: (p) => p === cmd,
  });
  assert.deepEqual(localCmd, { kind: 'cmd', command: cmd, args: [], env: {} });

  assert.equal(
    findPaseoLaunch({
      platform: 'win32',
      home: 'C:\\Users\\hong',
      env: { LOCALAPPDATA: 'C:\\Users\\hong\\AppData\\Local', PATH: '' },
      existsSync: () => false,
    }),
    null,
  );
});

test('Paseo cache serialization round-trips valid readings and rejects bad payloads', () => {
  const reading = {
    at: T0,
    claude: { weekly: { percent: 32, resetsAt: T0 + 3 * DAY, windowMs: WEEK, repeats: true }, fiveHour: null, at: T0 },
    codex: { weekly: { percent: 5, resetsAt: T0 + 5 * DAY, windowMs: WEEK }, fiveHour: null, at: T0 },
    gemini: { weekly: { percent: 14, resetsAt: T0 + 4 * DAY, windowMs: WEEK }, fiveHour: null, at: T0 },
  };
  const payload = serializePaseoCache(reading);
  assert.deepEqual(parsePaseoCache(payload), reading);
  assert.equal(parsePaseoCache({ version: 2, at: T0, claude: payload.claude }), null);
  assert.equal(parsePaseoCache({ version: 1, at: T0, claude: null, codex: null, gemini: null }), null);
  assert.equal(parsePaseoCache(null), null);
});

test('PaseoUsage loads cache immediately, refreshes from Paseo JSON, and persists updates', async (t) => {
  const cacheFile = tempCache(t);
  fs.writeFileSync(cacheFile, JSON.stringify({
    version: 1,
    at: T0 - 2 * HOUR,
    claude: { at: T0 - 2 * HOUR, weekly: { percent: 20, resetsAt: T0 + 4 * DAY, windowMs: WEEK } },
    codex: null,
    gemini: null,
  }));

  const freshReset = '2026-09-29T19:00:00.000Z';
  let calls = 0;
  const events = [];
  const u = new PaseoUsage({
    cacheFile,
    findLaunch: () => ({ kind: 'binary', command: '/fake/paseo', args: [], env: {} }),
    runUsage: async () => {
      calls += 1;
      return JSON.stringify([
        {
          sourceId: 'claude',
          successfulAt: '2026-09-25T04:00:00.000Z',
          report: {
            status: 'available',
            windows: [
              { id: 'weekly', usedPct: 22, resetsAt: freshReset, durationSeconds: 604800 },
              { id: 'weekly_model_fable', usedPct: 35, resetsAt: freshReset, durationSeconds: 604800 },
            ],
          },
        },
        {
          sourceId: 'antigravity',
          successfulAt: '2026-09-25T04:00:00.000Z',
          report: {
            status: 'available',
            windows: [
              { id: 'gemini-weekly', usedPct: 15, resetsAt: freshReset, durationSeconds: 604800 },
            ],
          },
        },
      ]);
    },
    pollMs: 60_000,
    now: () => T0,
  });
  u.on('change', (r) => events.push(r));
  u.on('error', (err) => { throw err; });
  t.after(() => u.stop());

  u.start();
  assert.equal(events.length, 1);
  assert.equal(events[0].claude.weekly.percent, 20);

  assert.ok(await waitFor(() => events.length === 2));
  assert.equal(calls, 1);
  assert.equal(events[1].claude.weekly.percent, 35);
  assert.equal(events[1].gemini.weekly.percent, 15);
  const saved = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  assert.equal(saved.claude.weekly.percent, 35);
  assert.equal(saved.gemini.weekly.percent, 15);
});

test('transient errors keep the last Paseo reading, while offline daemon errors clear reading and cache for fallback', async (t) => {
  const cacheFile = tempCache(t);
  fs.writeFileSync(cacheFile, JSON.stringify({
    version: 1,
    at: T0 - 2 * HOUR,
    claude: { at: T0 - 2 * HOUR, weekly: { percent: 40, resetsAt: T0 + 2 * DAY, windowMs: WEEK } },
  }));

  let mode = 'timeout';
  const errors = [];
  const u = new PaseoUsage({
    cacheFile,
    findLaunch: () => ({ kind: 'binary', command: '/fake/paseo', args: [], env: {} }),
    runUsage: async () => {
      if (mode === 'timeout') throw new Error('timed out');
      throw new Error('Paseo daemon is not running');
    },
    pollMs: 60_000,
    now: () => T0,
  });
  u.on('error', (err) => errors.push(err.message));
  t.after(() => u.stop());

  u.start();
  assert.ok(await waitFor(() => errors.length === 1));
  assert.equal(u.current().claude.weekly.percent, 40);
  assert.equal(fs.existsSync(cacheFile), true);

  mode = 'offline';
  await u.refresh();
  assert.equal(u.current(), null);
  assert.equal(fs.existsSync(cacheFile), false);
  assert.equal(errors.length, 2);
});

test('PaseoUsage skips immediate poll when cache is fresh, refreshes on power resume, and kills child on stop', async (t) => {
  const cacheFile = tempCache(t);
  let clock = T0;
  fs.writeFileSync(cacheFile, JSON.stringify({
    version: 1,
    at: T0 - 10_000,
    claude: { at: T0 - 10_000, weekly: { percent: 12, resetsAt: T0 + 5 * DAY, windowMs: WEEK } },
  }));

  let killed = false;
  let calls = 0;
  const powerMonitor = new EventEmitter();
  const u = new PaseoUsage({
    cacheFile,
    findLaunch: () => ({ kind: 'binary', command: '/fake/paseo', args: [], env: {} }),
    runUsage: (_launch, { onChild }) => new Promise(() => {
      calls += 1;
      onChild({ kill: () => { killed = true; } });
    }),
    powerMonitor,
    pollMs: 5 * 60_000,
    initialFreshMs: 60_000,
    now: () => clock,
  });
  u.on('error', () => {});
  t.after(() => u.stop());

  u.start();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(calls, 0);

  clock += 6 * 60_000;
  powerMonitor.emit('resume');
  assert.ok(await waitFor(() => calls === 1));

  u.stop();
  assert.equal(killed, true);
});
