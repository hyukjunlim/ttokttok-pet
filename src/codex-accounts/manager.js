'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { CodexRpc } = require('./rpc');
const { findCodex } = require('./locate');

const POLL_MS = 5 * 60_000;
const STALE_MS = 10 * 60_000;
const labelOf = (v) => typeof v === 'string' ? v.trim().slice(0, 80) : '';

async function identityOf(rpc) {
  try {
    const result = await rpc.request('accountSession/list', { refreshWorkspaceMetadata: false });
    const active = result.sessions?.find((s) => s.sessionId === result.activeSessionId);
    if (typeof active?.selectedWorkspaceAccountId !== 'string') return null;
    return createHash('sha256').update(JSON.stringify([active.userId || null, active.selectedWorkspaceAccountId])).digest('hex');
  } catch { return null; } // Older builds can report usage without this experimental identity API.
}

function windowsOf(result) {
  const buckets = result?.rateLimitsByLimitId;
  const limits = buckets && Object.keys(buckets).length ? Object.entries(buckets)
    : result?.rateLimits ? [[result.rateLimits.limitId || 'codex', result.rateLimits]] : [];
  return limits.flatMap(([id, bucket]) => ['primary', 'secondary'].flatMap((slot) => {
    const w = bucket?.[slot];
    if (!w || !Number.isFinite(w.usedPercent)) return [];
    return [{ id: `${id}:${slot}`, label: bucket.limitName || id, slot,
      usedPercent: Math.max(0, Math.min(100, w.usedPercent)),
      minutes: Number.isFinite(w.windowDurationMins) && w.windowDurationMins > 0 ? w.windowDurationMins : null,
      resetsAt: Number.isFinite(w.resetsAt) ? w.resetsAt * 1000 : null }];
  }));
}

function resetCreditsOf(result) {
  const summary = result?.rateLimitResetCredits;
  if (!Number.isInteger(summary?.availableCount) || summary.availableCount < 0) return null;
  const credits = Array.isArray(summary.credits) ? summary.credits.filter((c) => c && typeof c === 'object').map((c) => ({
    title: typeof c.title === 'string' ? c.title.slice(0, 120) : 'Rate-limit reset',
    description: typeof c.description === 'string' ? c.description.slice(0, 500) : null,
    status: ['available', 'redeeming', 'redeemed', 'unknown'].includes(c.status) ? c.status : 'unknown',
    grantedAt: Number.isFinite(c.grantedAt) ? c.grantedAt * 1000 : null,
    expiresAt: Number.isFinite(c.expiresAt) ? c.expiresAt * 1000 : null,
    expiryKnown: Object.hasOwn(c, 'expiresAt') && (c.expiresAt === null || Number.isFinite(c.expiresAt)),
  })).sort((a, b) => (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity)) : null;
  return { availableCount: summary.availableCount, credits };
}

