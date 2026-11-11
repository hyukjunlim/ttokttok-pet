'use strict';

// Hiding and showing the floating pet's window.
//
// The pet's page runs with background throttling off (main.js createWindow), so Chromium never
// counts it as hidden. Then, when a hidden pet is shown again, Chromium skips its own show and
// leaves its input window (Chrome_RenderWidgetHostHWND) hidden: every press reaches the
// non-activating pet window itself, which drops it (WM_MOUSEACTIVATE answers
// MA_NOACTIVATEANDEAT), and only the release gets through. The pet still animates but can't be
// dragged or clicked until a restart. So the page is throttled while hidden, and throttling goes
// off again only after the show: turned off while still hidden, Electron counts the page as
// shown, and the show is skipped all the same.

function hidePet(win) {
  win.webContents.setBackgroundThrottling(true);
  win.hide();
}

function showPet(win) {
  win.showInactive();
  win.webContents.setBackgroundThrottling(false);
}

module.exports = { hidePet, showPet };
