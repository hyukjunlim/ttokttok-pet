'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ResetReminders, claudeEntry, claudeExpiry, claudeResetsOf, resetAccounts, resetItems } = require('../src/codex-accounts/resets');
const { pushEvents } = require('../src/phone/notify');
const { phoneView } = require('../src/phone/view');

const kst = (s) => Date.parse(`${s}+09:00`);

// AccountManager's snapshot().accounts, cut down to what the reminders read.
const codexAccount = (id, label, credits, extra = {}) => ({
  id,
  label,
  enabled: true,
  status: 'ready',
  bankedResets: { availableCount: credits.filter((c) => c.status === 'available').length, credits },
  ...extra,
});
const credit = (title, expires, status = 'available') => ({
  title, description: null, status, grantedAt: null, expiresAt: expires == null ? null : kst(expires), expiryKnown: true,
});

test('a Claude entry needs a kind, a count from 1 to 99 and a real date; the time is optional', () => {
  assert.deepEqual(claudeEntry({ kind: '  Weekly   reset ', count: 2, date: '2026-11-16', time: '' }),
    { kind: 'Weekly reset', count: 2, date: '2026-11-16', time: null });
  assert.deepEqual(claudeEntry({ kind: 'Weekly reset', count: '1', date: '2026-11-16', time: '15:30' }),
    { kind: 'Weekly reset', count: 1, date: '2026-11-16', time: '15:30' });
  assert.throws(() => claudeEntry({ kind: ' ', count: 1, date: '2026-11-16' }), /kind/);
  assert.throws(() => claudeEntry({ kind: 'x', count: 0, date: '2026-11-16' }), /count/);
  assert.throws(() => claudeEntry({ kind: 'x', count: 1.5, date: '2026-11-16' }), /count/);
  assert.throws(() => claudeEntry({ kind: 'x', count: 100, date: '2026-11-16' }), /count/);
  assert.throws(() => claudeEntry({ kind: 'x', count: 1, date: '2026-02-30' }), /date/);
  assert.throws(() => claudeEntry({ kind: 'x', count: 1, date: '11/16' }), /date/);
  assert.throws(() => claudeEntry({ kind: 'x', count: 1, date: '2026-11-16', time: '25:00' }), /time/);
  // Without a time, it lasts until its date ends (KST); with one, until then.
  assert.equal(claudeExpiry({ date: '2026-11-16', time: null }), kst('2026-11-17T00:00:00'));
  assert.equal(claudeExpiry({ date: '2026-11-16', time: '15:30' }), kst('2026-11-16T15:30:00'));
  // Saved entries that don't read right are left out.
  assert.deepEqual(claudeResetsOf([
    { id: 'a', kind: 'Weekly reset', count: 1, date: '2026-11-16', time: null },
    { id: 'a', kind: 'Duplicate id', count: 1, date: '2026-11-16', time: null },
    { id: 'b', kind: '', count: 1, date: '2026-11-16' },
    null,
  ]).map((e) => e.id), ['a']);
  assert.deepEqual(claudeResetsOf('not a list'), []);
});

test('each account holds its usable resets, soonest first; paused, unread and lapsed ones are left out', () => {
  const now = kst('2026-11-13T09:00:00');
  const accounts = resetAccounts({
    codex: [
      codexAccount('c1', '홍길동', [
        credit('Later reset', '2026-11-20T10:00:00'),
        credit('Weekly reset', '2026-11-16T15:00:00'),
        credit('Used reset', '2026-11-14T10:00:00', 'redeemed'),
        credit('Lapsed reset', '2026-11-13T08:00:00'),
      ]),
      codexAccount('c2', 'Paused', [credit('Weekly reset', '2026-11-14T10:00:00')], { enabled: false }),
      codexAccount('c3', 'Unread', [], { bankedResets: null }),
      codexAccount('c4', 'Count only', [], { bankedResets: { availableCount: 2, credits: null } }),
      codexAccount('c5', 'None', []),
    ],
    claude: [
      { id: 'x', kind: 'Weekly reset', count: 2, date: '2026-11-18', time: null },
      { id: 'y', kind: 'Session reset', count: 1, date: '2026-11-15', time: '12:00' },
      { id: 'z', kind: 'Old reset', count: 1, date: '2026-11-12', time: null },
    ],
  }, now);
  assert.deepEqual(accounts.map((a) => [a.key, a.name, a.total, a.resets.map((r) => r.title)]), [
    ['codex:c1', 'Codex 홍길동', 2, ['Weekly reset', 'Later reset']],
    ['codex:c4', 'Codex Count only', 2, []],
    ['claude', 'Claude', 3, ['Session reset', 'Weekly reset', 'Weekly reset']],
  ]);
});

