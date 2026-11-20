'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const {
  GeminiUsage, findAgyBinary, parseGeminiCache, serializeGeminiCache,
} = require('../src/gemini-usage');

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ttokttok-pet-gemini-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'gemini-usage.json');
}

test('findAgyBinary checks AGY_BIN, standard install locations, and PATH', () => {
  const winDefault = path.join('C:\\Users\\hong\\AppData\\Local', 'agy', 'bin', 'agy.exe');
  const winPath = path.join('D:\\tools', 'agy.exe');
  assert.equal(
    findAgyBinary({
      platform: 'win32',
      home: 'C:\\Users\\hong',
      env: { LOCALAPPDATA: 'C:\\Users\\hong\\AppData\\Local', AGY_BIN: 'E:\\custom\\agy.exe', PATH: 'D:\\tools' },
      existsSync: (p) => p === 'E:\\custom\\agy.exe' || p === winDefault,
    }),
    'E:\\custom\\agy.exe',
  );
  assert.equal(
    findAgyBinary({
      platform: 'win32',
      home: 'C:\\Users\\hong',
      env: { LOCALAPPDATA: 'C:\\Users\\hong\\AppData\\Local', PATH: 'D:\\tools' },
      existsSync: (p) => p === winDefault,
    }),
    winDefault,
  );
  assert.equal(
    findAgyBinary({
      platform: 'win32',
      home: 'C:\\Users\\hong',
      env: { LOCALAPPDATA: 'C:\\Users\\hong\\AppData\\Local', PATH: '"D:\\tools";C:\\Windows' },
      existsSync: (p) => p === winPath,
    }),
    winPath,
  );
  assert.equal(
    findAgyBinary({
      platform: 'win32',
      home: 'C:\\Users\\hong',
      env: { LOCALAPPDATA: 'C:\\Users\\hong\\AppData\\Local', PATH: '' },
      existsSync: () => false,
    }),
    null,
  );
});

test('Gemini cache serialization round-trips valid weekly readings and rejects bad payloads', () => {
  const reading = { weekly: { percent: 24, resetsAt: T0 + 3 * DAY, windowMs: WEEK }, fiveHour: null, at: T0 };
  const payload = serializeGeminiCache(reading);
  assert.deepEqual(payload, { version: 1, at: T0, weekly: { percent: 24, resetsAt: T0 + 3 * DAY } });
  assert.deepEqual(parseGeminiCache(payload), reading);
  assert.equal(parseGeminiCache({ version: 2, at: T0, weekly: { percent: 24 } }), null);
  assert.equal(parseGeminiCache({ version: 1, at: T0, weekly: null }), null);
  assert.equal(parseGeminiCache(null), null);
});

test('GeminiUsage loads the cached reading immediately, refreshes via agy, and persists the update', async (t) => {
  const cacheFile = tempCache(t);
  const cachedReset = T0 + 4 * DAY;
  fs.writeFileSync(cacheFile, JSON.stringify({ version: 1, at: T0 - 2 * HOUR, weekly: { percent: 18, resetsAt: cachedReset } }));

  const freshReset = '2026-09-29T04:00:00.000Z';
  let calls = 0;
  const events = [];
  const u = new GeminiUsage({
    cacheFile,
    findBinary: () => 'C:\\fake\\agy.exe',
    runQuota: async (bin) => {
      calls += 1;
      assert.equal(bin, 'C:\\fake\\agy.exe');
      return `Gemini Models\tWeekly Limit Remaining\t65%\t${freshReset}\nClaude and GPT models\tWeekly Limit Remaining\t10%\t${freshReset}\n`;
    },
    pollMs: 60_000,
    now: () => T0,
  });
  u.on('change', (r) => events.push(r));
  u.on('error', (err) => { throw err; });
  t.after(() => u.stop());

  u.start();
  // Cached reading is emitted synchronously on start before the live poll resolves.
  assert.equal(events.length, 1);
  assert.equal(events[0].weekly.percent, 18);

  assert.ok(await waitFor(() => events.length === 2));
  assert.equal(calls, 1);
  assert.deepEqual(events[1], {
    weekly: { percent: 35, resetsAt: Date.parse(freshReset), windowMs: WEEK },
    fiveHour: null,
    at: T0,
  });
  const saved = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  assert.deepEqual(saved, { version: 1, at: T0, weekly: { percent: 35, resetsAt: Date.parse(freshReset) } });
});

