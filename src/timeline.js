'use strict';

// Today's classes (etl/timetable.js) and TodoMate schedule items (todomate/schedule.js) as one
// timeline. Their bubbles carry `startsAt`; each source marks its own current-or-next items
// ('review'), and together only those starting earliest stay marked. They go in start order, a class
// first when both start at the same time, where the first of them was; the rest keep their places.

const rank = (s) => (s.kind === 'etl' ? 0 : 1);

function timeline(list) {
  const items = list.filter((s) => s.startsAt != null);
  if (!items.length) return list;
  const sorted = [...items].sort((a, b) => a.startsAt - b.startsAt || rank(a) - rank(b));
  const focus = sorted.find((s) => s.status === 'review');
  const merged = sorted.map((s) => (s.status === 'review' && s.startsAt !== focus.startsAt ? { ...s, status: 'idle' } : s));
  const out = [];
  for (const s of list) {
    if (s.startsAt == null) out.push(s);
    else if (s === items[0]) out.push(...merged);
  }
  return out;
}

module.exports = { timeline };
