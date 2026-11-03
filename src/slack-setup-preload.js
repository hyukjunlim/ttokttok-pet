'use strict';

// The Slack setup window's preload (see src/slack/setup-window.js): just enough to fill the page
// in, hand over what was typed, open Slack's app page, and close the window.

const { contextBridge, ipcRenderer } = require('electron');

const text = (v) => (typeof v === 'string' ? v : '');

contextBridge.exposeInMainWorld('slackSetup', {
  // -> Promise<{ link, name, hasToken }>
  initial: () => ipcRenderer.invoke('slack-setup:initial'),
  // -> Promise<{ ok: true, turns: [string] } | { ok: false, error }>
  submit: ({ token, link, name } = {}) => ipcRenderer.invoke('slack-setup:submit', { token: text(token), link: text(link), name: text(name) }),
  openGuide: () => ipcRenderer.send('slack-setup:guide'),
  close: () => ipcRenderer.send('slack-setup:close'),
});
