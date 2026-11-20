'use strict';

// How much of this week's usage your Claude, Codex and Antigravity Gemini plans have used.
//
//   - Claude: Ttokttok Pet's mod (claude-mod/, see claude-mod.js) saves the account's limits after
//     each reply of a Claude Code session, as Claude Code heard them, to ~/.ttokttok-pet/usage.json on
//     the machine the session runs on: { version: 1, at, limits: [{ kind, percent, resetsAt }] },
//     with kind five_hour or seven_day.
//   - Codex: each reply's token_count event in a rollout carries the account's rate limits,
//     { primary, secondary: { used_percent, window_minutes, resets_at } }. Which of the two is the
//     weekly window depends on the plan.
//   - Gemini: Antigravity CLI (`agy -p "/quota"`, see gemini-usage.js) prints tab-separated rows
//     with remaining percentages and UTC reset timestamps for Gemini and Claude/GPT model pools.

const DAY_MINUTES = 24 * 60;
const WEEK_MINUTES = 7 * DAY_MINUTES;
const WEEK_MS = WEEK_MINUTES * 60_000;
const FIVE_HOURS_MS = 5 * 60 * 60_000;
const STALE_MS = 60 * 60_000;

// What Ttokttok Pet's mod saved: { weekly, fiveHour, at }, each window { percent, resetsAt, windowMs }
// or null.
function parseModUsage(j) {
  if (j?.version !== 1 || !Number.isFinite(j.at) || !Array.isArray(j.limits)) return null;
  const out = { weekly: null, fiveHour: null, at: j.at };
  for (const l of j.limits) {
    if (!Number.isFinite(l?.percent)) continue;
    const resetsAt = Number.isFinite(l.resetsAt) ? l.resetsAt : null;
    if (l.kind === 'seven_day') out.weekly = { percent: l.percent, resetsAt, windowMs: WEEK_MS };
    else if (l.kind === 'five_hour') out.fiveHour = { percent: l.percent, resetsAt, windowMs: FIVE_HOURS_MS };
  }
  return out.weekly || out.fiveHour ? out : null;
}

// Claude's figures from everywhere the mod saved them (this PC, WSL, the SSH hosts). They're all
// the account's, so the newest wins. Its week's reset comes from the newest reading that has one
// (see withWeeklyResets).
function combineClaudeUsage(readings) {
  let newest = null;
  let timed = null;
  for (const r of readings || []) {
    if (!r || !Number.isFinite(r.at)) continue;
    if ((r.weekly || r.fiveHour) && (!newest || r.at > newest.at)) newest = r;
    if (Number.isFinite(r.weekly?.resetsAt) && (!timed || r.at > timed.at)) timed = r;
  }
  return newest && withWeeklyResets(newest, timed?.weekly.resetsAt);
}

// A token_count event's rate_limits, for a reply at `at`: { weekly, fiveHour }, each
// { percent, resetsAt, windowMs } or null. Older Codex versions give resets_in_seconds instead of
// resets_at, and may leave out window_minutes (then primary is the 5-hour window, secondary the
// weekly one).
function parseRateLimits(r, at) {
  if (!r || typeof r !== 'object' || (r.limit_id != null && r.limit_id !== 'codex')) return null;
  const out = { weekly: null, fiveHour: null };
  for (const [w, minutesIfUnsaid] of [[r.primary, 300], [r.secondary, WEEK_MINUTES]]) {
    if (!Number.isFinite(w?.used_percent)) continue;
    const minutes = Number.isFinite(w.window_minutes) ? w.window_minutes : minutesIfUnsaid;
    const resetsAt = Number.isFinite(w.resets_at) ? w.resets_at * 1000
      : Number.isFinite(w.resets_in_seconds) && at ? at + w.resets_in_seconds * 1000 : null;
    const window = { percent: w.used_percent, resetsAt, windowMs: minutes * 60_000 };
    if (minutes >= WEEK_MINUTES - DAY_MINUTES) out.weekly = window;
    else if (minutes <= DAY_MINUTES) out.fiveHour = window;
  }
  return out.weekly || out.fiveHour ? out : null;
}

