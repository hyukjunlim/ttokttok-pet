'use strict';
const path = require('node:path');
const os = require('node:os');
const { AccountManager } = require('./manager');
const { usageView } = require('../usage');
const { TargetAccounts } = require('./targets');

class CodexAccountsFeature {
  constructor({ electron, changed = () => {} }) {
    this.electron = electron;
    this.targets = new TargetAccounts();
    this.manager = new AccountManager({ root: path.join(os.homedir(), '.ttokttok-pet') });
    const send = () => {
      if (this.window && !this.window.isDestroyed()) this.window.webContents.send('codex-accounts:state', this.snapshot());
      changed();
    };
    this.manager.on('change', send);
    this.targets.on('change', send);
    this.manager.start();
  }
  snapshot() { return { ...this.manager.snapshot(), apply: this.targets.snapshot(), currentAccounts: this.targets.currentAccounts(this.manager.accounts) }; }
  get count() { return this.manager.accounts.length; }
  meter() {
    return this.manager.snapshot().accounts.filter((a) => a.enabled && a.status === 'ready' && !a.stale)
      .flatMap((a) => {
        const w = a.windows.find((w) => w.id.startsWith('codex:') && w.minutes >= 6 * 1440 && !w.expired);
        if (!w) return [];
        const [row] = usageView({ codex: { at: a.at, weekly: { percent: w.usedPercent, resetsAt: w.resetsAt, windowMs: w.minutes * 60_000 } } });
        return row ? [{ ...row, name: `Codex · ${a.label}` }] : [];
      }).slice(0, 3);
  }
  menu() { return { label: `Codex accounts${this.count ? ` (${this.count})` : ''}…`, click: () => this.open() }; }
  open() {
    if (this.window && !this.window.isDestroyed()) { this.window.show(); this.window.focus(); return; }
    const { BrowserWindow, shell, dialog } = this.electron;
    const win = new BrowserWindow({ width: 620, height: 650, minWidth: 460, minHeight: 400, title: 'Codex accounts',
      autoHideMenuBar: true, webPreferences: { preload: path.join(__dirname, '..', 'codex-accounts-preload.js'),
        contextIsolation: true, nodeIntegration: false, sandbox: true } });
    this.window = win;
    this.targets.refreshStatus();
    const statusTimer = setInterval(() => this.targets.refreshStatus(), 30_000);
    win.removeMenu();
    const wc = win.webContents;
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    wc.on('will-navigate', (e) => e.preventDefault());
    wc.on('will-redirect', (e) => e.preventDefault());
    wc.on('will-attach-webview', (e) => e.preventDefault());
    let busy = false;
    wc.ipc.handle('codex-accounts:state', (e) => e.sender === wc && e.senderFrame === wc.mainFrame ? this.snapshot() : null);
    wc.ipc.handle('codex-accounts:act', async (e, action, data) => {
      if (e.sender !== wc || e.senderFrame !== wc.mainFrame || busy) return { error: 'Please wait for the current action.' };
      busy = true;
      try {
        if (this.targets.busy && !['target-signin', 'target-cancel', 'refresh'].includes(action)) throw new Error('Wait for the apply operation to finish or cancel it.');
        switch (action) {
          case 'apply': {
            if (this.manager.pending || this.manager.connecting || this.manager.removing) throw new Error('Finish the current account action first.');
            let account = this.manager.accounts.find((a) => a.id === data?.id);
            if (!account) throw new Error('Account not found.');
            if (!account.identity) { await this.manager.refresh(); account = this.manager.accounts.find((a) => a.id === data?.id); }
            this.targets.begin(account);
            break;
          }
          case 'target-signin': {
            const url = this.targets.snapshot()?.pending?.url;
            if (url) await shell.openExternal(url);
            break;
          }
          case 'target-cancel': this.targets.cancel(); break;
          case 'add': await this.manager.connect({ label: data?.label }); break;
          case 'reconnect': await this.manager.connect({ id: data?.id }); break;
          case 'update': this.manager.update(data?.id, { label: data?.label, enabled: data?.enabled }); break;
          case 'refresh': await Promise.all([this.manager.refresh(), this.targets.refreshStatus()]); break;
          case 'cancel': await this.manager.cancel(); break;
          case 'signin': {
            const url = this.manager.pending?.url;
            if (url) await shell.openExternal(url);
            break;
          }
          case 'remove': {
            const answer = await dialog.showMessageBox(win, { type: 'question', message: 'Disconnect this account from the monitor?',
              detail: 'This clears its monitor sign-in. Your normal Codex login and conversations are kept.',
              buttons: ['Cancel', 'Disconnect'], defaultId: 0, cancelId: 0 });
            if (answer.response === 1) await this.manager.remove(data?.id);
            break;
          }
          default: throw new Error('Unknown account action.');
        }
        return { state: this.snapshot() };
      } catch (error) { return { error: error.message }; }
      finally { busy = false; }
    });
    win.on('closed', () => { clearInterval(statusTimer); this.window = null; });
    win.loadFile(path.join(__dirname, '..', 'renderer', 'codex-accounts.html'));
  }
  stop() { this.targets.stop(); this.manager.stop(); this.window?.close(); }
}
module.exports = { CodexAccountsFeature };
