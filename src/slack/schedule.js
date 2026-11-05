'use strict';

// The presentation schedule in a Slack canvas (CONSTRAINTS.md, Slack presentation schedule): reads
// its table, finds your turns, and decides which reminder bubbles show. Pure: no clock, files or
// network (`now` is passed in), so SlackTracker does the fetching and saving and this file holds the
// rules.
//
// The canvas comes as Markdown (canvases.getContent). Its table has a 날짜 column (YYYY-MM-DD) and a
// 상태 column; 요일, 시간 and 세션 describe the slot, and every other column is a presenter column:
//   |날짜|요일|시간|세션|상태|긴 발표|짧은 발표 1|짧은 발표 2|저널클럽|
//   |2026-11-10|화|10:00-11:00|긴+짧은2|정상 진행|김철수|이영희|홍길동||
// A turn is a row whose 상태 is 정상 진행 with your name, not struck through (~~name~~), in a
// presenter column. A name struck through on a date still to come means that slot is off.
//
// A turn as this file passes it around:
//   { key: '<date>:<column>', date: 'YYYY-MM-DD', weekday, column, time: 'HH:MM-HH:MM' | '',
//     startAt: ms, endAt: ms }

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const NOTICE_TTL_MS = 3 * DAY_MS;          // how long a 순서 변경 bubble stays
const NORMAL = '정상 진행';
const SLOT_COLUMNS = new Set(['날짜', '요일', '시간', '세션', '상태']);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^(\d{1,2}):(\d{2})\s*[-~–]\s*(\d{1,2}):(\d{2})$/;
const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];
const PROJECT_LIMIT = 80;

// Each turn still to come gets one reminder a day, from SHOW_AT until the next morning's (the day's
// until the presentation ends): D-12, …, D-1, D-Day. The milestone days stand out (their ids are
// slack:remind:…; the other days' are slack:daily:…); the phone pushes each day's (phone/notify.js).
const SHOW_AT = '06:00';
const MILESTONES = { 7: 'review', 3: 'review', 1: 'waiting', 0: 'waiting' };
const dLabel = (n) => (n === 0 ? 'D-Day' : `D-${n}`);

class ScheduleFormatError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ScheduleFormatError';
  }
}

// ms of a KST wall-clock time.
const kstMs = (date, hm = '00:00') => Date.parse(`${date}T${hm.padStart(5, '0')}:00+09:00`);
const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const weekdayOf = (date) => WEEKDAYS[new Date(Date.parse(`${date}T00:00:00Z`)).getUTCDay()];

function clip(s, n) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

// A row's cells: the line split on its unescaped pipes, without the outer ones.
function cellsOf(line) {
  const body = line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '');
  return body.split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, '|').trim());
}

