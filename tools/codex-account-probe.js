'use strict';

// Interactive compatibility gate. Uses an isolated home and OS credential storage.
// It never reads/copies auth.json, sends inference requests, or changes the normal Codex home.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { CodexRpc } = require('../src/codex-accounts/rpc');
const { localCodex } = require('../src/chat-delete');

function activeSelection(result) {
  const session = result.sessions?.find((s) => s.sessionId === result.activeSessionId);
  const accountId = session?.selectedWorkspaceAccountId;
  return session && accountId ? { sessionId: session.sessionId, accountId } : null;
}

function sameSelection(a, b) {
  return Boolean(a && b && a.sessionId === b.sessionId && a.accountId === b.accountId);
}

function waitForLogin(rpc, timeoutMs = 10 * 60_000) {
  let stop;
  const promise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('Sign-in timed out.')), timeoutMs);
    const onClosed = () => finish(new Error('Codex closed during sign-in.'));
    const onNotification = (m) => {
      if (m.method === 'account/login/completed') {
        finish(m.params?.success ? null : new Error('Sign-in failed. Check Codex account access and OS credential storage.'));
      }
    };
    const finish = (error) => {
      clearTimeout(timer);
      rpc.off('notification', onNotification);
      rpc.off('closed', onClosed);
      error ? reject(error) : resolve();
    };
    stop = () => finish(new Error('Sign-in canceled.'));
    rpc.on('notification', onNotification);
    rpc.on('closed', onClosed);
  });
  // A request can fail before the caller begins awaiting the notification.
  promise.catch(() => {});
  return { promise, stop };
}

async function login(rpc, ordinal, write) {
  write(`Sign in to account ${ordinal}; choose a different subscription account each time.`);
  const waiting = waitForLogin(rpc);
  try {
    const response = await rpc.request('account/login/start', { type: 'chatgptDeviceCode' });
    const url = new URL(response.verificationUrl);
    if (url.protocol !== 'https:' || !['auth.openai.com', 'chatgpt.com'].includes(url.hostname)
      || typeof response.userCode !== 'string' || response.userCode.length > 100) {
      throw new Error('Codex returned an unexpected sign-in URL or code.');
    }
    write(`Open ${url.href}\nEnter the one-time code: ${response.userCode}`);
    await waiting.promise;
  } finally { waiting.stop(); }
}

async function probe({ executable, home, count = 2, reuseExisting = false, write = console.log, factory = (o) => new CodexRpc(o) }) {
  if (!Number.isInteger(count) || count < 2) throw new Error('The isolation test needs at least two accounts.');
  const clients = [];
  const open = async () => {
    const rpc = factory({ executable, home });
    clients.push(rpc);
    await rpc.initialize();
    return rpc;
  };
  const list = async (rpc) => rpc.request('accountSession/list', { refreshWorkspaceMetadata: false });
  try {
    const owner = await open();
    // Reject incompatible executables before asking the user to sign in.
    const initial = await list(owner);
    const selections = [];
    if (reuseExisting) {
      const saved = activeSelection(initial);
      if (saved) {
        selections.push(saved);
        await owner.request('account/rateLimits/read');
        write('Reused account 1 from this isolated probe; usage query succeeded.');
      }
    }
    for (let i = selections.length; i < count; i++) {
      await login(owner, i + 1, write);
      const selection = activeSelection(await list(owner));
      if (!selection) throw new Error('Codex did not expose an active saved login.');
      if (selections.some((s) => s.accountId === selection.accountId)) throw new Error('The same subscription workspace was selected twice.');
      selections.push(selection);
      const limits = await owner.request('account/rateLimits/read');
      write(`Account ${i + 1}: usage query ${limits?.rateLimits || limits?.rateLimitsByLimitId ? 'available' : 'returned no limits'}.`);
    }
    const stored = await list(owner);
    if (!selections.every((s) => stored.sessions?.some((x) => x.sessionId === s.sessionId))) {
      return { accountCount: selections.length, savedLoginsRetained: false, isolationVerified: false, conversationContinuityVerified: false };
    }
    const observer = await open();
    const before = activeSelection(await list(observer));
    await owner.request('accountSession/switch', { ...selections[0], allowBrowserLogin: false });
    const changed = activeSelection(await list(owner));
    const after = activeSelection(await list(observer));
    const restarted = await open();
    const startup = activeSelection(await list(restarted));
    return {
      accountCount: selections.length,
      savedLoginsRetained: true,
      selectedLoginChanged: sameSelection(changed, selections[0]),
      otherProcessSelectionUnchanged: sameSelection(before, after),
      defaultSelectionChanged: !sameSelection(startup, before),
      // Account-selection metadata alone does not prove which account inference uses.
      isolationVerified: false,
      conversationContinuityVerified: false,
      nextCheck: 'Verify inference identity and same-thread continuation before enabling automatic switching.',
    };
  } finally { clients.forEach((rpc) => rpc.close()); }
}

