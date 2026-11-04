'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { timeline } = require('../src/timeline');
const { timetableItems } = require('../src/etl/timetable');
const { scheduleItems } = require('../src/todomate/schedule');
const { compareSessions } = require('../src/transcript');

const kst = (s) => Date.parse(`${s}+09:00`);

const CLASSES = {
  date: '2026-11-03',
  classes: [
    { start: '10:00', end: '11:15', course: '기계공학개론', course_id: 11, room: '301-118', kind: '정규' },
    { start: '13:00', end: '14:15', course: '가상현실공학', course_id: 12, room: '000-101', kind: '정규' },
    { start: '15:30', end: '16:45', course: '나노소자개론', course_id: 13, room: null, kind: '정규' },
  ],
  cancelled: [],
};
const SCHEDULE = {
  date: '2026-11-03',
  items: [
    { id: 'a', start: '09:30', end: '10:30', title: '미팅', done: false },
    { id: 'b', start: '13:00', end: '14:00', title: '랩미팅', done: false },
  ],
};
const DEADLINE = { id: 'etl:deadline:1:2', kind: 'etl', status: 'idle', badge: 'D-2', title: '보고서', since: 1 };

// The pet's list at `at`, as main.js makes it.
function bubbles(at) {
  const now = kst(at);
  const etl = [DEADLINE, ...timetableItems(CLASSES, now)];
  return timeline([...etl, ...scheduleItems(SCHEDULE, now)]).sort(compareSessions);
}
const shown = (list) => list.filter((s) => s.startsAt != null).map((s) => [s.badge, s.title, s.status]);

test('classes and the schedule go in start order, the earliest under way or next marked', () => {
  assert.deepEqual(shown(bubbles('2026-11-03T09:00:00')), [
    ['09:30', '미팅', 'review'],
    ['10:00', '기계공학개론', 'idle'],
    ['13:00', '가상현실공학', 'idle'],
    ['13:00', '랩미팅', 'idle'],
    ['15:30', '나노소자개론', 'idle'],
  ]);
  // The meeting is under way past 10:00, so it stays marked until it ends.
  assert.deepEqual(shown(bubbles('2026-11-03T10:10:00')).slice(0, 2), [['09:30', '미팅', 'review'], ['10:00', '기계공학개론', 'idle']]);
  assert.deepEqual(shown(bubbles('2026-11-03T10:40:00')).slice(0, 2), [['10:00', '기계공학개론', 'review'], ['13:00', '가상현실공학', 'idle']]);
});

test('at the same start time both are marked, the class first', () => {
  assert.deepEqual(shown(bubbles('2026-11-03T12:00:00')), [
    ['13:00', '가상현실공학', 'review'],
    ['13:00', '랩미팅', 'review'],
    ['15:30', '나노소자개론', 'idle'],
  ]);
  assert.deepEqual(shown(bubbles('2026-11-03T13:30:00')).map((b) => b[2]), ['review', 'review', 'idle']);
  // The meeting ends first; the class stays marked until it ends too.
  assert.deepEqual(shown(bubbles('2026-11-03T14:05:00')), [['13:00', '가상현실공학', 'review'], ['15:30', '나노소자개론', 'idle']]);
});

test('two items of one source starting together are both marked', () => {
  const day = { date: '2026-11-03', items: [...SCHEDULE.items, { id: 'c', start: '13:00', end: '13:30', title: '통화', done: false }] };
  const list = timeline(scheduleItems(day, kst('2026-11-03T12:00:00')));
  assert.deepEqual(list.map((s) => [s.title, s.status]), [['랩미팅', 'review'], ['통화', 'review']]);
});

test('the timeline stays together among the other bubbles, which keep their places', () => {
  const list = bubbles('2026-11-03T09:00:00');
  const ids = list.map((s) => s.id);
  assert.equal(ids[0], 'todomate:2026-11-03:a');   // the marked one sits with the other Ready bubbles
  assert.deepEqual(ids.slice(1), [
    'etl:deadline:1:2',
    'etl:timetable:2026-11-03:10:00:정규:11',
    'etl:timetable:2026-11-03:13:00:정규:12',
    'todomate:2026-11-03:b',
    'etl:timetable:2026-11-03:15:30:정규:13',
  ]);
});

test('a list without classes or schedule is left as it is', () => {
  const list = [DEADLINE, { id: 'x', kind: 'todomate', status: 'review', badge: 'D-3', title: '발표' }];
  assert.equal(timeline(list), list);
});
