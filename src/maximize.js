'use strict';

// In folder mode the Claude and Codex windows are kept maximized, so they fill the screen beside
// the sidebar (whose strip Windows leaves out of a maximized window, see appbar.js). A small
// PowerShell helper does it (Windows only):
//
//   open  the app a session was just opened in: waits up to 5 s for its window, then maximizes
//         it (which also brings it forward, as opening it does anyway)
//   all   both apps, after the sidebar docked or changed width: each window that is on screen
//         but not maximized, the one further back first, so the one in front stays in front.
//         Minimized windows are left minimized.

const { spawn } = require('node:child_process');

const HELPER = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class PetMaximize {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  // The windows in front-to-back order.
  public static List<IntPtr> Order() {
    List<IntPtr> all = new List<IntPtr>();
    EnumWindows((h, l) => { all.Add(h); return true; }, IntPtr.Zero);
    return all;
  }
  public static bool Fill(IntPtr h, bool restore) {
    if (h == IntPtr.Zero || !IsWindowVisible(h)) return false;
    if (IsIconic(h) && !restore) return false;
    if (IsZoomed(h) && !IsIconic(h)) return true;
    return ShowWindow(h, 3);                         // SW_MAXIMIZE
  }
}
'@
function Find($app) {
  if ($app -eq 'codex') {
    $p = Get-Process ChatGPT -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 -and $_.Path -like '*OpenAI.Codex*' }
  } elseif ($app -eq 'paseo') {
    $p = Get-Process Paseo -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -ne '' }
  } else {
    # The desktop app, not the claude CLI (which has no window of its own).
    $p = Get-Process claude -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -ne '' }
  }
  $p | Select-Object -First 1 -ExpandProperty MainWindowHandle
}
if ('ACTION' -eq 'open') {
  $deadline = (Get-Date).AddSeconds(5)
  while ((Get-Date) -lt $deadline) {
    $h = Find 'APP'
    if ($h) { Start-Sleep -Milliseconds 250; [void][PetMaximize]::Fill($h, $true); exit 0 }
    Start-Sleep -Milliseconds 150
  }
  exit 1
}
$order = [PetMaximize]::Order()
$found = @(Find 'claude'; Find 'codex') | Where-Object { $_ }
foreach ($h in ($found | Sort-Object { -$order.IndexOf([IntPtr]$_) })) { [void][PetMaximize]::Fill([IntPtr]$h, $false) }
`;

let child = null;

// `action`: 'open' with `app` ('claude', 'codex' or 'paseo', which the pet starts when it has no
// window), or 'all' (Claude and Codex). One helper at a time; a newer request replaces an older one.
function maximizeApps(action, app = 'claude', { spawnFn = spawn, platform = process.platform } = {}) {
  if (platform !== 'win32') return null;
  child?.kill();
  const which = ['codex', 'paseo'].includes(app) ? app : 'claude';
  const text = HELPER.replace("'ACTION'", `'${action === 'open' ? 'open' : 'all'}'`).replace("'APP'", `'${which}'`);
  const args = ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(text, 'utf16le').toString('base64')];
  const c = spawnFn('powershell.exe', args, { windowsHide: true, stdio: 'ignore' });
  child = c;
  const done = () => { if (child === c) child = null; };
  c.on('exit', done);
  c.on('error', done);
  return c;
}

module.exports = { HELPER, maximizeApps };
