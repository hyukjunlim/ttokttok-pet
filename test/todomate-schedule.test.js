'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { countdownItems, countdownsOf, goalsOf, parseDated, parseTimed, scheduleItems, scheduleOf, todosOf } = require('../src/todomate/schedule');

const kst = (s) => Date.parse(`${s}+09:00`);

test('parseTimed reads a start time, or a range, at the front', () => {
  assert.deepEqual(parseTimed('13:00 프로젝트 미팅'), { start: '13:00', end: '14:00', title: '프로젝트 미팅' });
  assert.deepEqual(parseTimed('11:30-12:30 세미나 (101-201)'), { start: '11:30', end: '12:30', title: '세미나 (101-201)' });
  assert.deepEqual(parseTimed('9:05 ~ 10:00  아침   회의'), { start: '09:05', end: '10:00', title: '아침 회의' });
  assert.deepEqual(parseTimed('23:30 늦은 회의'), { start: '23:30', end: '23:59', title: '늦은 회의' });
  assert.deepEqual(parseTimed('15:00-14:00 거꾸로'), { start: '15:00', end: '16:00', title: '거꾸로' });
  assert.equal(parseTimed('장보기'), null);
  assert.equal(parseTimed('13:00'), null);
  assert.equal(parseTimed('25:00 없는 시각'), null);
  assert.equal(parseTimed('11/6 저널클럽 발표'), null);
});

test('todosOf and goalsOf find todos and categories wherever the answer keeps them', () => {
  const todos = todosOf([{ result: { items: [
    { id: 't1', content: '13:00 프로젝트 미팅', goal_id: 'g1', is_done: true },
    { todoId: 't2', content: '장보기', goal: { id: 'g2', title: 'Assignment' } },
    { id: 't3', content: '10:00 팀 미팅', goalTitle: 'Schedule', isDone: false },
  ] } }]);
  assert.deepEqual(todos, [
    { id: 't1', content: '13:00 프로젝트 미팅', goalId: 'g1', goalTitle: null, done: true },
    { id: 't2', content: '장보기', goalId: null, goalTitle: 'Assignment', done: false },
    { id: 't3', content: '10:00 팀 미팅', goalId: null, goalTitle: 'Schedule', done: false },
  ]);
  const goals = goalsOf({ goals: [{ id: 'g1', title: 'Schedule' }, { id: 'g2', title: 'Assignment' }] });
  assert.deepEqual([...goals], [['g1', 'Schedule'], ['g2', 'Assignment']]);
});

test('scheduleOf keeps the timed items of one category, in start order', () => {
  const goals = new Map([['g1', 'Schedule'], ['g2', 'Assignment']]);
  const todos = [
    { id: 'a', content: '13:00 프로젝트 미팅', goalId: 'g1', goalTitle: null, done: true },
    { id: 'b', content: '10:00 팀 미팅', goalId: 'g1', goalTitle: null, done: false },
    { id: 'c', content: '서류 발급', goalId: 'g1', goalTitle: null, done: false },
    { id: 'd', content: '09:00 다른 카테고리', goalId: 'g2', goalTitle: null, done: false },
    { id: 'e', content: '11:30-12:30 세미나 (101-201)', goalId: null, goalTitle: 'schedule', done: false },
  ];
  assert.deepEqual(scheduleOf(todos, goals, 'Schedule').map((it) => [it.id, it.start, it.end, it.done]), [
    ['b', '10:00', '11:00', false],
    ['e', '11:30', '12:30', false],
    ['a', '13:00', '14:00', true],
  ]);
});

const DAY = {
  date: '2026-11-03',
  items: [
    { id: 'b', start: '10:00', end: '11:00', title: '팀 미팅', done: true },
    { id: 'e', start: '11:30', end: '12:30', title: '세미나 (101-201)', done: false },
    { id: 'a', start: '13:00', end: '14:00', title: '프로젝트 미팅', done: false },
  ],
};

test('the bubbles show from 06:00 until each item ends; the current or next one stands out', () => {
  assert.deepEqual(scheduleItems(DAY, kst('2026-11-03T05:59:00')), []);
  const morning = scheduleItems(DAY, kst('2026-11-03T09:00:00'));
  assert.deepEqual(morning.map((b) => [b.badge, b.status, b.project]), [
    ['10:00', 'review', '1시간 후'],   // checked, and no 완료 on it
    ['11:30', 'idle', '2시간 30분 후'],
    ['13:00', 'idle', '4시간 후'],
  ]);
  assert.equal(morning[0].id, 'todomate:2026-11-03:b');
  assert.equal(morning[0].kind, 'todomate');
  assert.equal(morning[0].url, undefined);   // a click opens nothing
  assert.equal(morning[0].expiresAt, kst('2026-11-03T11:00:00'));

  const noon = scheduleItems(DAY, kst('2026-11-03T12:00:00'));
  assert.deepEqual(noon.map((b) => [b.badge, b.status, b.project]), [
    ['11:30', 'review', '진행 중 · ~12:30'],
    ['13:00', 'idle', '1시간 후'],
  ]);
  assert.deepEqual(scheduleItems(DAY, kst('2026-11-03T14:00:00')), []);
  assert.deepEqual(scheduleItems(DAY, kst('2026-11-04T09:00:00')), []);   // another day's list
});