class AccountManager extends EventEmitter {
  constructor({ root, executable = findCodex, factory = (o) => new CodexRpc(o), now = Date.now }) {
    super();
    Object.assign(this, { root, executable, factory, now });
    this.file = path.join(root, 'codex-accounts.json');
    this.accounts = [];
    this.readings = new Map();
    this.clients = new Set();
    this.pending = null;
    this.stopped = false;
    this.refreshing = null;
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (saved.version !== 1 || !Array.isArray(saved.accounts)) throw new Error('Invalid account registry');
      const ids = new Set();
      this.accounts = saved.accounts.filter((a) => {
        if (!a || typeof a.id !== 'string' || ids.has(a.id) || !path.isAbsolute(a.home) || !labelOf(a.label)) return false;
        ids.add(a.id); return true;
      }).map((a) => ({ id: a.id, home: a.home, label: labelOf(a.label), enabled: a.enabled !== false,
        ...(typeof a.identity === 'string' && /^[0-9a-f]{64}$/.test(a.identity) ? { identity: a.identity } : {}) }));
    } catch (e) {
      if (e.code !== 'ENOENT') this.loadError = 'The saved account list could not be read. It has not been overwritten.';
    }
  }

  save() {
    if (this.loadError) throw new Error(this.loadError);
    fs.mkdirSync(this.root, { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, accounts: this.accounts }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  snapshot() {
    return { accounts: this.accounts.map((a) => {
      const r = this.readings.get(a.id);
      return { id: a.id, label: a.label, enabled: a.enabled, status: a.enabled ? r?.status || 'unknown' : 'disabled',
        at: r?.at || null, stale: !r?.at || this.now() - r.at > STALE_MS,
        bankedResets: r?.bankedResets ?? null,
        windows: (r?.windows || []).map((w) => ({ ...w, expired: w.resetsAt != null && w.resetsAt <= this.now() })) };
    }), pending: this.pending ? { id: this.pending.id, url: this.pending.url, code: this.pending.code } : null,
    refreshing: Boolean(this.refreshing), error: this.loadError || this.message || null, automaticSwitchingAvailable: false };
  }

  changed() { this.emit('change', this.snapshot()); }

  // Adopt only successful isolated probes created by this feature; credentials stay in the OS store.
  importProbes() {
    if (this.loadError || fs.existsSync(this.file)) return;
    const base = path.join(this.root, 'account-probes');
    let names;
    try { names = fs.readdirSync(base); } catch { return; }
    for (const name of names) {
      if (!/^[0-9a-f-]{36}$/i.test(name)) continue;
      const dir = path.join(base, name);
      try {
        const result = JSON.parse(fs.readFileSync(path.join(dir, 'compatibility.json'), 'utf8'));
        if (!result.independentUsageVerified || !Array.isArray(result.accountHomes)) continue;
        for (const home of result.accountHomes) {
          if (typeof home !== 'string' || !path.isAbsolute(home)) continue;
          const relative = path.relative(dir, home);
          if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) continue;
          if (!this.accounts.some((a) => a.home === home)) this.accounts.push({ id: randomUUID(), home, label: `Account ${this.accounts.length + 1}`, enabled: true });
        }
      } catch { /* An incomplete probe is not an account registry. */ }
    }
    if (this.accounts.length) this.save();
  }

  start() {
    try { this.importProbes(); }
    catch { this.loadError = 'Could not save the connected accounts. Check access to the pet settings folder.'; }
    this.refresh();
    this.timer = setInterval(() => this.refresh(), POLL_MS);
  }

  async open(home) {
    if (this.stopped) throw new Error('Account monitor is stopped.');
    const executable = this.executable();
    if (!executable) throw new Error('Install Codex for Windows to connect accounts.');
    const rpc = this.factory({ executable, home });
    this.clients.add(rpc);
    try { await rpc.initialize(); if (this.stopped) throw new Error('Account monitor is stopped.'); return rpc; }
    catch (e) { this.close(rpc); throw e; }
  }

  close(rpc) { this.clients.delete(rpc); rpc.close(); }

  refresh() {
    if (this.refreshing || this.stopped || this.loadError || this.connecting || this.removing) return this.refreshing;
    this.refreshing = this.poll().finally(() => { this.refreshing = null; this.changed(); });
    this.changed();
    return this.refreshing;
  }

  async poll() {
    let identityChanged = false;
    // One bounded queue, regardless of how many accounts are registered.
    for (const account of [...this.accounts]) {
      if (this.stopped) break;
      if (!account.enabled || this.pending?.id === account.id) continue;
      let rpc;
      try {
        rpc = await this.open(account.home);
        const result = await rpc.request('account/rateLimits/read', { excludeResetCreditDetails: false });
        const identity = await identityOf(rpc);
        if (!this.accounts.includes(account) || this.stopped) continue;
        if (identity && account.identity && identity !== account.identity) {
          this.readings.set(account.id, { status: 'account_changed', windows: [] });
          continue;
        }
        if (identity && this.accounts.some((a) => a.id !== account.id && a.identity === identity)) {
          this.readings.set(account.id, { status: 'duplicate', windows: [] });
          continue;
        }
        if (identity && !account.identity) { account.identity = identity; identityChanged = true; }
        const windows = windowsOf(result);
        this.readings.set(account.id, { windows, bankedResets: resetCreditsOf(result), at: this.now(), status: windows.length ? 'ready' : 'unknown' });
      } catch {
        if (this.accounts.includes(account)) this.readings.set(account.id, { ...this.readings.get(account.id), status: 'unavailable' });
      } finally { if (rpc) this.close(rpc); }
      this.changed();
    }
    if (identityChanged) {
      try { this.save(); } catch { this.message = 'Account identities could not be saved.'; }
    }
  }

  async connect(options) {
    if (this.connecting || this.pending) throw new Error('Finish or cancel the current sign-in first.');
    this.connecting = true;
    try { return await this.connectAccount(options); }
    finally { this.connecting = false; }
  }

  async connectAccount({ id, label } = {}) {
    if (this.pending) throw new Error('Finish or cancel the current sign-in first.');
    if (this.loadError) throw new Error(this.loadError);
    if (this.refreshing) await this.refreshing;
    const existing = id ? this.accounts.find((a) => a.id === id) : null;
    if (id && !existing) throw new Error('Account not found.');
    const account = existing || { id: randomUUID(), label: labelOf(label) || `Account ${this.accounts.length + 1}`, enabled: true };
    if (!existing) account.home = path.join(this.root, 'codex-account-stores', account.id);
    fs.mkdirSync(account.home, { recursive: true });
    const rpc = await this.open(account.home);
    try { await rpc.request('account/read', { refreshToken: false }); }
    catch (e) { this.close(rpc); throw e; }
    let timer;
    const finish = async (success) => {
      if (this.pending?.rpc !== rpc) return;
      clearTimeout(timer);
      this.pending = null;
      try {
        if (success && !this.stopped) {
          const identity = await identityOf(rpc);
          if (identity && existing?.identity && identity !== existing.identity) {
            this.message = 'A different account was used. Reconnect with the original subscription account.';
            this.close(rpc); this.changed(); return;
          }
          if (identity && this.accounts.some((a) => a.id !== account.id && a.identity === identity)) {
            this.message = 'This subscription account is already connected.';
            if (!existing) await rpc.request('account/logout').catch(() => {});
            this.close(rpc); this.changed(); return;
          }
          if (identity) account.identity = identity;
          if (!existing) this.accounts.push(account);
          this.save();
          this.message = null;
        } else this.message = 'Sign-in did not complete. You can reconnect and try again.';
      } catch { this.message = 'Could not save the account list.'; }
      this.close(rpc);
      this.changed();
      if (success) this.refresh();
    };
    this.pending = { id: account.id, rpc, finish, url: null, code: null };
    rpc.on('notification', (m) => { if (m.method === 'account/login/completed') void finish(m.params?.success === true); });
    rpc.on('closed', () => { void finish(false); });
    timer = setTimeout(() => { void finish(false); }, 10 * 60_000);
    try {
      const result = await rpc.request('account/login/start', { type: 'chatgptDeviceCode' });
      const url = new URL(result.verificationUrl);
      if (url.protocol !== 'https:' || !['auth.openai.com', 'chatgpt.com'].includes(url.hostname)
        || typeof result.userCode !== 'string' || result.userCode.length > 100) throw new Error('Unexpected sign-in response.');
      if (this.pending?.rpc === rpc) Object.assign(this.pending, { url: url.href, code: result.userCode });
      this.changed();
    } catch (e) { await finish(false); throw e; }
  }

  cancel() { return this.pending?.finish(false); }

  update(id, patch) {
    const account = this.accounts.find((a) => a.id === id);
    if (!account) throw new Error('Account not found.');
    if (typeof patch.enabled === 'boolean') account.enabled = patch.enabled;
    if (labelOf(patch.label)) account.label = labelOf(patch.label);
    this.save(); this.changed();
  }

  async remove(id) {
    if (this.pending || this.connecting || this.removing) throw new Error('Finish or cancel the current account action first.');
    this.removing = true;
    try {
      if (this.refreshing) await this.refreshing;
      const account = this.accounts.find((a) => a.id === id);
      if (!account) return;
      let rpc;
      try {
        rpc = await this.open(account.home);
        await rpc.request('account/logout');
        this.message = null;
      } catch { this.message = 'Removed from the monitor. Codex could not clear its saved sign-in from the OS credential store.'; }
      finally { if (rpc) this.close(rpc); }
      this.accounts = this.accounts.filter((a) => a.id !== id);
      this.readings.delete(id);
      // Preserve local conversation files, including nested stores adopted from a probe.
      this.save(); this.changed();
    } finally { this.removing = false; }
  }

  stop() {
    this.stopped = true;
    clearInterval(this.timer);
    this.cancel();
    for (const rpc of [...this.clients]) this.close(rpc);
  }
}
module.exports = { AccountManager, windowsOf, resetCreditsOf, STALE_MS };
