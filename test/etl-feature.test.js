'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { EtlFeature } = require('../src/etl/feature');

// An EtlFeature with fake Electron parts, a temp chat folder and no token (so no requests).
function feature(t, saved = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'etl-feature-'));
  const data = { etlEnabled: true, etlWorkspace: path.join(dir, 'ws'), etlAssistantBubble: false, ...saved };
  const settings = { get: (k) => data[k], set: (p) => Object.assign(data, p) };
  const electron = {
    app: { getPath: () => path.join(dir, 'userData') },
    powerMonitor: new EventEmitter(),
    dialog: {},
    shell: { openPath() {}, openExternal: async () => {} },
    safeStorage: { isEncryptionAvailable: () => false },
  };
  const f = new EtlFeature({ electron, settings, appRoot: dir, codexSessionsRoot: path.join(dir, 'sessions') });
  const changes = [];
  f.on('change', (list) => changes.push(list.map((it) => it.id)));
  t.after(() => f.stop());
  return { f, data, changes };
}

test('the eTL 비서 bubble shows only while turned on, and turning it on or off takes effect at once', (t) => {
  const { f, changes } = feature(t, { etlAssistantBubble: true });
  f.start();
  assert.deepEqual(changes.at(-1), ['etl:assistant']);
  f.setAssistantBubble(false);
  assert.deepEqual(changes.at(-1), []);
  f.setAssistantBubble(true);
  assert.deepEqual(changes.at(-1), ['etl:assistant']);
  f.stop();
  assert.deepEqual(changes.at(-1), []);
});

test('the eTL 비서 bubble\'s × turns it off, as its menu item does, until turned on again', (t) => {
  const { f, data, changes } = feature(t, { etlAssistantBubble: true });
  f.start();
  assert.deepEqual(changes.at(-1), ['etl:assistant']);
  f.dismiss('etl:assistant');
  assert.deepEqual(changes.at(-1), []);
  assert.equal(data.etlAssistantBubble, false);
  assert.equal(f.menu().submenu.find((m) => m.label === 'eTL 비서 말풍선 보이기').checked, false);
  f.setAssistantBubble(true);
  assert.deepEqual(changes.at(-1), ['etl:assistant']);
});

test('with eTL off there is no eTL 비서 bubble, and its menu item is there to turn it on', (t) => {
  const { f, changes } = feature(t, { etlEnabled: false, etlAssistantBubble: true });
  f.start();
  assert.deepEqual(changes, []);
  const item = f.menu().submenu.find((m) => m.label === 'eTL 비서 말풍선 보이기');
  assert.equal(item.type, 'checkbox');
  assert.equal(item.checked, true);
});

test('clicking the bubble opens its links in order, a moment apart', async (t) => {
  const { f, data } = feature(t);
  f.codexInstalled = () => true;
  f.assistantLinks = () => ['codex://first', 'codex://second'];
  const opened = [];
  assert.equal(f.openAssistant((u) => opened.push(u), { gapMs: 20 }), true);
  assert.deepEqual(opened, ['codex://first']);
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(opened, ['codex://first', 'codex://second']);
  delete f.assistantLinks;
  const [link] = f.assistantLinks();
  assert.equal(new URL(link).searchParams.get('path'), data.etlWorkspace);
});

test('the 오늘 수업 bubble has its own menu item, on by default, that turns its notifier on and off', (t) => {
  const { f, data } = feature(t);
  f.start();
  const item = () => f.menu().submenu.find((m) => m.label === '오늘 수업 알림');
  assert.equal(item().type, 'checkbox');
  assert.equal(item().checked, true);
  assert.ok(f.notifier, 'running while eTL is on');
  item().click({ checked: false });
  assert.equal(data.etlTimetableBubble, false);
  assert.equal(f.notifier, null);
  assert.equal(item().checked, false);
  item().click({ checked: true });
  assert.ok(f.notifier);
  f.stop();
  assert.equal(f.notifier, null);
});

test('each eTL bubble the feature shows is written once to etl-history.log in userData; the eTL 비서 bubble is not', (t) => {
  const { f, changes } = feature(t, { etlAssistantBubble: true });
  f.start();
  const notice = {
    id: 'etl:ann:300001', kind: 'etl', status: 'review', badge: '새 공지', title: '중간고사 안내',
    project: '공학 세미나', detail: '공학 세미나 · 시험은 다음 주입니다.', url: 'https://myetl.snu.ac.kr/', since: Date.now(),
  };
  f.tracker.emit('change', [notice]);
  f.tracker.emit('change', [notice]);
  assert.deepEqual(changes.at(-1), ['etl:ann:300001', 'etl:assistant']);
  const file = path.join(f.electron.app.getPath('userData'), 'etl-history.log');
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /\[새 공지\] 중간고사 안내 — 공학 세미나 · 시험은 다음 주입니다\.  https:\/\/myetl\.snu\.ac\.kr\/$/);
});
