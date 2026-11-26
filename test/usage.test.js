'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  combineClaudeUsage, formatDuration, nextWeeklyReset, parseAgyQuota, parseModUsage, parsePaseoUsage, parseRateLimits, usageView, withWeeklyResets,
} = require('../src/usage');

const T0 = Date.parse('2026-09-25T04:00:00.000Z');
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

test("Claude's figures from the pet's mod come with their reset times", () => {
  const u = parseModUsage({
    version: 1,
    at: T0,
    limits: [
      { kind: 'five_hour', percent: 12, resetsAt: T0 + 3 * HOUR },
      { kind: 'seven_day', percent: 45, resetsAt: T0 + 2 * DAY },
      { kind: 'spend_limit', percent: 10, resetsAt: null },    // a gateway's, not shown
    ],
  });
  assert.deepEqual(u, {
    weekly: { percent: 45, resetsAt: T0 + 2 * DAY, windowMs: WEEK }, fiveHour: { percent: 12, resetsAt: T0 + 3 * HOUR, windowMs: 5 * HOUR }, at: T0,
  });
  assert.deepEqual(parseModUsage({ version: 1, at: T0, limits: [{ kind: 'seven_day', percent: 5 }] }).weekly, { percent: 5, resetsAt: null, windowMs: WEEK });
  assert.equal(parseModUsage({ version: 1, at: T0, limits: [] }), null);
  assert.equal(parseModUsage({ version: 2, at: T0, limits: [{ kind: 'seven_day', percent: 5 }] }), null, 'a format this pet does not know');
  assert.equal(parseModUsage(null), null);
});

test("Claude's newest figures win, wherever the mod saved them, and its week resets as Claude says", () => {
  const reset = T0 + 2 * DAY;
  const here = { weekly: { percent: 40, resetsAt: reset, windowMs: WEEK }, fiveHour: null, at: T0 - 2 * HOUR };
  const host = { weekly: { percent: 44, resetsAt: reset, windowMs: WEEK }, fiveHour: null, at: T0 - 10 * MINUTE };
  // A host's session replied last.
  assert.deepEqual(combineClaudeUsage([here, host]).weekly, { percent: 44, resetsAt: reset, windowMs: WEEK, repeats: true });
  // Figures without a reset time take the week from older ones that have it.
  const untimed = { weekly: { percent: 47, resetsAt: null, windowMs: WEEK }, fiveHour: null, at: T0 };
  const [view] = usageView({ claude: combineClaudeUsage([here, untimed]) }, T0);
  assert.deepEqual([view.percent, view.resetsIn], [47, '2d']);
  assert.equal(combineClaudeUsage([untimed]).weekly.resetsAt, null);
  assert.equal(combineClaudeUsage([]), null);
  assert.equal(combineClaudeUsage([null, { at: T0, weekly: null, fiveHour: null }]), null);
});

test("Codex's weekly limit is the window that lasts a week, in whichever slot it comes", () => {
  const reset = T0 / 1000 + 2 * 86_400;
  // A plan with only a weekly limit
  assert.deepEqual(
    parseRateLimits({ limit_id: 'codex', primary: { used_percent: 99, window_minutes: 10080, resets_at: reset }, secondary: null }, T0),
    { weekly: { percent: 99, resetsAt: reset * 1000, windowMs: WEEK }, fiveHour: null },
  );
  // One with a 5-hour limit as well
  assert.deepEqual(
    parseRateLimits({
      primary: { used_percent: 12, window_minutes: 300, resets_at: T0 / 1000 + 3600 },
      secondary: { used_percent: 40, window_minutes: 10080, resets_at: reset },
    }, T0),
    { weekly: { percent: 40, resetsAt: reset * 1000, windowMs: WEEK }, fiveHour: { percent: 12, resetsAt: T0 + HOUR, windowMs: 5 * HOUR } },
  );
  // Older Codex: no window lengths, and the resets counted from the reply
  assert.deepEqual(
    parseRateLimits({ primary: { used_percent: 12, resets_in_seconds: 600 }, secondary: { used_percent: 40, resets_in_seconds: 86_400 } }, T0),
    { weekly: { percent: 40, resetsAt: T0 + DAY, windowMs: WEEK }, fiveHour: { percent: 12, resetsAt: T0 + 10 * MINUTE, windowMs: 5 * HOUR } },
  );
  // Another limit's figures, or none
  assert.equal(parseRateLimits({ limit_id: 'other', primary: { used_percent: 5, window_minutes: 10080 } }, T0), null);
  assert.equal(parseRateLimits(null, T0), null);
});