// What a cell says, without Markdown's emphasis and links; `struck` parts are kept apart.
function cellText(raw) {
  const plain = (s) => s
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|\*|_|`)/g, '')
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const struck = [];
  const live = String(raw ?? '').replace(/~~([^~]*)~~/g, (_, s) => {
    struck.push(plain(s));
    return ' ';
  });
  return { live: plain(live), struck: struck.filter(Boolean) };
}

// The canvas's title (its first heading), or ''.
function titleOf(markdown) {
  const m = /^#{1,6}\s+(.+?)\s*#*\s*$/m.exec(String(markdown ?? ''));
  return m ? cellText(m[1]).live : '';
}

// The schedule table's rows: [{ date, weekday, time, session, status, cells: { column: cell } }].
// Throws ScheduleFormatError when there is no table with 날짜 and 상태 columns.
function parseSchedule(markdown) {
  const lines = String(markdown ?? '').split(/\r?\n/);
  for (let i = 0; i < lines.length - 1; i++) {
    if (!lines[i].trim().startsWith('|') || !/^\s*\|?\s*:?-{3,}/.test(lines[i + 1])) continue;
    const header = cellsOf(lines[i]).map((c) => cellText(c).live);
    const col = (name) => header.indexOf(name);
    if (col('날짜') < 0 || col('상태') < 0) continue;
    const presenters = header.filter((h) => h && !SLOT_COLUMNS.has(h));
    const rows = [];
    for (let j = i + 2; j < lines.length && lines[j].trim().startsWith('|'); j++) {
      const cells = cellsOf(lines[j]);
      const at = (name) => (col(name) >= 0 ? cellText(cells[col(name)]).live : '');
      const date = at('날짜');
      if (!DATE_RE.test(date)) continue;
      rows.push({
        date,
        weekday: at('요일') || weekdayOf(date),
        time: at('시간'),
        session: at('세션'),
        status: at('상태'),
        cells: Object.fromEntries(presenters.map((p) => [p, cellText(cells[header.indexOf(p)])])),
      });
    }
    return { title: titleOf(markdown), presenters, rows };
  }
  throw new ScheduleFormatError('캔버스에서 날짜와 상태 열이 있는 표를 찾지 못했습니다.');
}

// When a turn starts and ends: its 시간, or the whole day when it has none.
function spanOf(date, time) {
  const m = TIME_RE.exec(time || '');
  if (m) return { startAt: kstMs(date, `${m[1]}:${m[2]}`), endAt: kstMs(date, `${m[3]}:${m[4]}`) };
  return { startAt: kstMs(date), endAt: kstMs(addDays(date, 1)) };
}

// `name`'s turns in the schedule, by date. A cell that has the name only struck through doesn't count.
function turnsOf(schedule, name) {
  const who = String(name ?? '').replace(/\s+/g, ' ').trim();
  if (!who) return [];
  const turns = [];
  for (const row of schedule.rows) {
    if (row.status !== NORMAL) continue;
    for (const [column, cell] of Object.entries(row.cells)) {
      if (!cell.live.includes(who)) continue;
      turns.push({ key: `${row.date}:${column}`, date: row.date, weekday: row.weekday, column, time: row.time, ...spanOf(row.date, row.time) });
    }
  }
  return turns.sort((a, b) => a.startAt - b.startAt || a.column.localeCompare(b.column));
}

// '11/10(화)'
function dayLabel(turn) {
  const [, m, d] = turn.date.split('-');
  return `${Number(m)}/${Number(d)}(${turn.weekday})`;
}

// The day whose reminders show at `now`: today from SHOW_AT on, yesterday before then.
function reminderDay(now) {
  const today = new Date(now + KST_OFFSET_MS).toISOString().slice(0, 10);
  return now >= kstMs(today, SHOW_AT) ? today : addDays(today, -1);
}

const daysBetween = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

// This morning's reminder for each turn still to come. Clicking one clears it until the next
// morning (`clearOnClick`, main.js); `hidden`: id -> until when a cleared one stays out of sight.
// `url`: the canvas. `title`: the canvas's.
function reminderItems(turns, now, { hidden = {}, url = null, title = '' } = {}) {
  const day = reminderDay(now);
  const since = kstMs(day, SHOW_AT);
  const nextMorning = kstMs(addDays(day, 1), SHOW_AT);
  const out = [];
  for (const turn of turns || []) {
    if (!(turn.endAt > now)) continue;
    const n = daysBetween(day, turn.date);
    if (n < 0) continue;
    const milestone = Object.hasOwn(MILESTONES, n);
    const id = milestone ? `slack:remind:${turn.key}:d${n}` : `slack:daily:${turn.key}:${day}`;
    if (hidden[id] > now) continue;
    const when = [dayLabel(turn), turn.time].filter(Boolean).join(' ');
    out.push({
      id,
      kind: 'slack',
      status: milestone ? MILESTONES[n] : 'idle',
      badge: dLabel(n),
      title: `${dayLabel(turn)} ${turn.column}`,
      project: clip([turn.time, title].filter(Boolean).join(' · '), PROJECT_LIMIT),
      detail: clip(`${dLabel(n)} ${when} · ${turn.column}${title ? ` · ${title}` : ''}`, 300),
      url,
      clearOnClick: true,
      since,
      expiresAt: Math.min(nextMorning, turn.endAt),
    });
  }
  return out;
}

// When the reminders next change by the clock alone: the next morning, or a turn ending.
function nextChangeAt(turns, now) {
  const upcoming = (turns || []).filter((t) => t.endAt > now);
  if (!upcoming.length) return Infinity;
  return Math.min(kstMs(addDays(reminderDay(now), 1), SHOW_AT), ...upcoming.map((t) => t.endAt));
}

// 순서 변경 bubbles: your turns still to come that appeared or went since the last check. A date
// whose turn only moved to another column is one change, not two.
function changeItems(prevTurns, turns, now, { url = null, title = '' } = {}) {
  const upcoming = (list) => new Map((list || []).filter((t) => t.endAt > now).map((t) => [t.key, t]));
  const before = upcoming(prevTurns);
  const after = upcoming(turns);
  const added = [...after.values()].filter((t) => !before.has(t.key));
  const removed = [...before.values()].filter((t) => !after.has(t.key));
  const out = [];
  const item = (turn, what) => ({
    id: `slack:change:${turn.key}:${now}`,
    kind: 'slack',
    status: 'waiting',
    badge: '순서 변경',
    title: `${dayLabel(turn)} ${turn.column}`,
    project: clip([what, title].filter(Boolean).join(' · '), PROJECT_LIMIT),
    detail: clip(`${dayLabel(turn)} ${turn.column}: ${what}`, 300),
    url,
    since: now,
    expiresAt: now + NOTICE_TTL_MS,
  });
  for (const t of added) {
    const was = removed.find((r) => r.date === t.date);
    out.push(item(t, was ? `${was.column}에서 바뀜` : '새로 잡힘'));
  }
  for (const t of removed) {
    if (!added.some((a) => a.date === t.date)) out.push(item(t, '빠짐'));
  }
  return out;
}

module.exports = {
  NORMAL,
  NOTICE_TTL_MS,
  SHOW_AT,
  ScheduleFormatError,
  changeItems,
  dayLabel,
  nextChangeAt,
  parseSchedule,
  reminderItems,
  turnsOf,
};