// What `agy -p "/quota"` prints for Gemini Models, at `at`: { weekly, fiveHour, at }, each window
// { percent, resetsAt, windowMs } or null. Lines are tab-separated:
//   Gemini Models	Weekly Limit Remaining	68%	2026-09-28T04:00:00Z
// Percentages are remaining unless the label explicitly says "used"; convert to used %.
function parseAgyQuota(stdout, at) {
  if (typeof stdout !== 'string' || !Number.isFinite(at)) return null;
  const out = { weekly: null, fiveHour: null, at };
  for (const raw of stdout.split(/\r?\n/)) {
    const parts = raw.split('\t').map((s) => s.trim());
    if (parts.length < 3) continue;
    const [group, label, pctText, resetText] = parts;
    if (!group || !label || !pctText || !/gemini/i.test(group)) continue;
    const match = /(-?\d+(?:\.\d+)?)\s*%/.exec(pctText);
    if (!match) continue;
    const rawPct = Number(match[1]);
    if (!Number.isFinite(rawPct)) continue;
    const clamped = Math.min(100, Math.max(0, rawPct));
    const used = /used/i.test(label) && !/remaining/i.test(label)
      ? clamped
      : Math.round((100 - clamped) * 1e4) / 1e4;
    const parsedReset = resetText ? Date.parse(resetText) : NaN;
    const resetsAt = Number.isFinite(parsedReset) ? parsedReset : null;
    if (/week/i.test(label)) out.weekly = { percent: used, resetsAt, windowMs: WEEK_MS };
    else if (/five[ _-]?hour|5[ _-]?hour|5h/i.test(label)) out.fiveHour = { percent: used, resetsAt, windowMs: FIVE_HOURS_MS };
  }
  return out.weekly || out.fiveHour ? out : null;
}

// Claude's weekly limit resets at the same time every week, a time set for your account. `anchor`
// is any one of those resets; it gives them all, so figures from before a reset read as a fresh
// week after it, until the next reply.
function withWeeklyResets(u, anchor) {
  if (!u?.weekly || !Number.isFinite(anchor)) return u;
  return { ...u, weekly: { ...u.weekly, resetsAt: nextWeeklyReset(anchor, u.at), repeats: true } };
}

// The first reset after `t` of a limit that resets every week, `anchor` being one of its resets.
function nextWeeklyReset(anchor, t) {
  return anchor + (Math.floor((t - anchor) / WEEK_MS) + 1) * WEEK_MS;
}

// What the pet shows: each app's weekly limit, [{ app, name, percent, elapsed, resetsIn, age }].
// `percent` is how much of the limit is used and `elapsed` how much of the week has gone by, so
// using more than `elapsed` means you'd run out before the reset. Without a known reset time,
// `elapsed` and `resetsIn` are null.
function usageView({ claude = null, codex = null, gemini = null } = {}, now = Date.now()) {
  const out = [];
  const pct = (n) => Math.round(Math.min(100, Math.max(0, n)));
  for (const [app, name, u] of [['claude', 'Claude', claude], ['codex', 'Codex', codex], ['gemini', 'Gemini', gemini]]) {
    const w = u?.weekly;
    if (!w || !Number.isFinite(w.percent)) continue;
    const reset = w.resetsAt != null && w.resetsAt <= now;   // a new week began since these figures
    const next = reset && w.repeats ? nextWeeklyReset(w.resetsAt, now) : w.resetsAt;
    const known = next != null && next > now;   // (a Codex week starts with its first reply)
    out.push({
      app,
      name,
      percent: reset ? 0 : pct(w.percent),
      elapsed: known && w.windowMs > 0 ? pct(100 - ((next - now) / w.windowMs) * 100) : null,
      resetsIn: known ? formatDuration(next - now) : null,
      // how old the figures are, once over an hour (unless they're of a week that has ended)
      age: !reset && Number.isFinite(u.at) && now - u.at > STALE_MS ? formatDuration(now - u.at) : null,
    });
  }
  return out;
}

// "2d 5h", "5h", "40m"
function formatDuration(ms) {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  const days = Math.floor(minutes / DAY_MINUTES);
  const hours = Math.floor((minutes % DAY_MINUTES) / 60);
  if (days) return hours ? `${days}d ${hours}h` : `${days}d`;
  return hours ? `${hours}h` : `${minutes}m`;
}

module.exports = {
  combineClaudeUsage, formatDuration, nextWeeklyReset, parseAgyQuota, parseModUsage, parseRateLimits, usageView, withWeeklyResets,
};
