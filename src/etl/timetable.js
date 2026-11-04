'use strict';

// The class timetable and the daily "오늘 수업" bubble.
//
// eTL (Canvas) has no class times, but each course's syllabus page links to the course in SNU's
// public course catalog (sugang.snu.ac.kr/sugang/cc/cc103.action?openSchyy=…&sbjtCd=…&ltNo=…).
// The catalog's detail call (cc101ajax.action) answers with the meeting times and rooms as JSON,
// to anyone holding a session cookie from its search page; no login, and the eTL token never
// goes there. The weekly timetable is cached in userData for a day.
//
// On top of the weekly classes, a day gets:
//   - the user's own changes in the chat folder's timetable.md (보강 adds a class, 휴강 drops one):
//       - 2026-10-20 보강 18:00~19:15 | 가상현실공학 | 000-101 | 메모
//       - 2026-10-21 휴강 | 나노소자개론 | 메모
//   - eTL calendar events on that day in this term's courses (some instructors post 보강 there).
//
// TimetableNotifier turns today into one bubble per class, from SHOW_FROM_HOUR until that class
// ends, and keeps the time to each current every minute. × hides that one for the rest of the day.

const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { EtlAuthError } = require('./client');
const { currentCourses } = require('./model');

const SUGANG = 'https://sugang.snu.ac.kr';
const SEARCH_PATH = '/sugang/cc/cc100InterfaceSrch.action';
const DETAIL_PATH = '/sugang/cc/cc101ajax.action';
const REF_KEYS = ['openSchyy', 'openShtmFg', 'openDetaShtmFg', 'sbjtCd', 'ltNo', 'sbjtSubhCd'];
const REF_VALUE_RE = /^[\w.-]{1,40}$/;
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKDAYS = '일월화수목금토';
const CACHE_VERSION = 1;
const CACHE_MS = DAY_MS;
const TIMEOUT_MS = 15 * 1000;
const SHOW_FROM_HOUR = 6;                  // KST; the bubble appears from then on
const TICK_MS = 60 * 1000;
const CHANGES_FILE = 'timetable.md';
const MAX_CHANGES_BYTES = 256 * 1024;
const ETL_URL = 'https://myetl.snu.ac.kr/';
const CONTEXTS_PER_REQUEST = 10;           // Canvas takes at most 10 context_codes at once
const TITLE_LIMIT = 200;
const PROJECT_LIMIT = 80;
const TIME_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ---------------------------------------------------------------- dates (KST)

const kstParts = (ms) => {
  const d = new Date(ms + KST_OFFSET_MS);
  return { date: d.toISOString().slice(0, 10), weekday: WEEKDAYS[d.getUTCDay()], hour: d.getUTCHours() };
};

const pad = (n) => String(n).padStart(2, '0');

// '9:30' -> '09:30', or null.
function normTime(s) {
  const m = TIME_RE.exec(String(s ?? '').trim());
  return m ? `${pad(Number(m[1]))}:${m[2]}` : null;
}

// The moment `HH:MM` on a KST date.
const atKst = (date, time) => Date.parse(`${date}T${time}:00+09:00`);

function isDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const ms = Date.parse(`${s}T00:00:00Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === s;
}

const weekdayOf = (date) => WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()];

// "2026-2 가상현실공학 (001)" -> "가상현실공학".
function shortName(name) {
  return String(name ?? '').replace(/^\s*\d{4}-\d\s+/, '').replace(/\s*\(\d{3}\)\s*$/, '').trim() || String(name ?? '');
}

const squash = (s) => String(s ?? '').toLowerCase().replace(/[\s·.:()\-_]/g, '');

// Whether a name the user wrote means this course: either contains the other, ignoring spaces
// and punctuation ("가현공" won't match, "가상현실공학" and "현실공학" will).
function sameCourse(written, course) {
  const a = squash(written);
  const b = squash(shortName(course));
  return Boolean(a && b) && (a.includes(b) || b.includes(a));
}

// ---------------------------------------------------------------- the catalog

// The catalog reference in a course's syllabus HTML, or null.
function catalogRef(html) {
  const text = String(html ?? '').replace(/&amp;/g, '&');
  const m = /sugang\.snu\.ac\.kr\/sugang\/cc\/cc10[13]\.action\?([^"'\s<>]+)/.exec(text);
  if (!m) return null;
  const q = new URLSearchParams(m[1]);
  const ref = {};
  for (const key of REF_KEYS) {
    const value = q.get(key) ?? (key === 'sbjtSubhCd' ? '000' : null);
    if (value == null || !REF_VALUE_RE.test(value)) return null;
    ref[key] = value;
  }
  return ref;
}

// A room as the catalog writes it, without its "(무선랜제공)"-style notes.
const cleanRoom = (s) => String(s ?? '').replace(/\([^)]*\)/g, '').trim() || null;

// The meetings in a cc101ajax answer: [{ day: '월', start: '17:00', end: '18:15', room }].
function parseMeetings(detail) {
  const out = [];
  const summary = detail?.LISTTAB01?.lsnTmtablFormaSmryCtnt;
  const re = /^\s*([일월화수목금토])\((\d{1,2}:\d{2})~(\d{1,2}:\d{2})\)/;
  if (typeof summary === 'string' && summary.trim()) {
    for (const part of summary.split('/')) {
      const [when, , room] = part.split('|');
      const m = re.exec(when || '');
      if (m && normTime(m[2]) && normTime(m[3])) {
        out.push({ day: m[1], start: normTime(m[2]), end: normTime(m[3]), room: cleanRoom(room) });
      }
    }
    if (out.length) return out;
  }
  const times = Array.isArray(detail?.ltTime) ? detail.ltTime : [];
  const rooms = Array.isArray(detail?.ltRoom) ? detail.ltRoom : [];
  times.forEach((t, i) => {
    const m = re.exec(String(t));
    if (m && normTime(m[2]) && normTime(m[3])) {
      out.push({ day: m[1], start: normTime(m[2]), end: normTime(m[3]), room: cleanRoom(rooms[i]) });
    }
  });
  return out;
}

// Asks the catalog about each ref, one at a time: Map(index -> meetings | Error).
async function fetchCatalog(refs, { fetch = globalThis.fetch, timeoutMs = TIMEOUT_MS } = {}) {
  const results = new Map();
  if (!refs.length) return results;
  const signal = () => (timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined);
  const first = await fetch(SUGANG + SEARCH_PATH, { redirect: 'manual', signal: signal() });
  const cookies = typeof first.headers?.getSetCookie === 'function' ? first.headers.getSetCookie() : [];
  const cookie = cookies.map((c) => String(c).split(';')[0]).filter(Boolean).join('; ');
  for (const [i, ref] of refs.entries()) {
    try {
      const res = await fetch(SUGANG + DETAIL_PATH, {
        method: 'POST',
        body: new URLSearchParams({ ...ref, t_profPersNo: '' }).toString(),
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'X-Requested-With': 'XMLHttpRequest',
          Referer: SUGANG + SEARCH_PATH,
          ...(cookie ? { Cookie: cookie } : {}),
        },
        signal: signal(),
      });
      if (!res.ok) throw new Error(`수강편람 응답 오류(${res.status})`);
      let detail;
      try {
        detail = JSON.parse(await res.text());
      } catch {
        throw new Error('수강편람 응답을 해석할 수 없습니다');
      }
      results.set(i, parseMeetings(detail));
    } catch (err) {
      const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
      results.set(i, new Error(timedOut ? '수강편람 응답 시간 초과' : String(err?.message || err)));
    }
  }
  return results;
}

// ---------------------------------------------------------------- the user's changes

// timetable.md's change lines; anything else in the file is left alone.
function parseChanges(text) {
  const out = [];
  const re = /^\s*[-*]\s*(\d{4}-\d{2}-\d{2})\s*(?:\([일월화수목금토]\))?\s+(보강|휴강)\s*(?:(\d{1,2}:\d{2})\s*[~\-–]\s*(\d{1,2}:\d{2}))?\s*(?:\|(.*))?$/;
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = re.exec(line);
    if (!m || !isDate(m[1])) continue;
    const fields = (m[5] ?? '').split('|').map((s) => s.trim());
    const kind = m[2];
    const start = normTime(m[3]);
    const end = normTime(m[4]);
    if (kind === '보강' && (!start || !end)) continue;
    if (kind === '보강') {
      out.push({ date: m[1], kind, start, end, course: fields[0] || null, room: fields[1] || null, note: fields.slice(2).join(' | ') || null });
    } else {
      out.push({ date: m[1], kind, start, end, course: fields[0] || null, note: fields.slice(1).join(' | ') || null });
    }
  }
  return out;
}

function readChanges(dir) {
  if (!dir) return [];
  try {
    const file = path.join(dir, CHANGES_FILE);
    if (fs.statSync(file).size > MAX_CHANGES_BYTES) return [];
    return parseChanges(fs.readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------- one day

// The classes on `date`: the weekly ones (minus 휴강), 보강 from timetable.md and eTL events,
// sorted by start time. Pure.
function dayClasses({ date, weekly, changes = [], events = [] }) {
  const weekday = weekdayOf(date);
  const todays = changes.filter((c) => c.date === date);
  const cancels = todays.filter((c) => c.kind === '휴강');
  const cancelled = [];
  const classes = [];
  for (const course of weekly?.courses || []) {
    for (const m of course.meetings || []) {
      if (m.day !== weekday) continue;
      const entry = {
        start: m.start, end: m.end, course: shortName(course.name), course_id: course.course_id, room: m.room, kind: '정규',
      };
      const off = cancels.find((c) => sameCourse(c.course, course.name)
        && (!c.start || c.start === m.start));
      if (off) cancelled.push({ ...entry, note: off.note });
      else classes.push(entry);
    }
  }
  for (const c of todays.filter((x) => x.kind === '보강')) {
    const course = (weekly?.courses || []).find((k) => sameCourse(c.course, k.name));
    classes.push({
      start: c.start, end: c.end, course: course ? shortName(course.name) : c.course || '보강',
      course_id: course?.course_id ?? null, room: c.room, kind: '보강', note: c.note,
    });
  }
  for (const e of events) classes.push(e);
  classes.sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end));
  return { date, weekday, classes, cancelled };
}

// eTL calendar events (type=event) on `date` in `courses`, as classes of kind '일정'.
async function calendarClasses(client, courses, date) {
  const names = new Map(courses.map((c) => [`course_${c.id}`, c]));
  const codes = [...names.keys()];
  const out = [];
  for (let i = 0; i < codes.length; i += CONTEXTS_PER_REQUEST) {
    const contexts = codes.slice(i, i + CONTEXTS_PER_REQUEST).map((c) => `context_codes[]=${c}`).join('&');
    const list = await client.getAll(`/api/v1/calendar_events?type=event&start_date=${date}&end_date=${date}&per_page=100&${contexts}`);
    for (const e of list || []) {
      const start = Date.parse(e?.start_at);
      if (!Number.isFinite(start) || e.all_day) continue;
      const end = Number.isFinite(Date.parse(e.end_at)) ? Date.parse(e.end_at) : start;
      const s = kstParts(start);
      if (s.date !== date) continue;
      const hm = (ms) => new Date(ms + KST_OFFSET_MS).toISOString().slice(11, 16);
      const course = names.get(e.context_code);
      out.push({
        start: hm(start), end: hm(end), course: course ? shortName(course.name) : String(e.context_name || ''),
        course_id: course?.id ?? null, room: e.location_name || null, kind: '일정',
        note: String(e.title ?? '').slice(0, 100) || null,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------- the weekly timetable

function createTimetable({ cacheFile, fetch = globalThis.fetch, now = Date.now, workspaceDir = () => null } = {}) {
  let memo = null;

  function readCache() {
    if (memo) return memo;
    try {
      const j = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (j?.version === CACHE_VERSION) memo = j;
    } catch {
      // none yet
    }
    return memo;
  }

  function writeCache(patch) {
    memo = { ...(readCache() || { version: CACHE_VERSION }), ...patch, version: CACHE_VERSION };
    if (!cacheFile) return;
    try {
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      fs.writeFileSync(`${cacheFile}.tmp`, JSON.stringify(memo), 'utf8');
      fs.renameSync(`${cacheFile}.tmp`, cacheFile);
    } catch {
      // kept in memory; written again next time
    }
  }

  // This term's courses with their meetings: { fetchedAt, courses: [{ course_id, name, meetings }],
  // errors: ['<course>: <why>'] }. Cached for a day, or until the term's courses change.
  async function weekly(client, { force = false } = {}) {
    const list = currentCourses(await client.getAll(
      '/api/v1/courses?enrollment_state=active&include[]=term&include[]=syllabus_body&per_page=100',
    ));
    const ids = list.map((c) => c.id).sort((a, b) => a - b).join(',');
    const cached = readCache()?.weekly;
    if (!force && cached && cached.ids === ids && now() - cached.fetchedAt < CACHE_MS) return cached;

    const refs = list.map((c) => catalogRef(c.syllabus_body));
    const asked = refs.map((r, i) => (r ? i : -1)).filter((i) => i >= 0);
    const answers = await fetchCatalog(asked.map((i) => refs[i]), { fetch });
    const courses = [];
    const errors = [];
    list.forEach((c, i) => {
      const k = asked.indexOf(i);
      const got = k >= 0 ? answers.get(k) : new Error('강의계획서에 수강편람 링크가 없습니다');
      if (got instanceof Error) {
        errors.push(`${shortName(c.name)}: ${got.message}`);
        const old = cached?.courses?.find((x) => x.course_id === c.id);   // keep what we knew
        courses.push({ course_id: c.id, name: c.name, meetings: old?.meetings || [] });
      } else {
        courses.push({ course_id: c.id, name: c.name, meetings: got || [] });
      }
    });
    const result = { ids, fetchedAt: now(), courses, errors };
    writeCache({ weekly: result });
    return result;
  }

  // What a day is made of, from the network: { date, weekly, events, errors }.
  async function fetchDay(client, date, options = {}) {
    const w = await weekly(client, options);
    const courses = w.courses.map((c) => ({ id: c.course_id, name: c.name }));
    const errors = [...w.errors];
    let events = [];
    try {
      events = await calendarClasses(client, courses, date);
    } catch (err) {
      if (err instanceof EtlAuthError) throw err;
      errors.push(`eTL 일정: ${err.message}`);
    }
    return { date, weekly: w, events, errors };
  }

  // The day with timetable.md as it is now (read afresh, so the user's edits show at once).
  const compose = ({ date, weekly: w, events, errors }) => ({
    ...dayClasses({ date, weekly: w, changes: readChanges(workspaceDir()), events }),
    errors,
  });

  const day = async (client, date, options) => compose(await fetchDay(client, date, options));

  return { weekly, fetchDay, compose, day, readCache, writeCache };
}

// ---------------------------------------------------------------- the bubble

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

// Today's bubbles, one per class, in start order: each from SHOW_FROM_HOUR until its class ends.
// The class under way, or else the next one, stands out ('review'), with any starting at the same
// time; the rest stay quiet ('idle', after other bubbles, and the pet keeps idling for them). They
// carry no `since`, so no "5m" shows and they keep this order among themselves. `dismissed` holds
// ids closed with ×.
function timetableItems(today, nowMs, dismissed = []) {
  const { date, classes, cancelled } = today;
  const { hour, date: nowDate } = kstParts(nowMs);
  if (nowDate !== date || hour < SHOW_FROM_HOUR) return [];
  const left = (c) => nowMs < atKst(date, c.end);
  const focus = classes.find((c) => left(c));          // under way, or the next to start
  const idOf = (c) => `etl:timetable:${date}:${c.start}:${c.kind}:${c.course_id ?? squash(c.course)}`;
  const where = (c) => (c.room ? [c.room] : []);
  const items = [];
  for (const c of classes.filter(left)) {
    const startMs = atKst(date, c.start);
    const when = startMs <= nowMs ? `수업 중 · ~${c.end}` : inMinutes(startMs - nowMs);
    items.push({
      c,
      badge: c.kind === '정규' ? c.start : `${c.kind} ${c.start}`,
      project: [...where(c), when, ...(c.note ? [c.note] : [])].join(' · '),
      status: c.start === focus.start ? 'review' : 'idle',
    });
  }
  for (const c of cancelled.filter(left)) {
    items.push({ c, badge: '휴강', project: [`${c.start} 수업 없음`, ...(c.note ? [c.note] : [])].join(' · '), status: 'idle' });
  }
  const order = (x) => atKst(date, x.c.start);
  return items
    .sort((a, b) => order(a) - order(b))
    .map(({ c, badge, project, status }) => ({
      id: idOf(c),
      kind: 'etl',
      status,
      badge,
      title: clip(c.course, TITLE_LIMIT),
      project: clip(project, PROJECT_LIMIT),
      detail: clip(`${c.start}~${c.end} ${c.course}${c.room ? ` · ${c.room}` : ''}${c.note ? ` · ${c.note}` : ''}`, 300),
      url: c.course_id ? `${ETL_URL}courses/${c.course_id}` : ETL_URL,
      keepOnOpen: true,              // clicking opens the course; only × closes it (main.js)
      startsAt: atKst(date, c.start),   // in one timeline with TodoMate's schedule (timeline.js)
      expiresAt: atKst(date, c.end),
    }))
    .filter((it) => !dismissed.includes(it.id));
}

// Keeps today's bubbles: fetches the day's classes at start, every REFRESH_MS, when asked (on
// "지금 확인") and when the day changes, and redoes the bubbles every minute, timetable.md included.
const REFRESH_MS = 30 * 60 * 1000;
const RETRY_MS = 5 * 60 * 1000;           // after a failed fetch, or on a new day

class TimetableNotifier extends EventEmitter {
  constructor({ timetable, createClient, now = Date.now, timers = { setInterval, clearInterval } } = {}) {
    super();
    this.timetable = timetable;
    this.createClient = createClient;
    this.now = now;
    this.timers = timers;
    this.parts = null;            // fetchDay() result for the current KST date
    this.closed = null;           // { date, ids } closed with × today, in memory only
    this.loadedAt = 0;
    this.interval = null;
    this.inflight = null;
    this.lastKey = null;
    this.running = false;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.interval = this.timers.setInterval(() => this.tick(), TICK_MS);
    this.refresh();
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    this.timers.clearInterval(this.interval);
    this.interval = null;
    this.lastKey = null;
    this.emit('change', []);
  }

  refresh() {
    if (!this.running) return Promise.resolve();
    if (!this.inflight) {
      this.inflight = this.load().finally(() => { this.inflight = null; });
    }
    return this.inflight;
  }

  async load() {
    this.loadedAt = this.now();
    let client;
    try {
      client = this.createClient();
    } catch {
      client = null;
    }
    if (!client) return;
    const date = kstParts(this.now()).date;
    try {
      const parts = await this.timetable.fetchDay(client, date);
      if (this.running) this.parts = parts;
    } catch (err) {
      if (this.listenerCount('error')) this.emit('error', err);
    }
    this.tick();
  }

  // Ids closed today; yesterday's are forgotten. They're kept in memory only, so a class closed
  // by mistake comes back when the pet restarts.
  dismissedToday() {
    const today = kstParts(this.now()).date;
    return this.closed?.date === today ? this.closed.ids : [];
  }

  dismiss(id) {
    if (!String(id).startsWith('etl:timetable:')) return;
    const ids = this.dismissedToday();
    if (!ids.includes(id)) this.closed = { date: kstParts(this.now()).date, ids: [...ids, id] };
    this.tick(true);
  }

  items() {
    if (!this.running || !this.parts) return [];
    return timetableItems(this.timetable.compose(this.parts), this.now(), this.dismissedToday());
  }

  tick(force = false) {
    if (!this.running) return;
    const nowMs = this.now();
    if (this.parts && this.parts.date !== kstParts(nowMs).date) this.parts = null;   // a new day
    if (!this.inflight && nowMs - this.loadedAt >= (this.parts ? REFRESH_MS : RETRY_MS)) this.refresh();
    const list = this.items();
    const key = JSON.stringify(list);
    if (force || key !== this.lastKey) {
      this.lastKey = key;
      this.emit('change', list);
    }
  }
}

module.exports = {
  CHANGES_FILE,
  SHOW_FROM_HOUR,
  TimetableNotifier,
  catalogRef,
  createTimetable,
  dayClasses,
  fetchCatalog,
  isDate,
  kstParts,
  parseChanges,
  parseMeetings,
  readChanges,
  sameCourse,
  shortName,
  timetableItems,
};
