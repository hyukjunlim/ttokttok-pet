'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('codexAccounts', {
  state: () => ipcRenderer.invoke('codex-accounts:state'),
  act: (action, data) => ipcRenderer.invoke('codex-accounts:act', action, data),
  onState: (callback) => {
    const listener = (_e, state) => callback(state);
    ipcRenderer.on('codex-accounts:state', listener);
    return () => ipcRenderer.removeListener('codex-accounts:state', listener);
  },
});