test('every morning from 06:00 one D-X per account, for its soonest reset, with how many more it holds', () => {
  const accounts = (now) => resetAccounts({
    codex: [
      codexAccount('c1', '홍길동', [credit('Weekly reset', '2026-11-16T15:00:00'), credit('Later reset', '2026-11-20T10:00:00')]),
      codexAccount('c2', '김철수', [credit('Weekly reset', '2026-11-25T09:00:00')]),
    ],
    claude: [{ id: 'x', kind: 'Weekly reset', count: 2, date: '2026-11-14', time: null }],
  }, now);
  const at = (when) => {
    const now = kst(when);
    return resetItems(accounts(now), now).map((b) => [b.badge, b.title, b.project, b.status]);
  };
  assert.deepEqual(at('2026-11-13T09:00:00'), [
    ['D-1', 'Claude · Weekly reset', '11/14(토)까지 · 외 1개', 'waiting'],
    ['D-3', 'Codex 홍길동 · Weekly reset', '11/16(월) 15:00 만료 · 외 1개', 'review'],
    ['D-12', 'Codex 김철수 · Weekly reset', '11/25(수) 09:00 만료', 'idle'],
  ]);
  // Before 06:00 the last morning's count stays; at 06:00 the next one comes.
  assert.equal(at('2026-11-14T05:59:00')[0][0], 'D-1');
  assert.equal(at('2026-11-14T06:00:00')[0][0], 'D-Day');
  // Claude's ran out with the 14th; 홍길동's moves on to its next reset once the first expires.
  assert.deepEqual(at('2026-11-16T15:00:00').slice(0, 1), [['D-4', 'Codex 홍길동 · Later reset', '11/20(금) 10:00 만료', 'idle']]);
  assert.deepEqual(at('2026-11-25T09:00:00'), [], 'none left: no bubble');

  const now = kst('2026-11-13T09:00:00');
  const [b] = resetItems(accounts(now), now);
  assert.equal(b.id, 'resets:dday:claude:2026-11-13');
  assert.equal(b.kind, 'resets');
  assert.equal(b.app, 'claude');
  assert.equal(b.clearOnClick, true);
  assert.equal(b.expiresAt, kst('2026-11-14T06:00:00'));
  // The id carries the account and the day, not the reset: one used during the day keeps the bubble.
  const later = kst('2026-11-13T20:00:00');
  const used = resetAccounts({ codex: [codexAccount('c1', '홍길동', [credit('Later reset', '2026-11-20T10:00:00')])] }, later);
  assert.equal(resetItems(used, later)[0].id, 'resets:dday:codex:c1:2026-11-13');
});

test('a reset that runs out at midnight counts to the day before', () => {
  const now = kst('2026-11-13T09:00:00');
  const items = resetItems(resetAccounts({ codex: [codexAccount('c1', '홍길동', [credit('Weekly reset', '2026-11-16T00:00:00')])] }, now), now);
  assert.equal(items[0].badge, 'D-2');
});

function fakeSettings(data = {}) {
  return { data, get: (k) => data[k], set(patch) { Object.assign(data, patch); } };
}
const noTimers = { setInterval: () => ({}), clearInterval: () => {} };

test('Claude entries are added, edited, used and deleted, and the bubble follows them', () => {
  let now = kst('2026-11-13T09:00:00');
  const settings = fakeSettings();
  const r = new ResetReminders({ settings, now: () => now, timers: noTimers });
  const seen = [];
  r.on('change', (list) => seen.push(list.map((b) => `${b.badge} ${b.title} | ${b.project}`)));
  r.start();
  assert.deepEqual(seen.pop(), []);

  r.addClaude({ kind: 'Weekly reset', count: 2, date: '2026-11-16', time: null });
  assert.deepEqual(seen.pop(), ['D-3 Claude · Weekly reset | 11/16(월)까지 · 외 1개']);
  assert.throws(() => r.addClaude({ kind: 'Weekly reset', count: 1, date: '2026-11-12', time: null }), /passed/);
  const [entry] = r.claudeSnapshot();
  assert.deepEqual({ ...entry, id: undefined }, { id: undefined, kind: 'Weekly reset', count: 2, date: '2026-11-16', time: null,
    expiresAt: kst('2026-11-17T00:00:00'), expired: false, dday: 'D-3' });

  r.addClaude({ kind: 'Session reset', count: 1, date: '2026-11-14', time: '12:00' });
  assert.deepEqual(seen.pop(), ['D-1 Claude · Session reset | 11/14(토) 12:00 만료 · 외 2개']);
  const session = r.claudeSnapshot()[0];
  r.useClaude(session.id);
  assert.deepEqual(seen.pop(), ['D-3 Claude · Weekly reset | 11/16(월)까지 · 외 1개'], 'used up: the entry goes');
  r.useClaude(entry.id);
  assert.deepEqual(seen.pop(), ['D-3 Claude · Weekly reset | 11/16(월)까지']);
  r.editClaude(entry.id, { kind: 'Weekly reset', count: 3, date: '2026-11-15', time: '18:00' });
  assert.deepEqual(seen.pop(), ['D-2 Claude · Weekly reset | 11/15(일) 18:00 만료 · 외 2개']);
  assert.throws(() => r.editClaude('gone', { kind: 'x', count: 1, date: '2026-11-15' }), /no longer listed/);
  r.removeClaude(entry.id);
  assert.deepEqual(seen.pop(), []);
  assert.deepEqual(settings.data.claudeResets, []);

  // Kept in settings as entered, nothing more.
  r.addClaude({ kind: 'Weekly reset', count: 1, date: '2026-11-20', time: null, extra: 'dropped' });
  assert.deepEqual(Object.keys(settings.data.claudeResets[0]).sort(), ['count', 'date', 'id', 'kind', 'time']);
  r.stop();
  assert.deepEqual(seen.pop(), [], 'stopping takes the bubbles away');
});

