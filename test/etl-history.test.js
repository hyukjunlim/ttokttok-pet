'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EtlHistory, KEEP_MS } = require('../src/etl/history');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const T0 = Date.parse('2026-11-05T05:02:00.000Z');   // 2026-11-05(목) 14:02 KST

function setup(t, start = T0) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'etl-history-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const clock = { now: start };
  const logs = [];
  const make = () => new EtlHistory({ dir, now: () => clock.now, log: (...a) => logs.push(a.join(' ')) });
  const read = () => {
    try {
      return fs.readFileSync(path.join(dir, 'etl-history.log'), 'utf8').split('\n').filter(Boolean);
    } catch {
      return [];
    }
  };
  return { dir, clock, logs, make, read };
}

const newAssignment = (extra = {}) => ({
  id: 'etl:new:100001:200001',
  kind: 'etl',
  badge: '새 과제',
  title: '과제 3',
  project: '2일 남음 · 공학 세미나',
  detail: '공학 세미나 · 마감 2026-11-07(토) 23:59 (2일 9시간 남음)',
  url: 'https://myetl.snu.ac.kr/courses/100001/assignments/200001',
  since: T0,
  ...extra,
});

test('each bubble is written once, as one readable line with the time, badge, title, detail and link', (t) => {
  const { make, read } = setup(t);
  const h = make();
  h.record([newAssignment()]);
  assert.deepEqual(read(), [
    '2026-11-05(목) 14:02  [새 과제] 과제 3 — 공학 세미나 · 마감 2026-11-07(토) 23:59 (2일 9시간 남음)  https://myetl.snu.ac.kr/courses/100001/assignments/200001',
  ]);
  h.record([newAssignment()]);
  assert.equal(read().length, 1);
});

test('new bubbles go at the bottom; the eTL 비서 bubble is not written', (t) => {
  const { clock, make, read } = setup(t);
  const h = make();
  h.record([newAssignment(), { id: 'etl:assistant', kind: 'etl', badge: 'eTL 비서', title: '오늘 브리핑', since: T0 }]);
  clock.now += 30 * 60 * 1000;
  h.record([
    newAssignment(),
    { id: 'etl:ann:300001', kind: 'etl', badge: '새 공지', title: '중간고사 안내', project: '공학 세미나', detail: '공학 세미나 · 시험은 다음 주입니다.', url: 'https://myetl.snu.ac.kr/courses/100001/discussion_topics/300001', since: clock.now },
  ]);
  const lines = read();
  assert.equal(lines.length, 2);
  assert.match(lines[0], /\[새 과제\] 과제 3/);
  assert.equal(lines[1], '2026-11-05(목) 14:32  [새 공지] 중간고사 안내 — 공학 세미나 · 시험은 다음 주입니다.  https://myetl.snu.ac.kr/courses/100001/discussion_topics/300001');
  assert.ok(!lines.some((l) => l.includes('eTL 비서')));
});

test('a deadline whose time left ticks down, or whose badge turns 제출함, is still one line', (t) => {
  const { clock, make, read } = setup(t);
  const h = make();
  const deadline = (extra) => ({
    id: 'etl:deadline:100001:200001', kind: 'etl', badge: '마감 임박', title: '과제 3',
    project: '미제출 · 5시간 남음 · 공학 세미나', detail: '공학 세미나 · 마감 2026-11-05(목) 19:02',
    since: T0 - 19 * HOUR, ...extra,
  });
  h.record([deadline()]);
  clock.now += HOUR;
  h.record([deadline({ project: '미제출 · 4시간 남음 · 공학 세미나' })]);
  h.record([deadline({ badge: '제출함', project: '마감 3시간 남음 · 공학 세미나' })]);
  assert.equal(read().length, 1);
});

test('a bubble still showing after a restart is not written again', (t) => {
  const { clock, make, read } = setup(t);
  make().record([newAssignment()]);
  clock.now += HOUR;
  make().record([newAssignment()]);
  assert.equal(read().length, 1);
});

test('the same id shown again later (a token that expires a second time) is written again', (t) => {
  const { clock, make, read } = setup(t);
  const h = make();
  const token = (since) => ({ id: 'etl:token', kind: 'etl', badge: '토큰 만료', title: 'eTL 토큰이 만료되었습니다', detail: '새 토큰을 등록해 주세요.', since });
  h.record([token(T0)]);
  clock.now += 5 * DAY;
  h.record([token(clock.now)]);
  const lines = read();
  assert.equal(lines.length, 2);
  assert.match(lines[1], /^2026-11-10\(화\) 14:02  \[토큰 만료\]/);
});

test('today\'s classes, which carry no since, are written once a day by their dated ids', (t) => {
  const { clock, make, read } = setup(t);
  const h = make();
  const cls = (date) => ({ id: `etl:timetable:${date}:09:30:정규:100001`, kind: 'etl', badge: '09:30', title: '공학 세미나', detail: '09:30~10:45 공학 세미나 · 301-101', project: '301-101 · 10분 후' });
  h.record([cls('2026-11-05')]);
  h.record([{ ...cls('2026-11-05'), project: '301-101 · 수업 중 · ~10:45' }]);
  clock.now += DAY;
  h.record([cls('2026-11-06')]);
  assert.equal(read().length, 2);
});

test('lines and keys older than about three months are dropped, the rest kept', (t) => {
  const { dir, clock, make, read } = setup(t);
  const h = make();
  h.record([newAssignment()]);
  clock.now += 10 * DAY;
  h.record([newAssignment({ id: 'etl:new:100001:200002', title: '과제 4', since: clock.now })]);
  clock.now = T0 + KEEP_MS + DAY;
  h.record([]);
  const lines = read();
  assert.equal(lines.length, 1);
  assert.match(lines[0], /과제 4/);
  const seen = JSON.parse(fs.readFileSync(path.join(dir, 'etl-history-seen.json'), 'utf8')).seen;
  assert.deepEqual(Object.keys(seen), [`etl:new:100001:200002@${T0 + 10 * DAY}`]);
});

test('a history that can\'t be written is logged and never throws', (t) => {
  const { dir, logs } = setup(t);
  const blocked = path.join(dir, 'not-a-folder');
  fs.writeFileSync(blocked, '');
  const h = new EtlHistory({ dir: blocked, now: () => T0, log: (...a) => logs.push(a.join(' ')) });
  assert.doesNotThrow(() => h.record([newAssignment()]));
  assert.equal(logs.length, 1);
  assert.match(logs[0], /^etl history:/);
});
