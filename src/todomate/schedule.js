'use strict';

// Today's timed TodoMate items as bubbles, like eTL's "오늘 수업" (etl/timetable.js).
//
// TodoMate (through PlayMCP, see mcp.js) lists the day's todos; the pet keeps those in one
// category (`Schedule` unless the user names another) whose text starts with a time:
//   13:00 프로젝트 미팅
//   11:30-12:30 세미나 (101-201)        (also 11:30~12:30)
// An item without an end time lasts DEFAULT_MINUTES. Checked or not, each shows from
// SHOW_FROM_HOUR until it ends; untimed items in that category are left out.
//
// What loadTodoItems and loadGoals answer isn't documented, so todosOf() and goalsOf() look for
// todo-like and category-like objects anywhere in the JSON instead of at one fixed place.

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const SHOW_FROM_HOUR = 6;                  // KST; the bubbles appear from then on
const DEFAULT_MINUTES = 60;
const TITLE_LIMIT = 200;
const PROJECT_LIMIT = 80;
// "13:00 …", "9:30 …", "11:30-12:30 …", "11:30 ~ 12:30 …"
const TIMED_RE = /^\s*([01]?\d|2[0-3]):([0-5]\d)(?:\s*[-~–]\s*([01]?\d|2[0-3]):([0-5]\d))?\s+(\S.*)$/s;

const pad = (n) => String(n).padStart(2, '0');

// { date: 'YYYY-MM-DD', hour } in KST.
function kstParts(ms) {
  const d = new Date(ms + KST_OFFSET_MS);
  return { date: d.toISOString().slice(0, 10), hour: d.getUTCHours() };
}

// The moment `HH:MM` on a KST date.
const atKst = (date, time) => Date.parse(`${date}T${time}:00+09:00`);

// '13:00 프로젝트 미팅' -> { start: '13:00', end: '14:00', title: '프로젝트 미팅' }, or null when the
// text doesn't start with a time. An end at or before the start runs to the end of the day.
function parseTimed(text) {
  const m = TIMED_RE.exec(String(text ?? ''));
  if (!m) return null;
  const start = `${pad(Number(m[1]))}:${m[2]}`;
  const startMin = Number(m[1]) * 60 + Number(m[2]);
  let endMin = m[3] != null ? Number(m[3]) * 60 + Number(m[4]) : startMin + DEFAULT_MINUTES;
  if (endMin <= startMin) endMin = startMin + DEFAULT_MINUTES;
  endMin = Math.min(endMin, 24 * 60 - 1);
  const end = `${pad(Math.floor(endMin / 60))}:${pad(endMin % 60)}`;
  return { start, end, title: m[5].replace(/\s+/g, ' ').trim() };
}

// ---------------------------------------------------------------- reading the tools' answers

const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const first = (o, keys) => keys.map((k) => o[k]).find((v) => v != null && v !== '');

function walk(value, visit, depth = 0) {
  if (depth > 8 || value == null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const v of value) walk(v, visit, depth + 1);
    return;
  }
  visit(value);
  for (const v of Object.values(value)) walk(v, visit, depth + 1);
}

// A todo's category title, as the todo itself names it (or null: then goalId leads to loadGoals).
function goalTitleOf(o) {
  const named = str(first(o, ['goal_title', 'goalTitle', 'goal_name', 'goalName', 'category', 'category_title', 'categoryTitle']));
  if (named) return named;
  const goal = o.goal ?? o.category;
  return goal && typeof goal === 'object' ? str(first(goal, ['title', 'name'])) : null;
}

// Every todo in a tool's answer: { id, content, goalId, goalTitle, done }.
function todosOf(payload) {
  const out = [];
  walk(payload, (o) => {
    const content = str(o.content);
    if (!content) return;
    const id = str(String(first(o, ['id', 'todo_id', 'todoId', 'todoID']) ?? '')) ?? null;
    const goalId = first(o, ['goal_id', 'goalId', 'goalID']);
    const done = first(o, ['is_done', 'isDone', 'done', 'completed']);
    out.push({ id, content, goalId: goalId == null ? null : String(goalId), goalTitle: goalTitleOf(o), done: done === true });
  });
  return out;
}

// Every category in loadGoals' answer: id -> title.
function goalsOf(payload) {
  const map = new Map();
  walk(payload, (o) => {
    const id = first(o, ['id', 'goal_id', 'goalId', 'goalID']);
    const title = str(first(o, ['title', 'name', 'goal_title', 'goalTitle']));
    if (id != null && title && o.content == null) map.set(String(id), title);
  });
  return map;
}

const squash = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, '');

// The day's timed items in `category` (matched ignoring case and spaces), in start order:
// [{ id, start, end, title, done }]. `goals`: goalsOf(loadGoals), for todos that give only an id.
function scheduleOf(todos, goals, category) {
  const want = squash(category);
  return todos
    .filter((t) => squash(t.goalTitle ?? goals.get(t.goalId ?? '') ?? '') === want)
    .map((t) => {
      const timed = parseTimed(t.content);
      return timed && { id: t.id, done: t.done, ...timed };
    })
    .filter(Boolean)
    .sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end));
}

// ---------------------------------------------------------------- the bubbles

const clip = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

function inMinutes(ms) {
  const mins = Math.max(0, Math.round(ms / 60000));
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h ? (m ? `${h}시간 ${m}분 후` : `${h}시간 후`) : `${m}분 후`;
}

