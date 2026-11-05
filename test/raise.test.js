'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const {
  BROWSER_HELPER, HELPER, PASEO_HELPER, VSCODE_HELPER,
  raiseBrowserWindow, raiseCodexWindow, raisePaseoWindow, raiseVsCodeWindow, vsCodePlace,
} = require('../src/raise');

function fakeSpawn() {
  const runs = [];
  const spawnFn = (cmd, args, opts) => {
    const c = new EventEmitter();
    c.killed = false;
    c.kill = () => { c.killed = true; };
    runs.push({ cmd, args, opts, child: c });
    return c;
  };
  return { runs, spawnFn };
}

test("a hidden PowerShell helper raises the Codex app's window, on Windows only", () => {
  const { runs, spawnFn } = fakeSpawn();
  assert.equal(raiseCodexWindow({ spawnFn, platform: 'darwin' }), null);
  assert.equal(runs.length, 0);
  raiseCodexWindow({ spawnFn, platform: 'win32' });
  assert.equal(runs[0].cmd, 'powershell.exe');
  assert.equal(runs[0].opts.windowsHide, true);
  const script = Buffer.from(runs[0].args.at(-1), 'base64').toString('utf16le');
  assert.equal(script, HELPER);
  assert.match(script, /OpenAI\.Codex/);
  assert.match(script, /SetForegroundWindow/);
});

// A lone Alt tap opens the menu bar of the window that has the focus, so the helpers never send one.
test('both helpers send Alt only when the window is not in front, with an unassigned key inside it', () => {
  const steps = [
    'GetForegroundWindow() == h) return true',
    'keybd_event(0x12, 0, 0,',                   // Alt down
    'keybd_event(0xE8, 0, 0,',
    'keybd_event(0xE8, 0, 2,',
    'keybd_event(0x12, 0, 2,',                   // Alt up
    'return SetForegroundWindow(h)',
  ];
  for (const script of [HELPER, BROWSER_HELPER, VSCODE_HELPER, PASEO_HELPER]) {
    const raise = script.slice(script.indexOf('public static bool Raise('));
    const at = steps.map((s) => raise.indexOf(s));
    assert.ok(at.every((i) => i >= 0), `missing step in Raise: ${steps[at.indexOf(-1)]}`);
    assert.deepEqual(at, [...at].sort((a, b) => a - b));
    assert.equal(raise.match(/keybd_event\(0x12,/g).length, 2);   // one Alt down, one Alt up
  }
});

test('a newer raise replaces one still waiting', () => {
  const { runs, spawnFn } = fakeSpawn();
  raiseCodexWindow({ spawnFn, platform: 'win32' });
  raiseCodexWindow({ spawnFn, platform: 'win32' });
  assert.equal(runs[0].child.killed, true);
  assert.equal(runs[1].child.killed, false);
  runs[1].child.emit('exit');
});

test("a web chat's window is found from its host's browser and its tab's title, which reaches the helper only as data", () => {
  const { runs, spawnFn } = fakeSpawn();
  const title = '"; Remove-Item C:\\ -Recurse; "  한글 - Claude';
  raiseBrowserWindow({ hostPid: 4321, title, spawnFn, platform: 'win32', env: { PATH: 'x' } });
  const { opts, args } = runs[0];
  const script = Buffer.from(args.at(-1), 'base64').toString('utf16le');
  assert.equal(script, BROWSER_HELPER);
  assert.ok(!script.includes('Remove-Item'));
  assert.match(script, /ParentProcessId/);        // the browser is up the host's parent chain
  assert.equal(opts.env.PET_RAISE_HOST_PID, '4321');
  assert.equal(Buffer.from(opts.env.PET_RAISE_TITLE, 'base64').toString('utf8'), title);
  assert.equal(opts.env.PATH, 'x');
  runs[0].child.emit('exit');
  assert.equal(raiseBrowserWindow({ hostPid: 4321, title, spawnFn, platform: 'darwin' }), null);
  assert.equal(raiseBrowserWindow({ hostPid: null, title, spawnFn, platform: 'win32' }), null);
  assert.equal(raiseBrowserWindow({ hostPid: 4321, title: '', spawnFn, platform: 'win32' }), null);
  assert.equal(runs.length, 1);
});

test("a VS Code window is raised by its machine's mark in the title, which reaches the helper as data", async () => {
  const { runs, spawnFn } = fakeSpawn();
  const raised = raiseVsCodeWindow({ marks: ['[SSH: lab]', '[SSH: 192.0.2.10]', 'bad\nline'], spawnFn, platform: 'win32', env: {} });
  const { opts, args } = runs[0];
  assert.equal(Buffer.from(args.at(-1), 'base64').toString('utf16le'), VSCODE_HELPER);
  assert.equal(Buffer.from(opts.env.PET_RAISE_MARKS, 'base64').toString('utf8'), '[SSH: lab]\n[SSH: 192.0.2.10]');
  runs[0].child.emit('exit', 0);
  assert.equal(await raised, true);
  const none = raiseVsCodeWindow({ marks: [], spawnFn, platform: 'win32', env: {} });
  runs[1].child.emit('exit', 2);
  assert.equal(await none, false, 'no window for that machine');
  assert.equal(await raiseVsCodeWindow({ spawnFn, platform: 'darwin' }), null);
});

// Starting Paseo.exe while it runs opens a second window, so the pet must tell "raised" from "none".
test("Paseo's open window is raised (and maximized in folder mode); exit 2 says it has none", async () => {
  const { runs, spawnFn } = fakeSpawn();
  const raised = raisePaseoWindow({ spawnFn, platform: 'win32', env: { PATH: 'x' } });
  const { opts, args } = runs[0];
  assert.equal(Buffer.from(args.at(-1), 'base64').toString('utf16le'), PASEO_HELPER);
  assert.equal(opts.env.PET_RAISE_MAXIMIZE, '0');
  assert.equal(opts.env.PATH, 'x');
  runs[0].child.emit('exit', 0);
  assert.equal(await raised, true);
  const none = raisePaseoWindow({ maximize: true, spawnFn, platform: 'win32', env: {} });
  assert.equal(runs[1].opts.env.PET_RAISE_MAXIMIZE, '1');
  runs[1].child.emit('exit', 2);
  assert.equal(await none, false, 'no Paseo window');
  const killed = raisePaseoWindow({ spawnFn, platform: 'win32', env: {} });
  runs[2].child.emit('exit', null);
  assert.equal(await killed, null, "a replaced helper can't tell");
  assert.equal(await raisePaseoWindow({ spawnFn, platform: 'darwin' }), null);
});

test('the VS Code helper runs, and finds no window for a machine nobody has open', { skip: process.platform !== 'win32' && 'Windows only' }, async () => {
  const code = await new Promise((resolve) => {
    const c = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(VSCODE_HELPER, 'utf16le').toString('base64')], {
      windowsHide: true,
      stdio: 'ignore',
      env: { ...process.env, PET_RAISE_MARKS: Buffer.from('[SSH: no-such-host.invalid]', 'utf8').toString('base64') },
    });
    c.on('exit', resolve);
  });
  assert.equal(code, 2);
});

