'use strict';

// Which changes make the phone buzz (CONSTRAINTS.md, Phone companion): a session that turns Ready,
// Needs you or Error, a new eTL bubble of the kinds that matter, and a new Slack presentation
// reminder or 순서 변경. What the pet already shows when the phone companion starts doesn't buzz, and
// neither does a session hidden from the sidebar, or one that only dropped out of the list and came
// back as it was.

const LABELS = { waiting: 'Needs you', failed: 'Error', review: 'Ready' };
// eTL's bubbles by id (etl/watch.js): 토큰 만료, 새 과제, 마감 변경, 성적, the announcements, and
// 마감 임박. Not today's classes, the first check's summary, or the assistant.
const ETL_PUSH = /^etl:(token$|(new|due|grade|ann|deadline):)/;
// Slack's (slack/schedule.js): each reminder (D-7, D-3, D-1, 당일) and 순서 변경. Not the token's or
// the table's trouble, which the pet shows.
const SLACK_PUSH = /^slack:(remind|change):/;
const FORGET_MS = 2 * 24 * 60 * 60_000;   // how long a session or notice that left is remembered
const ETL_FORGET_MS = 8 * 24 * 60 * 60_000;

function sourceOf(s) {
  const client = s.client === 'vscode' ? 'VS Code' : 'Terminal';
  if (s.kind === 'web') return s.siteName || s.site || 'Web chat';
  if (s.kind === 'codex') return s.client ? `Codex · ${client}` : 'Codex';
  if (s.kind === 'cli') return `Claude Code · ${client}`;
  return 'Claude';
}

// A new 마감 임박 buzzes; one that's already handed in (제출함) or on paper (오프라인) doesn't. So
// does each new Slack reminder and 순서 변경.
function etlPushes(s) {
  if (s.kind === 'slack') return SLACK_PUSH.test(s.id || '');
  if (!ETL_PUSH.test(s.id || '')) return false;
  return !s.id.startsWith('etl:deadline:') || s.badge === '마감 임박';
}

// `memory`: what the last call returned, null the first time (then nothing buzzes). `sessions`:
// main.js's merged list (Claude, Codex, web chats, eTL and Slack). `muted(id)`: true for a session that
// doesn't buzz (one hidden from the sidebar); it's still followed, so bringing it back doesn't buzz
// for what happened while it was hidden. Returns { memory, events }, each event
// { id, kind, tag, title, body }.
function pushEvents(memory, sessions, now = Date.now(), muted = () => false) {
  const first = !memory;
  const seen = new Map(memory?.seen);   // session id -> { status, since, at }
  const etl = new Map(memory?.etl);     // eTL or Slack id -> when it was first seen
  const events = [];
  for (const s of sessions) {
    if (!s?.id) continue;
    if (s.kind === 'todomate') continue;   // today's TodoMate schedule shows, but never buzzes
    if (s.kind === 'etl' || s.kind === 'slack') {
      if (!etl.has(s.id)) {
        etl.set(s.id, now);
        if (!first && etlPushes(s)) {
          const source = s.kind === 'slack' ? 'Slack' : 'eTL';
          events.push({ id: s.id, kind: s.kind, tag: s.id, title: `${s.badge || source} · ${s.title || ''}`, body: s.project || source });
        }
      }
      continue;
    }
    const prev = seen.get(s.id);
    const since = s.since || 0;
    const same = prev && prev.status === s.status && prev.since === since;
    seen.set(s.id, { status: s.status, since, at: now });
    if (first || same || !LABELS[s.status] || muted(s.id)) continue;
    events.push({
      id: s.id,
      kind: s.kind,
      tag: s.id,
      title: `${LABELS[s.status]} · ${s.title || ''}`,
      body: [sourceOf(s), s.project].filter(Boolean).join(' · '),
    });
  }
  for (const [id, v] of seen) if (now - v.at > FORGET_MS) seen.delete(id);
  for (const [id, at] of etl) if (now - at > ETL_FORGET_MS && !sessions.some((s) => s?.id === id)) etl.delete(id);
  return { memory: { seen, etl }, events };
}

module.exports = { pushEvents, sourceOf };