test('GeminiUsage skips an immediate spawn when the cache is very fresh, and refreshes on power resume once stale', async (t) => {
  const cacheFile = tempCache(t);
  let clock = T0;
  fs.writeFileSync(cacheFile, JSON.stringify({ version: 1, at: T0 - 10_000, weekly: { percent: 12, resetsAt: T0 + 5 * DAY } }));

  let calls = 0;
  const powerMonitor = new EventEmitter();
  const u = new GeminiUsage({
    cacheFile,
    findBinary: () => 'C:\\fake\\agy.exe',
    runQuota: async () => {
      calls += 1;
      return 'Gemini Models\tWeekly Limit Remaining\t70%\t2026-09-30T04:00:00Z\n';
    },
    powerMonitor,
    pollMs: 15 * 60_000,
    initialFreshMs: 60_000,
    now: () => clock,
  });
  u.on('error', (err) => { throw err; });
  t.after(() => u.stop());

  u.start();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(calls, 0);
  assert.equal(u.current().weekly.percent, 12);

  // Resume while still fresh -> no refresh yet.
  clock += 5 * 60_000;
  powerMonitor.emit('resume');
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(calls, 0);

  // Resume once past pollMs -> refreshes immediately.
  clock += 15 * 60_000;
  powerMonitor.emit('resume');
  assert.ok(await waitFor(() => u.current().weekly.percent === 30));
  assert.equal(calls, 1);
});

test('transient errors keep the last reading, while sign-out errors clear the reading and cache', async (t) => {
  const cacheFile = tempCache(t);
  fs.writeFileSync(cacheFile, JSON.stringify({ version: 1, at: T0 - 2 * HOUR, weekly: { percent: 40, resetsAt: T0 + 2 * DAY } }));

  let mode = 'timeout';
  const errors = [];
  const u = new GeminiUsage({
    cacheFile,
    findBinary: () => 'C:\\fake\\agy.exe',
    runQuota: async () => {
      if (mode === 'timeout') throw new Error('timed out');
      throw new Error('agy is not logged in');
    },
    pollMs: 60_000,
    now: () => T0,
  });
  u.on('error', (err) => errors.push(err.message));
  t.after(() => u.stop());

  u.start();
  assert.ok(await waitFor(() => errors.length === 1));
  assert.equal(u.current().weekly.percent, 40, 'transient failure keeps previous reading');
  assert.equal(fs.existsSync(cacheFile), true);

  mode = 'auth';
  await u.refresh();
  assert.equal(u.current(), null, 'signed-out failure clears reading');
  assert.equal(fs.existsSync(cacheFile), false, 'signed-out failure drops stale cache');
  assert.equal(errors.length, 2);
});

test('stop kills an in-flight child process and ignores late results', async (t) => {
  let killed = false;
  let finish;
  const changes = [];
  const u = new GeminiUsage({
    findBinary: () => 'C:\\fake\\agy.exe',
    runQuota: (_bin, { onChild }) => new Promise((resolve) => {
      onChild({ kill: () => { killed = true; } });
      finish = resolve;
    }),
    pollMs: 60_000,
    now: () => T0,
  });
  u.on('change', (r) => changes.push(r));
  u.on('error', () => {});
  t.after(() => u.stop());

  u.start();
  assert.ok(await waitFor(() => typeof finish === 'function'));
  u.stop();
  assert.equal(killed, true);

  finish('Gemini Models\tWeekly Limit Remaining\t50%\t2026-09-29T04:00:00Z\n');
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(changes, []);
  assert.equal(u.current(), null);
});
