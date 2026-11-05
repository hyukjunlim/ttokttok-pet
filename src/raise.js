'use strict';

// Brings the Codex app's window to the front after the pet hands it a codex:// link (Windows).
// With its window closed, Codex lives on in the tray: a link makes it open the window again, but
// Windows keeps that window behind the one in front, so a click on the pet seemed to do nothing.
// A small PowerShell helper waits up to 5 seconds for the window and raises it. (A key event
// first is what lets a background process set the front window. It is Alt with an unassigned key
// inside it, since a lone Alt tap opens the menu bar of whatever window has the focus, and it is
// sent only when the window isn't in front already.)

const { spawn } = require('node:child_process');
const { isSameHost } = require('./ssh-config');

const HELPER = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class PetRaise {
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  public static bool Raise(IntPtr h) {
    if (IsIconic(h)) ShowWindow(h, 9);              // SW_RESTORE
    if (GetForegroundWindow() == h) return true;    // in front already: no key event needed
    keybd_event(0x12, 0, 0, UIntPtr.Zero);          // Alt down
    keybd_event(0xE8, 0, 0, UIntPtr.Zero);          // unassigned key, so the Alt
    keybd_event(0xE8, 0, 2, UIntPtr.Zero);          //   isn't a lone tap that opens a menu
    keybd_event(0x12, 0, 2, UIntPtr.Zero);          // Alt up
    return SetForegroundWindow(h);
  }
}
'@
$deadline = (Get-Date).AddSeconds(5)
while ((Get-Date) -lt $deadline) {
  $w = Get-Process ChatGPT -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne 0 -and $_.Path -like '*OpenAI.Codex*' } | Select-Object -First 1
  if ($w) { [void][PetRaise]::Raise($w.MainWindowHandle); exit 0 }
  Start-Sleep -Milliseconds 150
}
exit 1
`;

// The same for a web chat's browser window, once the extension has brought the chat's tab forward
// in it. The browser is whichever one started the extension's native host (Chrome, Edge, Aside or
// another Chromium browser): up the host's parent chain, past the cmd.exe that ran its launcher.
// Its window is the one whose title starts with the tab's ("<tab> - Google Chrome"), or, for a
// site installed as an app, ends with it after the app's name ("ChatGPT - <tab>"). The title comes
// from a web page, so it reaches the script base64-encoded, as data, never as code.
const BROWSER_HELPER = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class PetRaiseBrowser {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  public static IntPtr Find(uint browser, string title) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      uint pid;
      GetWindowThreadProcessId(h, out pid);
      if (pid != browser) return true;
      var s = new StringBuilder(1024);
      GetWindowText(h, s, s.Capacity);
      if (!Shows(s.ToString(), title)) return true;
      found = h;
      return false;
    }, IntPtr.Zero);
    return found;
  }
  // A browser window: "<tab> - <browser>". An app window: "<app> - <tab>", or just "<tab>".
  public static bool Shows(string window, string tab) {
    return window.StartsWith(tab, StringComparison.Ordinal) || window.EndsWith(" - " + tab, StringComparison.Ordinal);
  }
  public static bool Raise(IntPtr h) {
    if (IsIconic(h)) ShowWindow(h, 9);              // SW_RESTORE
    if (GetForegroundWindow() == h) return true;    // in front already: no key event needed
    keybd_event(0x12, 0, 0, UIntPtr.Zero);          // Alt down
    keybd_event(0xE8, 0, 0, UIntPtr.Zero);          // unassigned key, so the Alt
    keybd_event(0xE8, 0, 2, UIntPtr.Zero);          //   isn't a lone tap that opens a menu
    keybd_event(0x12, 0, 2, UIntPtr.Zero);          // Alt up
    return SetForegroundWindow(h);
  }
}
'@
$title = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:PET_RAISE_TITLE))
$p = Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$env:PET_RAISE_HOST_PID)"
$browser = $null
for ($i = 0; $p -and $i -lt 4; $i++) {
  $p = Get-CimInstance Win32_Process -Filter "ProcessId=$($p.ParentProcessId)"
  if ($p -and $p.Name -notmatch '^(cmd|conhost)\.exe$') { $browser = [uint32]$p.ProcessId; break }
}
if (-not $browser) { exit 1 }
$deadline = (Get-Date).AddSeconds(3)
while ((Get-Date) -lt $deadline) {
  $h = [PetRaiseBrowser]::Find($browser, $title)
  if ($h -ne [IntPtr]::Zero) { [void][PetRaiseBrowser]::Raise($h); exit 0 }
  Start-Sleep -Milliseconds 150
}
exit 1
`;
// The same for a VS Code window, before the pet hands VS Code an extension's link (Claude Code's
// or Codex's). VS Code gives a link to the window you used last, and the extension in that window
// knows only its own machine's chats. A window says its machine in its title ("projects
// [WSL: Ubuntu] - Visual Studio Code", "projects [SSH: lab] - …"); one on this PC says none.
// PET_RAISE_MARKS (base64, one a line): the marks to look for, e.g. "[SSH: lab]", or none for this PC.
// Of several such windows, the one used last. Exit code 2: there's no such window.
const VSCODE_HELPER = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class PetRaiseVsCode {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  // Top to bottom, so the first is the one used last.
  public static List<KeyValuePair<IntPtr, string>> Windows(uint[] pids) {
    var found = new List<KeyValuePair<IntPtr, string>>();
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      uint pid;
      GetWindowThreadProcessId(h, out pid);
      if (Array.IndexOf(pids, pid) < 0) return true;
      var s = new StringBuilder(1024);
      GetWindowText(h, s, s.Capacity);
      if (s.ToString().Contains("Visual Studio Code")) found.Add(new KeyValuePair<IntPtr, string>(h, s.ToString()));
      return true;
    }, IntPtr.Zero);
    return found;
  }
  public static bool Raise(IntPtr h) {
    if (IsIconic(h)) ShowWindow(h, 9);              // SW_RESTORE
    if (GetForegroundWindow() == h) return true;    // in front already: no key event needed
    keybd_event(0x12, 0, 0, UIntPtr.Zero);          // Alt down
    keybd_event(0xE8, 0, 0, UIntPtr.Zero);          // unassigned key, so the Alt
    keybd_event(0xE8, 0, 2, UIntPtr.Zero);          //   isn't a lone tap that opens a menu
    keybd_event(0x12, 0, 2, UIntPtr.Zero);          // Alt up
    return SetForegroundWindow(h);
  }
}
'@
$raw = if ($env:PET_RAISE_MARKS) { [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:PET_RAISE_MARKS)) } else { '' }
$marks = @($raw -split [char]10 | Where-Object { $_ })
$pids = [uint32[]]@(Get-Process -Name 'Code', 'Code - Insiders' -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
if (-not $pids.Count) { exit 2 }
foreach ($w in [PetRaiseVsCode]::Windows($pids)) {
  $title = $w.Value
  $mine = if ($marks.Count) { @($marks | Where-Object { $title.Contains($_) }).Count -gt 0 }
          else { $title -notmatch '\[(WSL|SSH|Dev Container|Codespaces|Tunnel)[:\] ]' }
  if ($mine) { [void][PetRaiseVsCode]::Raise($w.Key); exit 0 }
}
exit 2
`;

// The same for Paseo, which clicking the pet opens when it's installed. Paseo has no link of its
// own, and starting Paseo.exe while it runs opens one more window, so the pet raises the window
// that's open (the one used last, of several) and starts Paseo only when there's none.
// PET_RAISE_MAXIMIZE=1 (folder mode) maximizes it too. Exit code 2: Paseo has no window open.
const PASEO_HELPER = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class PetRaisePaseo {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  // Top to bottom, so the first is the one used last.
  public static IntPtr Find(uint[] pids) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      uint pid;
      GetWindowThreadProcessId(h, out pid);
      if (Array.IndexOf(pids, pid) < 0) return true;
      var s = new StringBuilder(256);
      if (GetWindowText(h, s, s.Capacity) == 0) return true;
      found = h;
      return false;
    }, IntPtr.Zero);
    return found;
  }
  public static bool Raise(IntPtr h) {
    if (IsIconic(h)) ShowWindow(h, 9);              // SW_RESTORE
    if (GetForegroundWindow() == h) return true;    // in front already: no key event needed
    keybd_event(0x12, 0, 0, UIntPtr.Zero);          // Alt down
    keybd_event(0xE8, 0, 0, UIntPtr.Zero);          // unassigned key, so the Alt
    keybd_event(0xE8, 0, 2, UIntPtr.Zero);          //   isn't a lone tap that opens a menu
    keybd_event(0x12, 0, 2, UIntPtr.Zero);          // Alt up
    return SetForegroundWindow(h);
  }
}
'@
$pids = [uint32[]]@(Get-Process -Name 'Paseo' -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
if (-not $pids.Count) { exit 2 }
$h = [PetRaisePaseo]::Find($pids)
if ($h -eq [IntPtr]::Zero) { exit 2 }
[void][PetRaisePaseo]::Raise($h)
if ($env:PET_RAISE_MAXIMIZE -eq '1') { [void][PetRaisePaseo]::ShowWindow($h, 3) }   # SW_MAXIMIZE
exit 0
`;

let child = null;

function runHelper(script, spawnFn, env) {
  child?.kill();
  const args = ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
  const c = spawnFn('powershell.exe', args, { windowsHide: true, stdio: 'ignore', ...(env && { env }) });
  child = c;
  const done = () => { if (child === c) child = null; };
  c.on('exit', done);
  c.on('error', done);
  return c;
}

// Starts the helper (one at a time; a newer link replaces an older wait). Windows only.
function raiseCodexWindow({ spawnFn = spawn, platform = process.platform } = {}) {
  if (platform !== 'win32') return null;
  return runHelper(HELPER, spawnFn);
}

function raiseBrowserWindow({ hostPid, title, spawnFn = spawn, platform = process.platform, env = process.env }) {
  if (platform !== 'win32' || !Number.isSafeInteger(hostPid) || hostPid <= 0 || !title) return null;
  return runHelper(BROWSER_HELPER, spawnFn, {
    ...env,
    PET_RAISE_HOST_PID: String(hostPid),
    PET_RAISE_TITLE: Buffer.from(title, 'utf8').toString('base64'),
  });
}

// How a VS Code window for session `s`'s machine names it in its title, and VS Code's link that
// opens the session's folder there: { marks: ['[WSL: Ubuntu]'], or ['[SSH: lab]', …] (each name
// VS Code may use for the host: the ~/.ssh/config name you connected with, or the host as given),
// or [] for this PC; folder }. `connections`: Codex's SSH hosts; `sshHosts`: ~/.ssh/config's.
function vsCodePlace(s, { connections = [], sshHosts = [] } = {}) {
  const cwd = typeof s?.cwd === 'string' ? s.cwd : '';
  const posix = cwd.startsWith('/') ? encodeURI(cwd) : '';
  const wsl = /^wsl:(.+)$/.exec(s?.machineKey || '')?.[1];
  if (wsl) return { marks: [`[WSL: ${wsl}]`], folder: posix && `vscode://vscode-remote/wsl+${encodeURIComponent(wsl)}${posix}` };
  const names = (target, port, extra) => {
    const aliases = sshHosts.filter((h) => isSameHost(h, target, port)).map((h) => h.alias);
    return [...new Set([...aliases, target, target.slice(target.lastIndexOf('@') + 1), ...extra].filter(Boolean))];
  };
  let hosts = [];
  const ssh = /^ssh:(.+):(\d+)$/.exec(s?.machineKey || '');
  if (ssh) hosts = names(ssh[1], Number(ssh[2]), [s.machine]);
  else if (s?.kind === 'codex' && s.hostId && s.hostId !== 'local') {
    const c = connections.find((x) => x.hostId === s.hostId);
    hosts = names(c?.target || s.hostId.replace(/^remote-ssh-discovered:/, ''), c?.port ?? null, [c?.name, s.remote]);
  }
  if (hosts.length) {
    return { marks: hosts.map((n) => `[SSH: ${n}]`), folder: posix && `vscode://vscode-remote/ssh-remote+${encodeURIComponent(hosts[0])}${posix}` };
  }
  const win = /^[a-z]:[\\/]/i.test(cwd) ? encodeURI(cwd.replace(/\\/g, '/')) : '';
  return { marks: [], folder: win && `vscode://file/${win}` };
}

// Resolves true once the window is in front, false if there's no such window, null if it couldn't
// tell (not Windows, or a newer raise took over).
function raiseVsCodeWindow({ marks = [], spawnFn = spawn, platform = process.platform, env = process.env } = {}) {
  if (platform !== 'win32') return Promise.resolve(null);
  return new Promise((resolve) => {
    const lines = marks.filter((m) => typeof m === 'string' && m && !m.includes('\n')).join('\n');
    const c = runHelper(VSCODE_HELPER, spawnFn, { ...env, PET_RAISE_MARKS: Buffer.from(lines, 'utf8').toString('base64') });
    c.on('error', () => resolve(null));
    c.on('exit', (code) => resolve(code === 0 ? true : code === 2 ? false : null));
  });
}

// Resolves true once a Paseo window is in front, false if Paseo has none open, null if it couldn't
// tell (not Windows, or a newer raise took over).
function raisePaseoWindow({ maximize = false, spawnFn = spawn, platform = process.platform, env = process.env } = {}) {
  if (platform !== 'win32') return Promise.resolve(null);
  return new Promise((resolve) => {
    const c = runHelper(PASEO_HELPER, spawnFn, { ...env, PET_RAISE_MAXIMIZE: maximize ? '1' : '0' });
    c.on('error', () => resolve(null));
    c.on('exit', (code) => resolve(code === 0 ? true : code === 2 ? false : null));
  });
}

module.exports = {
  BROWSER_HELPER, HELPER, PASEO_HELPER, VSCODE_HELPER,
  raiseBrowserWindow, raiseCodexWindow, raisePaseoWindow, raiseVsCodeWindow, vsCodePlace,
};