// Today's bubbles, one per item, from SHOW_FROM_HOUR until each ends. The one under way, or else
// the next, stands out ('review') with any starting at the same time; the rest stay quiet ('idle'),
// as eTL's classes do. `dismissed` holds ids closed with ×.
function scheduleItems({ date, items }, nowMs, dismissed = []) {
  const { hour, date: nowDate } = kstParts(nowMs);
  if (nowDate !== date || hour < SHOW_FROM_HOUR) return [];
  const left = items.filter((it) => nowMs < atKst(date, it.end));
  const focus = left[0];
  return left
    .map((it) => {
      const startMs = atKst(date, it.start);
      const when = startMs <= nowMs ? `진행 중 · ~${it.end}` : inMinutes(startMs - nowMs);
      return {
        id: `todomate:${date}:${it.id ?? `${it.start}:${squash(it.title)}`}`,
        kind: 'todomate',
        status: it.start === focus.start ? 'review' : 'idle',
        badge: it.start,
        title: clip(it.title, TITLE_LIMIT),
        project: clip(when, PROJECT_LIMIT),
        detail: clip(`${it.start}~${it.end} ${it.title}`, 300),
        keepOnOpen: true,            // a click does nothing; only × closes it (main.js)
        startsAt: startMs,           // in one timeline with eTL's classes (timeline.js)
        expiresAt: atKst(date, it.end),
      };
    })
    .filter((b) => !dismissed.includes(b.id));
}

// ---------------------------------------------------------------- D-Day countdowns
//
// Items of the D-Day category whose text starts with a date count down to it:
//   11/6 저널클럽 발표   ->   D-3 11/6(금) 저널클럽 발표
// Each morning from SHOW_FROM_HOUR one bubble per date still to come, until that day ends. A date
// without a year is the next one on or after today, unless it's less than PAST_DAYS behind: then
// it has passed and shows no more.

const WEEKDAYS = '일월화수목금토';
const DAY_MS = 24 * 60 * 60 * 1000;
const PAST_DAYS = 180;
const DATED_RE = /^\s*(1[0-2]|0?[1-9])\/(3[01]|[12]\d|0?[1-9])(?:\s*\([^)]{1,3}\))?\s+(\S.*)$/s;
// The milestone days stand out (and Slack's push on the phone); the rest stay quiet.
const COUNTDOWN_STATUS = { 7: 'review', 3: 'review', 1: 'waiting', 0: 'waiting' };

const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const daysBetween = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
const weekdayOf = (date) => WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()];
const dLabel = (n) => (n === 0 ? 'D-Day' : `D-${n}`);

// The day whose countdown shows at `nowMs`: today from SHOW_FROM_HOUR on, yesterday before then.
function countdownDay(nowMs) {
  const { date, hour } = kstParts(nowMs);
  return hour >= SHOW_FROM_HOUR ? date : addDays(date, -1);
}

// '11/6 저널클럽 발표' on 2026-11-03 -> { date: '2026-11-06', title: '저널클럽 발표' }, or null
// for text without a date in front, or a date that has passed.
function parseDated(text, today) {
  const m = DATED_RE.exec(String(text ?? ''));
  if (!m) return null;
  const year = Number(today.slice(0, 4));
  const on = (y) => `${y}-${pad(Number(m[1]))}-${pad(Number(m[2]))}`;
  const valid = (d) => new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;
  let date = on(year);
  if (!valid(date)) return null;
  if (date < today) {
    if (daysBetween(date, today) < PAST_DAYS) return null;
    date = on(year + 1);
    if (!valid(date)) return null;
  }
  return { date, title: m[3].replace(/\s+/g, ' ').trim() };
}

// The countdowns in `category`, one per date and title, soonest first: [{ id, date, title }].
function countdownsOf(todos, goals, category, today) {
  const want = squash(category);
  const seen = new Set();
  const out = [];
  for (const t of todos) {
    if (squash(t.goalTitle ?? goals.get(t.goalId ?? '') ?? '') !== want) continue;
    const d = parseDated(t.content, today);
    if (!d || seen.has(`${d.date}|${squash(d.title)}`)) continue;
    seen.add(`${d.date}|${squash(d.title)}`);
    out.push({ id: t.id, ...d });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title));
}

// This morning's countdown bubbles. Clicking one clears it until the next morning (`clearOnClick`,
// main.js); `hidden`: id -> until when a cleared one stays out of sight.
function countdownItems(list, nowMs, hidden = {}) {
  const day = countdownDay(nowMs);
  const nextMorning = Date.parse(`${addDays(day, 1)}T${pad(SHOW_FROM_HOUR)}:00:00+09:00`);
  const out = [];
  for (const c of list) {
    const n = daysBetween(day, c.date);
    const ends = Date.parse(`${addDays(c.date, 1)}T00:00:00+09:00`);
    if (n < 0 || nowMs >= ends) continue;
    const [, mm, dd] = c.date.split('-');
    const when = `${Number(mm)}/${Number(dd)}(${weekdayOf(c.date)})`;
    const id = `todomate:dday:${c.date}:${c.id ?? squash(c.title)}:${day}`;
    if (hidden[id] > nowMs) continue;
    out.push({
      id,
      kind: 'todomate',
      status: COUNTDOWN_STATUS[n] ?? 'idle',
      badge: dLabel(n),
      title: clip(`${when} ${c.title}`, TITLE_LIMIT),
      project: '',
      detail: clip(`${dLabel(n)} ${when} ${c.title}`, 300),
      clearOnClick: true,
      expiresAt: Math.min(nextMorning, ends),
    });
  }
  return out;
}

module.exports = {
  DEFAULT_MINUTES,
  SHOW_FROM_HOUR,
  countdownDay,
  countdownItems,
  countdownsOf,
  goalsOf,
  kstParts,
  parseDated,
  parseTimed,
  scheduleItems,
  scheduleOf,
  todosOf,
};