test("a session's machine gives the VS Code window to look for, and the folder to open there without one", () => {
  const sshHosts = [{ alias: 'lab', hostName: '192.0.2.10', user: null, port: null }];
  assert.deepEqual(vsCodePlace({ kind: 'cli', machineKey: 'wsl:Ubuntu', cwd: '/home/me/my proj' }), {
    marks: ['[WSL: Ubuntu]'], folder: 'vscode://vscode-remote/wsl+Ubuntu/home/me/my%20proj',
  });
  assert.deepEqual(vsCodePlace({ kind: 'cli', machineKey: 'ssh:me@192.0.2.10:22', machine: '192.0.2.10', cwd: '/data/proj' }, { sshHosts }), {
    marks: ['[SSH: lab]', '[SSH: me@192.0.2.10]', '[SSH: 192.0.2.10]'], folder: 'vscode://vscode-remote/ssh-remote+lab/data/proj',
  });
  const connections = [{ hostId: 'remote-ssh-discovered:lab', name: 'lab', target: 'lab', port: null }];
  assert.deepEqual(vsCodePlace({ kind: 'codex', client: 'vscode', hostId: 'remote-ssh-discovered:lab', cwd: '/data/proj' }, { connections, sshHosts }).marks, ['[SSH: lab]']);
  assert.deepEqual(vsCodePlace({ kind: 'codex', client: 'vscode', hostId: 'local', machineKey: 'wsl:Ubuntu', cwd: '/home/me' }).marks, ['[WSL: Ubuntu]']);
  assert.deepEqual(vsCodePlace({ kind: 'cli', machineKey: null, cwd: 'C:\\Users\\me\\proj' }), { marks: [], folder: 'vscode://file/C:/Users/me/proj' });
  assert.deepEqual(vsCodePlace({ kind: 'cli', machineKey: null, cwd: null }), { marks: [], folder: '' });
});
