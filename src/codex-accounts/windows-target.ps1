# Win32 side of this PC's Codex login switch (windows-target.js): file locks and the list of
# running Codex processes. One JSON request a line on stdin, one JSON answer a line on stdout.
# Locks are byte-range locks (LockFile), which exclude Codex's own LockFileEx locks on the same
# files. They are released on unlock, or by Windows when this process exits (the pet closing
# stdin, or dying, ends it).
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false) } catch { }
$held = @{}
$me = "$env:USERDOMAIN\$env:USERNAME"

function Reply($value) {
  [Console]::Out.WriteLine((ConvertTo-Json $value -Compress -Depth 4))
  [Console]::Out.Flush()
}

function Lock-File([string]$file, [int]$waitMs) {
  if ($held.ContainsKey($file)) { return @{ error = 'busy' } }
  $deadline = [DateTime]::UtcNow.AddMilliseconds($waitMs)
  while ($true) {
    $stream = $null
    try {
      $stream = [IO.File]::Open($file, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]'ReadWrite, Delete')
      $stream.Lock(0, 1)
      $held[$file] = $stream
      return @{ ok = $true }
    } catch [IO.IOException] {
      # Locked by Codex or another switch, or opened without sharing: wait, as Codex does.
      if ($stream) { $stream.Dispose() }
      if ([DateTime]::UtcNow -ge $deadline) { return @{ error = 'busy' } }
      Start-Sleep -Milliseconds 50
    } catch {
      if ($stream) { $stream.Dispose() }
      return @{ error = 'lock_failed' }
    }
  }
}

function Get-CodexProcesses {
  $list = @(Get-CimInstance Win32_Process -Filter "Name='codex.exe'" | ForEach-Object {
    $owner = $null
    try {
      $o = Invoke-CimMethod -InputObject $_ -MethodName GetOwner
      if ($o.ReturnValue -eq 0) { $owner = "$($o.Domain)\$($o.User)" }
    } catch { }
    @{ pid = [int]$_.ProcessId; path = $_.ExecutablePath; mine = $(if ($owner) { $owner -eq $me } else { $null }) }
  })
  # Always an array, even with one process: ConvertTo-Json would unwrap it otherwise.
  return @{ processes = $list }
}

while ($null -ne ($line = [Console]::In.ReadLine())) {
  try { $request = ConvertFrom-Json $line } catch { Reply @{ error = 'invalid_request' }; continue }
  try {
    if ($request.op -eq 'lock') {
      Reply (Lock-File ([string]$request.path) ([int]$request.waitMs))
    } elseif ($request.op -eq 'unlock') {
      $file = [string]$request.path
      if ($held.ContainsKey($file)) { $held[$file].Dispose(); $held.Remove($file) }
      Reply @{ ok = $true }
    } elseif ($request.op -eq 'held') {
      # Asked right before a switch writes: are all these locks still ours?
      $all = @($request.paths | Where-Object { -not $held.ContainsKey([string]$_) }).Count -eq 0
      Reply @{ ok = $all }
    } elseif ($request.op -eq 'processes') {
      Reply (Get-CodexProcesses)
    } else {
      Reply @{ error = 'invalid_request' }
    }
  } catch {
    Reply @{ error = 'helper_failed' }
  }
}