async function probeSeparate({ executable, home, count = 2, write = console.log, factory = (o) => new CodexRpc(o) }) {
  if (!Number.isInteger(count) || count < 2) throw new Error('The isolation test needs at least two accounts.');
  const clients = [];
  const records = [];
  const list = async (rpc) => activeSelection(await rpc.request('accountSession/list', { refreshWorkspaceMetadata: false }));
  try {
    for (let i = 0; i < count; i++) {
      const accountHome = i === 0 ? home : path.join(home, 'accounts', String(i + 1));
      fs.mkdirSync(accountHome, { recursive: true, mode: 0o700 });
      const rpc = factory({ executable, home: accountHome });
      clients.push(rpc);
      await rpc.initialize();
      let selected = await list(rpc);
      if (!selected) {
        await login(rpc, i + 1, write);
        selected = await list(rpc);
      }
      if (!selected) throw new Error('Codex did not expose the signed-in account.');
      if (records.some((r) => r.selected.accountId === selected.accountId)) throw new Error('Choose different subscription accounts for this test.');
      await rpc.request('account/rateLimits/read');
      records.push({ home: accountHome, selected });
      write(`Account ${i + 1}: separate login store and usage query available.`);
    }
    let isolated = true;
    for (let i = 0; i < clients.length; i++) {
      isolated = isolated && sameSelection(records[i].selected, await list(clients[i]));
      await clients[i].request('account/rateLimits/read');
    }
    return {
      accountCount: count, separateStores: true, independentUsageVerified: isolated,
      conversationContinuityVerified: false,
      accountHomes: records.map((r) => r.home),
      nextCheck: 'Verify same-thread continuation across the isolated account stores.',
    };
  } finally { clients.forEach((rpc) => rpc.close()); }
}

async function main() {
  const args = process.argv.slice(2);
  const countArg = args.find((s) => s.startsWith('--count='));
  const exeArg = args.find((s) => s.startsWith('--codex='));
  const resume = args.find((s) => s.startsWith('--resume='))?.slice(9);
  const separate = args.includes('--separate');
  if (args.some((s) => !s.startsWith('--count=') && !s.startsWith('--codex=') && !s.startsWith('--resume=') && s !== '--separate')) throw new Error('Use --count=N, optionally --codex=PATH, --resume=PROBE-ID and --separate.');
  if (resume && !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(resume)) throw new Error('--resume must name an isolated probe UUID.');
  const count = countArg ? Number(countArg.slice(8)) : 2;
  if (!Number.isInteger(count) || count < 2) throw new Error('--count must be an integer of at least 2.');
  const executable = exeArg?.slice(8) || (process.platform === 'win32' ? windowsCodex() : 'codex');
  if (!executable) throw new Error('Could not locate Codex. Supply --codex=PATH.');
  const home = path.join(os.homedir(), '.ttokttok-pet', 'account-probes', resume || randomUUID());
  if (resume && !fs.existsSync(home)) throw new Error('The isolated probe directory does not exist.');
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  console.log(`Isolated Codex home: ${home}\nSign-ins use OS credential storage. Your normal Codex login is not selected or overwritten.\nNo inference requests will be sent in this first probe.`);
  const result = await (separate ? probeSeparate : probe)({ executable, home, count, reuseExisting: Boolean(resume) });
  const report = path.join(home, 'compatibility.json');
  fs.writeFileSync(report, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(result, null, 2));
  console.log(`Report: ${report}`);
}

function windowsCodex() {
  const root = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'OpenAI', 'Codex', 'bin');
  try {
    const candidates = fs.readdirSync(root).map((name) => path.join(root, name, 'codex.exe'))
      .filter((file) => fs.existsSync(file))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    if (candidates.length) return candidates[0];
  } catch { /* Try the VS Code bundled executable; preflight still checks API support. */ }
  return localCodex();
}

if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { activeSelection, sameSelection, probe, probeSeparate, waitForLogin };
