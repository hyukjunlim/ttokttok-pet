'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SlackTracker } = require('../src/slack/tracker');
const { SlackAuthError } = require('../src/slack/client');

const kst = (s) => Date.parse(`${s}+09:00`);
const CONFIG = { canvasId: 'F01EXAMPLE0', url: 'https://team.slack.com/docs/T01EXAMPLE0/F01EXAMPLE0', name: '홍길동' };
const TIMERS = { setInterval: () => 1, clearInterval() {}, setTimeout: () => 1, clearTimeout() {} };
const table = (rows) => `# 발표 순서\n\n|날짜|요일|시간|상태|긴 발표|짧은 발표|\n|---|---|---|---|---|---|\n${rows.join('\n')}\n`;
const ROW_1110 = '|2026-11-10|화|10:00-11:00|정상 진행|김철수|홍길동|';
const ROW_1222 = '|2026-12-22|화|10:00-11:00|정상 진행|홍길동|윤도윤|';

function setUp(t, { markdown, now = kst('2026-11-03T12:00:00') }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-tracker-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = { markdown, now, calls: 0, lists: [] };
  const make = () => {
    const tracker = new SlackTracker({
      createClient: () => ({
        canvasMarkdown: async () => {
          env.calls++;
          if (env.markdown instanceof Error) throw env.markdown;
          return env.markdown;
        },
      }),
      config: () => CONFIG,
      stateFile: path.join(dir, 'slack-state.json'),
      now: () => env.now,
      timers: TIMERS,
    });
    tracker.on('change', (list) => env.lists.push(list));
    return tracker;
  };
  return { env, make, dir };
}

const ids = (list) => list.map((it) => it.id);

test('the first check finds your turns and shows the reminder due now, without 순서 변경', async (t) => {
  const { env, make } = setUp(t, { markdown: table([ROW_1110, ROW_1222]) });
  const tracker = make();
  tracker.start();
  await tracker.checkNow();
  assert.deepEqual(tracker.turns().map((x) => x.key), ['2026-11-10:짧은 발표', '2026-12-22:긴 발표']);
  assert.deepEqual(ids(env.lists.at(-1)), ['slack:remind:2026-11-10:짧은 발표:d7', 'slack:daily:2026-12-22:긴 발표:2026-11-03']);
  assert.deepEqual(env.lists.at(-1).map((it) => it.badge), ['D-7', 'D-49']);
  tracker.stop();
});

test('a later check that sees a turn move shows 순서 변경; the state survives a restart', async (t) => {
  const { env, make } = setUp(t, { markdown: table([ROW_1110, ROW_1222]) });
  const first = make();
  first.start();
  await first.checkNow();
  first.stop();

  env.markdown = table([ROW_1110, '|2026-12-22|화|10:00-11:00|정상 진행|~~홍길동~~|윤도윤|', '|2026-12-29|화|10:00-11:00|정상 진행|이영희|홍길동|']);
  const second = make();
  second.start();
  await second.checkNow();
  const shown = env.lists.at(-1);
  assert.deepEqual(shown.filter((it) => it.badge === '순서 변경').map((it) => [it.title, it.project]).sort(), [
    ['12/22(화) 긴 발표', '빠짐 · 발표 순서'],
    ['12/29(화) 짧은 발표', '새로 잡힘 · 발표 순서'],
  ]);
  second.stop();
});

test('clearing a reminder hides it until the next morning, even after a restart', async (t) => {
  const { env, make } = setUp(t, { markdown: table([ROW_1110]) });
  const tracker = make();
  tracker.start();
  await tracker.checkNow();
  tracker.dismiss('slack:remind:2026-11-10:짧은 발표:d7');
  assert.deepEqual(ids(env.lists.at(-1)), []);
  tracker.stop();
  const again = make();
  again.start();
  assert.deepEqual(ids(env.lists.at(-1)), []);
  env.now = kst('2026-11-04T06:00:00');
  again.publish();
  assert.deepEqual(ids(env.lists.at(-1)), ['slack:daily:2026-11-10:짧은 발표:2026-11-04']);
  again.dismiss('slack:daily:2026-11-10:짧은 발표:2026-11-04');
  assert.deepEqual(ids(env.lists.at(-1)), []);
  env.now = kst('2026-11-07T06:00:00');
  again.publish();
  assert.deepEqual(ids(env.lists.at(-1)), ['slack:remind:2026-11-10:짧은 발표:d3']);
  again.stop();
});

test('a milestone day (D-3) keeps a slack:remind: id, which the phone pushes', async (t) => {
  const { env, make } = setUp(t, { markdown: table([ROW_1110]) });
  const tracker = make();
  tracker.start();
  await tracker.checkNow();
  env.now = kst('2026-11-07T09:00:00');
  tracker.publish();
  assert.deepEqual(ids(env.lists.at(-1)), ['slack:remind:2026-11-10:짧은 발표:d3']);
  tracker.stop();
});

test('a token Slack turns down: one bubble, and no more requests until the settings change', async (t) => {
  const { env, make } = setUp(t, { markdown: new SlackAuthError('token_revoked') });
  const tracker = make();
  tracker.start();
  await tracker.checkNow();
  assert.deepEqual(ids(env.lists.at(-1)), ['slack:token']);
  const calls = env.calls;
  await tracker.checkNow();
  assert.equal(env.calls, calls);

  env.markdown = table([ROW_1110]);
  await tracker.settingsChanged();
  assert.deepEqual(ids(env.lists.at(-1)), ['slack:remind:2026-11-10:짧은 발표:d7']);
  tracker.stop();
});

test('a table that lost its columns keeps the last turns and says so', async (t) => {
  const { env, make } = setUp(t, { markdown: table([ROW_1110]) });
  const tracker = make();
  tracker.start();
  await tracker.checkNow();
  env.markdown = '# 발표 순서\n\n표를 옮겼습니다.\n';
  await tracker.checkNow();
  assert.deepEqual(ids(env.lists.at(-1)).sort(), ['slack:format', 'slack:remind:2026-11-10:짧은 발표:d7']);
  assert.equal(tracker.turns().length, 1);
  tracker.stop();
});

test('nothing is read, written or sent before start()', (t) => {
  const { env, make, dir } = setUp(t, { markdown: table([ROW_1110]) });
  make();
  assert.equal(env.calls, 0);
  assert.deepEqual(fs.readdirSync(dir), []);
});