test('the pet shows how much of each weekly limit is used, and how far into the week it is', () => {
  const claude = { weekly: { percent: 67.6, resetsAt: null, windowMs: WEEK }, fiveHour: null, at: T0 - 10 * MINUTE };
  const codex = { weekly: { percent: 99, resetsAt: T0 + 2 * DAY + 5 * HOUR, windowMs: WEEK }, fiveHour: null, at: T0 - DAY };
  assert.deepEqual(usageView({ claude, codex }, T0), [
    { app: 'claude', name: 'Claude', percent: 68, elapsed: null, resetsIn: null, age: null },   // no reset time set
    { app: 'codex', name: 'Codex', percent: 99, elapsed: 68, resetsIn: '2d 5h', age: '1d' },    // 4d 19h of 7d gone
  ]);
  // Three days on, Codex's week has turned over (the next one starts with its next reply).
  assert.deepEqual(usageView({ claude, codex }, T0 + 3 * DAY), [
    { app: 'claude', name: 'Claude', percent: 68, elapsed: null, resetsIn: null, age: '3d' },
    { app: 'codex', name: 'Codex', percent: 0, elapsed: null, resetsIn: null, age: null },
  ]);
  assert.deepEqual(usageView({ claude: null, codex: { weekly: null, fiveHour: { percent: 3, resetsAt: null }, at: T0 } }, T0), []);
});

test("one of Claude's weekly resets gives them all", () => {
  const anchor = T0 + 2 * DAY + 5 * HOUR - 3 * WEEK;   // three weeks back; the next is in 2d 5h
  assert.equal(nextWeeklyReset(anchor, T0), T0 + 2 * DAY + 5 * HOUR);
  assert.equal(nextWeeklyReset(anchor + 10 * WEEK, T0), T0 + 2 * DAY + 5 * HOUR, 'or ahead');
  const claude = { weekly: { percent: 69, resetsAt: null, windowMs: WEEK }, fiveHour: null, at: T0 - 10 * MINUTE };
  const [now] = usageView({ claude: withWeeklyResets(claude, anchor) }, T0);
  assert.deepEqual([now.percent, now.elapsed, now.resetsIn], [69, 68, '2d 5h']);
  // After the reset, and before the next reply: a fresh week.
  const [later] = usageView({ claude: withWeeklyResets(claude, anchor) }, T0 + 2 * DAY + 5 * HOUR + 1000);
  assert.deepEqual([later.percent, later.elapsed, later.resetsIn], [0, 0, '7d']);
  // Without a reset time, there's no telling how far into the week it is.
  assert.equal(usageView({ claude: withWeeklyResets(claude, null) }, T0)[0].elapsed, null);
});

test('reset times read as the time left', () => {
  assert.equal(formatDuration(2 * DAY + 5 * HOUR + 10 * MINUTE), '2d 5h');
  assert.equal(formatDuration(3 * DAY), '3d');
  assert.equal(formatDuration(5 * HOUR + 20 * MINUTE), '5h');
  assert.equal(formatDuration(40 * MINUTE), '40m');
  assert.equal(formatDuration(10_000), '1m');
});

test("Antigravity's /quota output gives Gemini's used percentages and ignores Claude/GPT rows", () => {
  const weekReset = '2026-09-28T04:00:00.000Z';
  const fiveHourReset = '2026-09-25T07:00:00.000Z';
  const stdout = [
    `Gemini Models\tWeekly Limit Remaining\t68%\t${weekReset}`,
    `Gemini Models\tFive Hour Limit Remaining\t85%\t${fiveHourReset}`,
    'Claude and GPT models\tWeekly Limit Remaining\t20%\t2026-09-30T04:00:00.000Z',
    'Claude and GPT models\tFive Hour Limit Remaining\t50%\t2026-09-25T08:00:00.000Z',
  ].join('\r\n');
  assert.deepEqual(parseAgyQuota(stdout, T0), {
    weekly: { percent: 32, resetsAt: Date.parse(weekReset), windowMs: WEEK },
    fiveHour: { percent: 15, resetsAt: Date.parse(fiveHourReset), windowMs: 5 * HOUR },
    at: T0,
  });
  // Explicit "Used" wording stays as-is, missing reset is null, out-of-range percentages clamp.
  assert.deepEqual(
    parseAgyQuota('Gemini Models\tWeekly Limit Used\t110%\t\n', T0),
    { weekly: { percent: 100, resetsAt: null, windowMs: WEEK }, fiveHour: null, at: T0 },
  );
  // Only Claude/GPT rows or garbage -> null.
  assert.equal(parseAgyQuota('Claude and GPT models\tWeekly Limit Remaining\t40%\t2026-09-30T04:00:00Z', T0), null);
  assert.equal(parseAgyQuota('not logged in', T0), null);
  assert.equal(parseAgyQuota(null, T0), null);
});

