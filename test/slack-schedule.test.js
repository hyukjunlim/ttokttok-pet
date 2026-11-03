'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ScheduleFormatError, changeItems, nextChangeAt, parseSchedule, reminderItems, turnsOf,
} = require('../src/slack/schedule');

const kst = (s) => Date.parse(`${s}+09:00`);
const URL = 'https://team.slack.com/docs/T01EXAMPLE0/F01EXAMPLE0';

// The canvas as canvases.getContent gives it, cut down.
const CANVAS = `# 발표 순서

|날짜|요일|시간|세션|상태|긴 발표|짧은 발표 1|짧은 발표 2|저널클럽|
|  ---  |  ---  |  ---  |  ---  |  ---  |  ---  |  ---  |  ---  |  ---  |
|2026-10-01|목|10:00-11:00|긴+저널클럽|정상 진행|~~박민수~~|||~~홍길동~~|
|2026-10-20|화|10:00-11:00|긴+짧은2|시험기간 - 중간고사|홍길동||||
|2026-11-10|화|10:00-11:00|긴+짧은2|정상 진행|김철수|이영희|홍길동||
|2026-11-17|화|10:00-11:00|긴+짧은2|정상 진행|~~홍길동~~|정다은|한서준||
|2026-12-22|화|10:00-11:00|긴+짧은2|정상 진행|홍길동 (리허설)|윤도윤|한서준||
|2026-12-24|목||긴+저널클럽|휴무 - 크리스마스 연휴 - 전날|||||
|2026-12-31|목||긴+저널클럽|정상 진행|**홍길동**|||[오지현](https://example.com)|
`;

test('reads the table: title, presenter columns, a row per date', () => {
  const s = parseSchedule(CANVAS);
  assert.equal(s.title, '발표 순서');
  assert.deepEqual(s.presenters, ['긴 발표', '짧은 발표 1', '짧은 발표 2', '저널클럽']);
  assert.equal(s.rows.length, 7);
  assert.deepEqual(s.rows[0].cells['저널클럽'], { live: '', struck: ['홍길동'] });
  assert.deepEqual(s.rows[6].cells['저널클럽'], { live: '오지현', struck: [] });
});

test('a turn: 정상 진행, the name not struck through, in any presenter column, notes and emphasis allowed', () => {
  const turns = turnsOf(parseSchedule(CANVAS), '홍길동');
  assert.deepEqual(turns.map((t) => t.key), ['2026-11-10:짧은 발표 2', '2026-12-22:긴 발표', '2026-12-31:긴 발표']);
  const [first, , last] = turns;
  assert.equal(first.startAt, kst('2026-11-10T10:00:00'));
  assert.equal(first.endAt, kst('2026-11-10T11:00:00'));
  // no 시간: the whole day
  assert.equal(last.startAt, kst('2026-12-31T00:00:00'));
  assert.equal(last.endAt, kst('2027-01-01T00:00:00'));
  assert.deepEqual(turnsOf(parseSchedule(CANVAS), '  '), []);
});

test('a canvas without a 날짜 and 상태 table is a format error', () => {
  assert.throws(() => parseSchedule('# 발표 순서\n\n|이름|순서|\n|---|---|\n|홍길동|1|\n'), ScheduleFormatError);
  assert.throws(() => parseSchedule(''), ScheduleFormatError);
});

test('a pipe escaped in a cell stays in it', () => {
  const s = parseSchedule('|날짜|상태|발표|\n|---|---|---|\n|2026-11-10|정상 진행|홍길동 \\| 리허설|\n');
  assert.equal(s.rows[0].cells['발표'].live, '홍길동 | 리허설');
});

test('reminders: D-7, D-3 and D-1 at 09:00, the day itself at 08:00, each until the next', () => {
  const turns = turnsOf(parseSchedule(CANVAS), '홍길동');
  const at = (when) => reminderItems(turns, kst(when), { url: URL, title: '발표 순서' }).map((r) => r.badge);
  assert.deepEqual(at('2026-11-03T08:59:00'), []);
  assert.deepEqual(at('2026-11-03T09:00:00'), ['발표 D-7']);
  assert.deepEqual(at('2026-11-06T23:00:00'), ['발표 D-7']);
  assert.deepEqual(at('2026-11-07T09:00:00'), ['발표 D-3']);
  assert.deepEqual(at('2026-11-09T09:00:00'), ['발표 D-1']);
  assert.deepEqual(at('2026-11-10T07:59:00'), ['발표 D-1']);
  assert.deepEqual(at('2026-11-10T08:00:00'), ['발표 당일']);
  assert.deepEqual(at('2026-11-10T11:00:00'), []);

  const [r] = reminderItems(turns, kst('2026-11-07T12:00:00'), { url: URL, title: '발표 순서' });
  assert.equal(r.id, 'slack:remind:2026-11-10:짧은 발표 2:d3');
  assert.equal(r.kind, 'slack');
  assert.equal(r.title, '11/10(화) 짧은 발표 2');
  assert.equal(r.project, '10:00-11:00 · 발표 순서');
  assert.equal(r.url, URL);
  assert.equal(r.since, kst('2026-11-07T09:00:00'));
  assert.equal(r.expiresAt, kst('2026-11-09T09:00:00'));
});

test('a closed reminder stays hidden until it is due to go; the next one shows anyway', () => {
  const turns = turnsOf(parseSchedule(CANVAS), '홍길동');
  const hidden = { 'slack:remind:2026-11-10:짧은 발표 2:d3': kst('2026-11-09T09:00:00') };
  assert.deepEqual(reminderItems(turns, kst('2026-11-08T12:00:00'), { hidden }), []);
  assert.equal(reminderItems(turns, kst('2026-11-09T09:00:00'), { hidden })[0].badge, '발표 D-1');
});

test('nextChangeAt: the next reminder to start or turn to end', () => {
  const turns = turnsOf(parseSchedule(CANVAS), '홍길동');
  assert.equal(nextChangeAt(turns, kst('2026-11-03T12:00:00')), kst('2026-11-07T09:00:00'));
  assert.equal(nextChangeAt(turns, kst('2026-11-10T10:30:00')), kst('2026-11-10T11:00:00'));
  assert.equal(nextChangeAt([], 0), Infinity);
});

test('순서 변경: a turn to come that appeared, went, or moved to another column on its date', () => {
  const now = kst('2026-11-03T12:00:00');
  const before = turnsOf(parseSchedule(CANVAS), '홍길동');
  const moved = CANVAS
    .replace('|2026-11-10|화|10:00-11:00|긴+짧은2|정상 진행|김철수|이영희|홍길동||', '|2026-11-10|화|10:00-11:00|긴+짧은2|정상 진행|홍길동|이영희|김철수||')
    .replace('|홍길동 (리허설)|', '|~~홍길동 (리허설)~~|')
    .replace('|~~홍길동~~|정다은|', '|홍길동|정다은|');
  const after = turnsOf(parseSchedule(moved), '홍길동');
  const changes = changeItems(before, after, now, { url: URL });
  assert.deepEqual(changes.map((c) => [c.title, c.project]), [
    ['11/10(화) 긴 발표', '짧은 발표 2에서 바뀜'],
    ['11/17(화) 긴 발표', '새로 잡힘'],
    ['12/22(화) 긴 발표', '빠짐'],
  ]);
  assert.ok(changes.every((c) => c.badge === '순서 변경' && c.id.startsWith('slack:change:') && c.expiresAt > now));
  // Turns already over don't count.
  assert.deepEqual(changeItems(before, [], kst('2027-01-02T00:00:00')), []);
});