test('a clicked bubble stays hidden until the next morning, also after a restart', () => {
  let now = kst('2026-11-13T09:00:00');
  const settings = fakeSettings({ claudeResets: [{ id: 'x', kind: 'Weekly reset', count: 1, date: '2026-11-16', time: null }] });
  const r = new ResetReminders({ settings, now: () => now, timers: noTimers });
  r.start();
  const [b] = r.items();
  r.dismiss(b.id);
  assert.deepEqual(r.items(), []);
  assert.deepEqual(settings.data.resetsHidden, { [b.id]: kst('2026-11-14T06:00:00') });
  const again = new ResetReminders({ settings, now: () => now, timers: noTimers });
  again.start();
  assert.deepEqual(again.items(), [], 'still hidden after a restart');
  now = kst('2026-11-14T06:00:00');
  assert.equal(again.items()[0].badge, 'D-2', 'and back the next morning');
  r.dismiss('todomate:dday:x');   // not one of its own: ignored
});

test('Codex readings feed the bubbles; a new reading that drops a used reset moves the bubble on', () => {
  const now = kst('2026-11-13T09:00:00');
  let codex = [codexAccount('c1', '홍길동', [credit('Weekly reset', '2026-11-14T10:00:00'), credit('Later reset', '2026-11-20T10:00:00')])];
  const r = new ResetReminders({ settings: fakeSettings(), codex: () => codex, now: () => now, timers: noTimers });
  const seen = [];
  r.on('change', (list) => seen.push(list.map((b) => `${b.badge} ${b.title} | ${b.project}`)));
  r.start();
  assert.deepEqual(seen.pop(), ['D-1 Codex 홍길동 · Weekly reset | 11/14(토) 10:00 만료 · 외 1개']);
  codex = [codexAccount('c1', '홍길동', [credit('Later reset', '2026-11-20T10:00:00')])];
  r.update();
  assert.deepEqual(seen.pop(), ['D-7 Codex 홍길동 · Later reset | 11/20(금) 10:00 만료']);
  r.update();
  assert.equal(seen.length, 0, 'nothing new: no change');
});

test('the phone gets each account\'s D-Day once a morning; a reset used during the day doesn\'t buzz again', () => {
  const bubble = (day, title) => ({ id: `resets:dday:codex:c1:${day}`, kind: 'resets', app: 'codex', status: 'review', badge: 'D-3', title, project: '11/16(월) 15:00 만료 · 외 1개' });
  let { memory } = pushEvents(null, [], 0);
  let events;
  ({ memory, events } = pushEvents(memory, [bubble('2026-11-13', 'Codex 홍길동 · Weekly reset')], 1));
  assert.deepEqual(events.map((e) => [e.title, e.body]), [['D-3 · Codex 홍길동 · Weekly reset', '11/16(월) 15:00 만료 · 외 1개']]);
  ({ memory, events } = pushEvents(memory, [bubble('2026-11-13', 'Codex 홍길동 · Later reset')], 2));
  assert.equal(events.length, 0);
  ({ events } = pushEvents(memory, [bubble('2026-11-14', 'Codex 홍길동 · Later reset')], 3));
  assert.equal(events.length, 1, 'the next morning');
  // Turned off under Phone → Notifications: followed but silent.
  ({ events } = pushEvents(memory, [bubble('2026-11-15', 'x')], 4, (s) => s.kind === 'resets'));
  assert.equal(events.length, 0);
});

test('on the phone a reset opens Claude\'s usage page or ChatGPT\'s Codex', () => {
  const view = phoneView({ notices: [
    { id: 'resets:dday:claude:2026-11-13', kind: 'resets', app: 'claude', status: 'waiting', badge: 'D-1', title: 'Claude · Weekly reset', project: '' },
    { id: 'resets:dday:codex:c1:2026-11-13', kind: 'resets', app: 'codex', status: 'idle', badge: 'D-9', title: 'Codex 홍길동 · Weekly reset', project: '' },
  ] });
  assert.deepEqual(view.notices.map((n) => n.open), [
    { app: 'claude', url: 'https://claude.ai/settings/usage' },
    { app: 'chatgpt', url: 'https://chatgpt.com/codex' },
  ]);
});
