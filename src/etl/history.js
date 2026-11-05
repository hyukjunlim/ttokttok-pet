'use strict';

// A plain-text record of the eTL bubbles the pet has shown (etl-history.log in userData), so one
// closed by mistake, or gone when it expired, can still be read. One line per bubble, the first
// time it shows, newest at the bottom:
//
//   2026-11-05(목) 14:02  [새 과제] 과제 3 — 공학 세미나 · 마감 2026-11-07(토) 23:59 (2일 9시간 남음)  https://myetl.snu.ac.kr/…
//
// A bubble is the same bubble while its id and `since` stay the same, so a deadline whose time
// left ticks down, or one still showing after a restart, isn't written again; a token that
// expires a second time is. The keys already written are kept in etl-history-seen.json. Lines
// and keys older than KEEP_MS are dropped, at start and once a day. Nothing here ever throws:
// a failed write is logged and the bubbles carry on.

const fs = require('node:fs');
const path = require('node:path');
const { formatKst } = require('./model');

const DAY_MS = 24 * 60 * 60 * 1000;
const KEEP_MS = 90 * DAY_MS;
const SKIP = new Set(['etl:assistant']);   // the eTL 비서 bubble is a way into the chat, not news
const LINE_DATE = /^(\d{4})-(\d{2})-(\d{2})/;
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

function keyOf(item) {
  return `${item.id}@${Number.isFinite(item.since) ? item.since : ''}`;
}

function lineOf(item, now) {
  const badge = oneLine(item.badge);
  const title = oneLine(item.title);
  const about = oneLine(item.detail) || oneLine(item.project);
  const url = oneLine(item.url);
  return `${formatKst(now)}  ${badge ? `[${badge}] ` : ''}${title}${about ? ` — ${about}` : ''}${url ? `  ${url}` : ''}`;
}

// The KST day a line was written, as ms at that day's start (KST), or null for a line without one.
function lineDay(line) {
  const m = LINE_DATE.exec(line);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) - KST_OFFSET_MS : null;
}

class EtlHistory {
  // dir: userData. log: the pet's logger.
  constructor({ dir, log = () => {}, now = Date.now }) {
    this.file = path.join(dir, 'etl-history.log');
    this.seenFile = path.join(dir, 'etl-history-seen.json');
    this.log = log;
    this.now = now;
    this.seen = null;        // key -> when it was written; read on first use
    this.trimmedDay = null;  // the KST date of the last trim
  }

  // `items`: the eTL bubbles being shown now. Writes a line for each one not written before.
  record(items) {
    try {
      const now = this.now();
      this.#load(now);
      const lines = [];
      for (const it of Array.isArray(items) ? items : []) {
        if (!it || typeof it.id !== 'string' || SKIP.has(it.id)) continue;
        const key = keyOf(it);
        if (this.seen.has(key)) continue;
        this.seen.set(key, now);
        lines.push(lineOf(it, now));
      }
      if (!lines.length) return;
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.appendFileSync(this.file, `${lines.join('\n')}\n`);
      this.#saveSeen();
    } catch (err) {
      this.log('etl history:', err.message);
    }
  }

  #load(now) {
    if (!this.seen) {
      this.seen = new Map();
      try {
        const j = JSON.parse(fs.readFileSync(this.seenFile, 'utf8'));
        for (const [k, at] of Object.entries(j?.seen || {})) if (Number.isFinite(at)) this.seen.set(k, at);
      } catch {
        // none yet
      }
    }
    const day = formatKst(now).slice(0, 10);
    if (this.trimmedDay !== day) {
      this.trimmedDay = day;
      this.#trim(now);
    }
  }

  // Drops what's older than KEEP_MS: keys by when they were written, lines by their date.
  #trim(now) {
    const cutoff = now - KEEP_MS;
    let dropped = false;
    for (const [k, at] of this.seen) {
      if (at < cutoff) {
        this.seen.delete(k);
        dropped = true;
      }
    }
    if (dropped) this.#saveSeen();
    let text;
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch {
      return;   // no history yet
    }
    const lines = text.split('\n').filter(Boolean);
    const kept = lines.filter((l) => {
      const d = lineDay(l);
      return d == null || d + DAY_MS > cutoff;
    });
    if (kept.length === lines.length) return;
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, kept.length ? `${kept.join('\n')}\n` : '');
    fs.renameSync(tmp, this.file);
  }

  #saveSeen() {
    const tmp = `${this.seenFile}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify({ version: 1, seen: Object.fromEntries(this.seen) })}\n`);
    fs.renameSync(tmp, this.seenFile);
  }
}

module.exports = { EtlHistory, KEEP_MS };
