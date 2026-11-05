'use strict';

// Which changes make the phone buzz (CONSTRAINTS.md, Phone companion): a session that turns Ready,
// Needs you or Error; a new eTL bubble of the kinds that matter; Slack's presentation reminder for
// each turn every day (from 06:00) and 순서 변경; TodoMate's D-Day countdowns every day (from 06:00)
// and each schedule item SCHEDULE_LEAD_MS before it starts. What the pet already shows when the
// phone companion starts doesn't buzz (a schedule item about to start still does), and neither does
// a session hidden from the sidebar, or one that only dropped out of the list and came back as it
// was.

const LABELS = { waiting: 'Needs you', failed: 'Error', review: 'Ready' };
// The notices' kinds, as a notification names them; each can be turned off in the tray menu.
const NOTICE_SOURCES = { etl: 'eTL', slack: 'Slack', todomate: '투두메이트' };
// eTL's bubbles by id (etl/watch.js): 토큰 만료, 새 과제, 마감 변경, 성적, the announcements, and
// 마감 임박. Not today's classes, the first check's summary, or the assistant.
const ETL_PUSH = /^etl:(token$|(new|due|grade|ann|deadline):)/;
// Slack's (slack/schedule.js): the day's reminder for each turn (D-7, D-3, D-1 and D-Day are
// slack:remind:…, the other days' slack:daily:…) and 순서 변경. Not the token's or the table's
// trouble, which the pet shows.
const SLACK_PUSH = /^slack:(remind|daily|change):/;
// TodoMate's (todomate/schedule.js): the day's D-Day countdowns. Its schedule items go by the clock
// instead (isSchedule), and its connection trouble only shows.
const TODOMATE_DDAY = /^todomate:dday:/;
const SCHEDULE_LEAD_MS = 15 * 60_000;     // a TodoMate schedule item buzzes this long before it starts
const FORGET_MS = 2 * 24 * 60 * 60_000;   // how long a session or notice that left is remembered
const NOTICE_FORGET_MS = 8 * 24 * 60 * 60_000;

function sourceOf(s) {
  const client = s.client === 'vscode' ? 'VS Code' : 'Terminal';
  if (s.kind === 'web') return s.siteName || s.site || 'Web chat';
  if (s.kind === 'codex') return s.client ? `Codex · ${client}` : 'Codex';
  if (s.kind === 'cli') return `Claude Code · ${client}`;
  return 'Claude';
}

// A new 마감 임박 buzzes; one that's already handed in (제출함) or on paper (오프라인) doesn't. So
// does each new Slack reminder and 순서 변경, and each new TodoMate countdown.
function noticePushes(s) {
  if (s.kind === 'slack') return SLACK_PUSH.test(s.id);
  if (s.kind === 'todomate') return TODOMATE_DDAY.test(s.id);
  if (!ETL_PUSH.test(s.id)) return false;
  return !s.id.startsWith('etl:deadline:') || s.badge === '마감 임박';
}

// A TodoMate schedule item: it buzzes once, from SCHEDULE_LEAD_MS before it starts until it does.
function isSchedule(s) {
  return s.kind === 'todomate' && !TODOMATE_DDAY.test(s.id) && Number.isFinite(s.startsAt);
}

function noticeEvent(s) {
  const source = NOTICE_SOURCES[s.kind];
  return { id: s.id, kind: s.kind, tag: s.id, title: `${s.badge || source} · ${s.title || ''}`, body: s.project || source };
}

// `memory`: what the last call returned, null the first time (then nothing buzzes but a schedule
// item about to start). `sessions`: main.js's merged list (Claude, Codex, web chats, eTL, Slack and
// TodoMate). `muted(s)`: true for one that doesn't buzz (a session hidden from the sidebar, or a
// kind turned off in the tray menu); it's still followed, so unmuting it doesn't buzz for what
// happened meanwhile. Returns { memory, events }, each event { id, kind, tag, title, body }.
function pushEvents(memory, sessions, now = Date.now(), muted = () => false) {
  const first = !memory;
  const seen = new Map(memory?.seen);         // session id -> { status, since, at }
  const notices = new Map(memory?.notices);   // notice id (a schedule item's with its start) -> when first seen
  const present = new Set();
  const events = [];
  for (const s of sessions) {
    if (!s?.id) continue;
    if (isSchedule(s)) {
      const key = `${s.id}@${s.startsAt}`;   // moved to another time: buzzes again
      present.add(key);
      if (!notices.has(key) && now >= s.startsAt - SCHEDULE_LEAD_MS && now < s.startsAt) {
        notices.set(key, now);
        if (!muted(s)) events.push(noticeEvent(s));
      }
      continue;
    }
    if (Object.hasOwn(NOTICE_SOURCES, s.kind)) {
      present.add(s.id);
      if (!notices.has(s.id)) {
        notices.set(s.id, now);
        if (!first && noticePushes(s) && !muted(s)) events.push(noticeEvent(s));
      }
      continue;
    }
    const prev = seen.get(s.id);
    const since = s.since || 0;
    const same = prev && prev.status === s.status && prev.since === since;
    seen.set(s.id, { status: s.status, since, at: now });
    if (first || same || !LABELS[s.status] || muted(s)) continue;
    events.push({
      id: s.id,
      kind: s.kind,
      tag: s.id,
      title: `${LABELS[s.status]} · ${s.title || ''}`,
      body: [sourceOf(s), s.project].filter(Boolean).join(' · '),
    });
  }
  for (const [id, v] of seen) if (now - v.at > FORGET_MS) seen.delete(id);
  for (const [key, at] of notices) if (now - at > NOTICE_FORGET_MS && !present.has(key)) notices.delete(key);
  return { memory: { seen, notices }, events };
}

module.exports = { pushEvents, sourceOf, LABELS, NOTICE_SOURCES, SCHEDULE_LEAD_MS };
