'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { hidePet, showPet } = require('../src/pet-visibility');

function fakeWindow() {
  const calls = [];
  return {
    calls,
    hide: () => calls.push('hide'),
    showInactive: () => calls.push('showInactive'),
    webContents: { setBackgroundThrottling: (on) => calls.push(`throttle ${on}`) },
  };
}

test('a hidden pet is throttled first, so Chromium counts its page as hidden too', () => {
  const win = fakeWindow();
  hidePet(win);
  assert.deepEqual(win.calls, ['throttle true', 'hide']);
});

test('showing the pet lifts throttling only after the show, never before it', () => {
  // Lifted while still hidden, Electron counts the page as shown and Chromium skips the show that
  // brings back its input window: the pet would ignore every press.
  const win = fakeWindow();
  showPet(win);
  assert.deepEqual(win.calls, ['showInactive', 'throttle false']);
});

test('the pet is still shown without taking focus', () => {
  const win = fakeWindow();
  win.show = () => win.calls.push('show');
  win.focus = () => win.calls.push('focus');
  showPet(win);
  assert.ok(!win.calls.includes('show') && !win.calls.includes('focus'));
});