test('usageView renders Gemini weekly usage with elapsed week progress and rolls over after reset', () => {
  const gemini = { weekly: { percent: 32, resetsAt: T0 + 3 * DAY, windowMs: WEEK }, fiveHour: null, at: T0 - 2 * HOUR };
  assert.deepEqual(usageView({ gemini }, T0), [
    { app: 'gemini', name: 'Gemini', percent: 32, elapsed: 57, resetsIn: '3d', age: '2h' },
  ]);
  assert.deepEqual(usageView({ gemini }, T0 + 3 * DAY + MINUTE), [
    { app: 'gemini', name: 'Gemini', percent: 0, elapsed: null, resetsIn: null, age: null },
  ]);
});

test('parsePaseoUsage extracts Claude Fable weekly (preferring Fable over overall), Codex weekly, and Antigravity Gemini weekly', () => {
  const claudeReset = '2026-09-29T19:00:00.000Z';
  const codexReset = '2026-10-01T14:00:00.000Z';
  const geminiReset = '2026-09-30T04:00:00.000Z';
  const payload = [
    {
      sourceId: 'claude',
      successfulAt: '2026-09-25T03:55:00.000Z',
      report: {
        status: 'available',
        windows: [
          { id: 'five_hour', usedPct: 6, resetsAt: '2026-09-25T08:00:00.000Z', durationSeconds: 18000 },
          { id: 'weekly', usedPct: 21, resetsAt: claudeReset, durationSeconds: 604800 },
          { id: 'weekly_model_fable', label: 'Weekly · Fable', usedPct: 37, resetsAt: claudeReset, durationSeconds: 604800 },
        ],
      },
    },
    {
      sourceId: 'cursor',
      report: { status: 'unavailable', problem: { kind: 'rejected', status: 401 } },
    },
    {
      sourceId: 'codex',
      successfulAt: '2026-09-25T03:58:00.000Z',
      report: {
        status: 'available',
        windows: [
          { id: 'weekly', usedPct: 12, resetsAt: codexReset, durationSeconds: 604800 },
        ],
      },
    },
    {
      sourceId: 'antigravity',
      successfulAt: '2026-09-25T03:59:00.000Z',
      report: {
        status: 'available',
        windows: [
          { id: 'gemini-weekly', label: 'Gemini · Weekly', usedPct: 18.5, resetsAt: geminiReset, durationSeconds: 604800 },
          { id: 'gemini-5h', label: 'Gemini · 5h', usedPct: 4, resetsAt: '2026-09-25T07:00:00.000Z', durationSeconds: 18000 },
          { id: '3p-weekly', label: 'Claude and GPT · Weekly', usedPct: 90, resetsAt: geminiReset, durationSeconds: 604800 },
        ],
      },
    },
  ];

  const parsed = parsePaseoUsage(JSON.stringify(payload), T0);
  assert.deepEqual(parsed, {
    claude: {
      weekly: { percent: 37, resetsAt: Date.parse(claudeReset), windowMs: WEEK, repeats: true },
      fiveHour: { percent: 6, resetsAt: Date.parse('2026-09-25T08:00:00.000Z'), windowMs: 5 * HOUR },
      at: Date.parse('2026-09-25T03:55:00.000Z'),
    },
    codex: {
      weekly: { percent: 12, resetsAt: Date.parse(codexReset), windowMs: WEEK },
      fiveHour: null,
      at: Date.parse('2026-09-25T03:58:00.000Z'),
    },
    gemini: {
      weekly: { percent: 18.5, resetsAt: Date.parse(geminiReset), windowMs: WEEK },
      fiveHour: { percent: 4, resetsAt: Date.parse('2026-09-25T07:00:00.000Z'), windowMs: 5 * HOUR },
      at: Date.parse('2026-09-25T03:59:00.000Z'),
    },
  });

  // Falls back to overall Claude weekly when no Fable window is present.
  const withoutFable = parsePaseoUsage([
    {
      sourceId: 'claude',
      report: {
        status: 'available',
        windows: [{ id: 'weekly', remainingPct: 75, resetsAt: claudeReset, durationSeconds: 604800 }],
      },
    },
  ], T0);
  assert.deepEqual(withoutFable.claude.weekly, {
    percent: 25, resetsAt: Date.parse(claudeReset), windowMs: WEEK, repeats: true,
  });

  // Invalid or unavailable payloads return null.
  assert.equal(parsePaseoUsage('not json', T0), null);
  assert.equal(parsePaseoUsage([{ sourceId: 'claude', report: { status: 'unavailable' } }], T0), null);
});