test('a bubble closed with × stays closed', () => {
  const list = scheduleItems(DAY, kst('2026-11-03T09:00:00'), ['todomate:2026-11-03:e']);
  assert.deepEqual(list.map((b) => b.badge), ['10:00', '13:00']);
});

test('parseDated reads a month/day in front, the next one on or after today', () => {
  assert.deepEqual(parseDated('11/6 저널클럽 발표', '2026-11-03'), { date: '2026-11-06', title: '저널클럽 발표' });
  assert.deepEqual(parseDated('12/22 긴 발표', '2026-11-03'), { date: '2026-12-22', title: '긴 발표' });
  assert.deepEqual(parseDated('11/3(화) 오늘', '2026-11-03'), { date: '2026-11-03', title: '오늘' });
  assert.deepEqual(parseDated('1/5 새해 발표', '2026-11-03'), { date: '2027-01-05', title: '새해 발표' });
  assert.equal(parseDated('10/30 지난 발표', '2026-11-03'), null);   // passed
  assert.equal(parseDated('2/30 없는 날', '2026-11-03'), null);
  assert.equal(parseDated('13:00 미팅', '2026-11-03'), null);
  assert.equal(parseDated('서류 발급', '2026-11-03'), null);
});

const D_TODOS = [
  { id: 'a', content: '12/22 긴 발표', goalId: 'd', goalTitle: null, done: false },
  { id: 'b', content: '11/6 저널클럽 발표', goalId: 'd', goalTitle: null, done: false },
  { id: 'b2', content: '11/6 저널클럽 발표', goalId: 'd', goalTitle: null, done: false },   // the same, on another day
  { id: 'c', content: '11/10 짧은 발표', goalId: 'd', goalTitle: null, done: false },
  { id: 'x', content: '11/7 다른 카테고리', goalId: 's', goalTitle: null, done: false },
  { id: 'y', content: '마감 없음', goalId: 'd', goalTitle: null, done: false },
];
const D_GOALS = new Map([['d', 'D-Day'], ['s', 'Schedule']]);

test('countdowns: a D-X for each date every morning from 06:00, soonest first', () => {
  const list = countdownsOf(D_TODOS, D_GOALS, 'D-Day', '2026-11-03');
  assert.deepEqual(list.map((c) => [c.date, c.title]), [
    ['2026-11-06', '저널클럽 발표'],
    ['2026-11-10', '짧은 발표'],
    ['2026-12-22', '긴 발표'],
  ]);
  const at = (when) => countdownItems(list, kst(when)).map((b) => `${b.badge} ${b.title}`);
  assert.deepEqual(at('2026-11-03T09:00:00'), ['D-3 11/6(금) 저널클럽 발표', 'D-7 11/10(화) 짧은 발표', 'D-49 12/22(화) 긴 발표']);
  assert.deepEqual(at('2026-11-04T05:59:00'), ['D-3 11/6(금) 저널클럽 발표', 'D-7 11/10(화) 짧은 발표', 'D-49 12/22(화) 긴 발표']);
  assert.deepEqual(at('2026-11-04T06:00:00'), ['D-2 11/6(금) 저널클럽 발표', 'D-6 11/10(화) 짧은 발표', 'D-48 12/22(화) 긴 발표']);
  assert.deepEqual(at('2026-11-06T23:00:00').slice(0, 1), ['D-Day 11/6(금) 저널클럽 발표']);
  assert.deepEqual(at('2026-11-07T00:00:00').slice(0, 1), ['D-4 11/10(화) 짧은 발표']);   // 11/6 is over; the rest keep last morning's count until 06:00

  const [b] = countdownItems(list, kst('2026-11-03T09:00:00'));
  assert.equal(b.id, 'todomate:dday:2026-11-06:b:2026-11-03');
  assert.equal(b.kind, 'todomate');
  assert.equal(b.clearOnClick, true);
  assert.equal(b.status, 'review');
  assert.equal(b.expiresAt, kst('2026-11-04T06:00:00'));
});

test('a cleared countdown stays hidden until the next morning', () => {
  const list = countdownsOf(D_TODOS, D_GOALS, 'D-Day', '2026-11-03').slice(0, 1);
  const hidden = { 'todomate:dday:2026-11-06:b:2026-11-03': kst('2026-11-04T06:00:00') };
  assert.deepEqual(countdownItems(list, kst('2026-11-03T20:00:00'), hidden), []);
  assert.equal(countdownItems(list, kst('2026-11-04T06:00:00'), hidden)[0].badge, 'D-2');
});
