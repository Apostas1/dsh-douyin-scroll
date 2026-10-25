# probe-diary.ps1 -- prove the "her diary" native window actually opens.
#
# Background: the right-click item "her diary" is a HOST-side action: it does NOT
# go to the page, the host opens its own WPF window with diary.html. Nobody had
# ever verified that window opens -- the user reported "diary click does nothing".
#
# This probe drives the SAME code path a real menu click uses (SendAct), via the
# pet-test.txt debug channel (`act:diary`), and then proves the window exists by
# enumerating top-level windows owned by that process.
#
# NOTE: every process here is started via ProcessStartInfo with UseShellExecute=$false.
# Start-Process goes through ShellExecuteEx, which on this machine can raise a
# UAC-like prompt that must be clicked -- we must never depend on the user clicking.
#
# ASCII-only script on purpose (PS 5.1 reads BOM-less .ps1 as ANSI).
$ErrorActionPreference = 'Stop'

$root    = 'D:\aiagent\deepseek\dsh-douyin-scroll'
$exe     = Join-Path $root 'tools\pet-host\PetHost.exe'
$nodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not (Test-Path $exe))  { throw 'no PetHost.exe' }
if (-not $nodeExe)          { throw 'node not found' }

function Start-NoShell([string]$file, [string[]]$arguments, [string]$workDir = '') {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $file
  if ($arguments -and $arguments.Count -gt 0) { $psi.Arguments = ($arguments -join ' ') }
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  if ($workDir -ne '') { $psi.WorkingDirectory = $workDir }
  $p = New-Object System.Diagnostics.Process
  $p.StartInfo = $psi
  [void]$p.Start()
  return $p
}

$tmpHome = Join-Path $env:TEMP ("petdiary_" + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $tmpHome | Out-Null

# a fake upstream that answers the diary API with real entries.
# It writes hits to a FILE (not stdout): the host process is started without a
# console, so console.log would go nowhere and we could not prove the page fetched.
$srv = @'
import http from 'node:http';
import fs from 'node:fs';
const port = Number(process.argv[2] || 18998);
const hitFile = process.argv[3];
const payload = JSON.stringify({
  ok: true,
  day: '2026-10-25',
  items: [
    { at: '2026-10-25T10:00:00.000Z', text: 'DIARY_TEXT_ONE', kind: 'activity', star: true },
    { at: '2026-10-25T09:00:00.000Z', text: 'DIARY_TEXT_TWO', kind: 'chat', star: false }
  ],
  stars: 1,
  days: ['2026-10-25'],
});
let served = 0;
http.createServer((req, res) => {
  served++;
  try { fs.appendFileSync(hitFile, 'HIT ' + served + ' ' + req.method + ' ' + req.url + '\n'); } catch {}
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}).listen(port, '127.0.0.1', () => { try { fs.appendFileSync(hitFile, 'LISTEN ' + port + '\n'); } catch {} });
setTimeout(() => process.exit(0), 90000);
'@
$srvPath = Join-Path $tmpHome 'fake-diary-api.mjs'
$hitFile = Join-Path $tmpHome 'api-hits.txt'
[System.IO.File]::WriteAllText($srvPath, $srv, (New-Object System.Text.UTF8Encoding($false)))
$srvProc = Start-NoShell $nodeExe @($srvPath, '18998', $hitFile)
Start-Sleep -Milliseconds 1200

$now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$state = [ordered]@{
  on = $true; persona = 'infp'; danmaku = $false; danmakuMode = 'off'
  link = [ordered]@{ state = 'idle' }
  api = 'http://127.0.0.1:18998/api/douyin-duty'
  activity = 'probe'; activityAt = $now; ts = $now
}
($state | ConvertTo-Json -Depth 6) | Set-Content (Join-Path $tmpHome 'pet-window-state.json') -Encoding UTF8

$env:DOUYIN_HOME = $tmpHome
$proc = Start-NoShell $exe @()
Start-Sleep -Seconds 8

Write-Output '================ DIARY PROBE ================'
Write-Output ("host pid : " + $proc.Id)

if ($proc.HasExited) {
  Write-Output 'host already exited -- boot log tail:'
  Get-Content (Join-Path $root 'tools\pet-host\pet-host-boot.log') -Encoding UTF8 -Tail 18
  try { Stop-Process -Id $srvProc.Id -Force } catch {}
  exit 1
}

# ---- 1. drive the exact same code path a menu click uses ------------------
$actFile = Join-Path $tmpHome 'pet-test.txt'
[System.IO.File]::WriteAllText($actFile, 'act:diary', (New-Object System.Text.UTF8Encoding($false)))
Start-Sleep -Seconds 5

# ---- 1b. ask the diary PAGE itself what it rendered ---------------------
# "window opened + page loaded + API hit" still is not proof the user sees text.
# So we run a snippet INSIDE diary.html through the host and read the DOM back
# (channel: pet-test.txt with a `diaryjs:` prefix).
$diaryProbe = @'
(function(){
  try {
    var L = document.getElementById('pageL');
    var R = document.getElementById('pageR');
    var txt = ((L ? L.innerText : '') + ' ' + (R ? R.innerText : '')).replace(/\s+/g, ' ').trim();
    var empty = document.getElementById('empty');
    var sub = document.getElementById('sub');
    var dayLbl = document.getElementById('dayLbl');
    return JSON.stringify({
      entries: document.querySelectorAll('.entry').length,
      stars: document.querySelectorAll('.entry.star').length,
      text: txt.slice(0, 220),
      emptyShown: !!(empty && getComputedStyle(empty).display !== 'none'),
      sub: sub ? sub.textContent : '',
      day: dayLbl ? dayLbl.textContent : ''
    });
  } catch (e) { return 'PROBE_ERR ' + e.message }
})()
'@
[System.IO.File]::WriteAllText($actFile, ('diaryjs:' + $diaryProbe), (New-Object System.Text.UTF8Encoding($false)))
Start-Sleep -Seconds 3

# ---- 2. enumerate top-level windows owned by that pid ---------------------
$sig = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public class WinEnum {
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] static extern int GetWindowTextW(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  public static List<string> ForPid(uint target) {
    var list = new List<string>();
    EnumWindows((h, l) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (pid != target) return true;
      var sb = new StringBuilder(256);
      GetWindowTextW(h, sb, 256);
      string t = sb.ToString();
      if (t.Length > 0) list.Add((IsWindowVisible(h) ? "[vis] " : "[hid] ") + t);
      return true;
    }, IntPtr.Zero);
    return list;
  }
}
'@
$titles = @()
try {
  if (-not ('WinEnum' -as [type])) { Add-Type -TypeDefinition $sig }
  $titles = [WinEnum]::ForPid([uint32]$proc.Id)
} catch { Write-Output ('window enum failed: ' + $_.Exception.Message) }

Write-Output '--- windows owned by the pet host ---'
foreach ($t in $titles) { Write-Output ('  ' + $t) }

# ---- 3. read host logs for diary evidence -------------------------------
$diaryLines = @()
foreach ($tf in @((Join-Path $root 'tools\pet-host\trace.txt'), (Join-Path $tmpHome 'pet-host.log'))) {
  if (-not (Test-Path $tf)) { continue }
  $diaryLines += Get-Content $tf -Encoding UTF8 | Where-Object { $_ -match 'diary|test act' } | Select-Object -Last 14
}
Write-Output '--- diary-related host log lines ---'
foreach ($l in $diaryLines) { Write-Output ('  ' + $l) }

# ---- 4. did the diary PAGE fetch anything from the API? ----------------
$apiHits = 0
$hitLines = @()
if (Test-Path $hitFile) {
  $hitLines = Get-Content $hitFile -Encoding UTF8
  $apiHits = @($hitLines | Where-Object { $_ -match '^HIT' }).Count
}
Write-Output ('fake diary API hits : ' + $apiHits)
foreach ($l in $hitLines) { Write-Output ('  ' + $l) }

# ---- 5. verdict --------------------------------------------------------
Write-Output '--- what the diary PAGE reported about its own DOM ---'
$rendered = $false
$renderLine = ($diaryLines | Where-Object { $_ -match 'diary test result' } | Select-Object -Last 1)
if ($renderLine) {
  Write-Output ('  ' + $renderLine)
  # the log line carries JSON inside a quoted string, so quotes are escaped as \" --
  # match tolerantly instead of requiring the raw form.
  $flat = $renderLine -replace '\\"', '"'
  $entries = 0
  $m = [regex]::Match($flat, '"entries"\s*:\s*(\d+)')
  if ($m.Success) { $entries = [int]$m.Groups[1].Value }
  $hasText   = ($flat -match 'DIARY_TEXT_ONE') -and ($flat -match 'DIARY_TEXT_TWO')
  $notEmpty  = ($flat -notmatch '"emptyShown":true')
  $hasStars  = ($flat -match '"stars"\s*:\s*1')
  Write-Output ('  parsed: entries=' + $entries + ' hasBothEntries=' + $hasText + ' notEmptyState=' + $notEmpty + ' starCounted=' + $hasStars)
  $rendered = ($entries -eq 2) -and $hasText -and $notEmpty -and $hasStars
} else { Write-Output '  (no DOM report -- see below)' }

$opened    = (($titles -join ' ') -match 'diary') -or (($diaryLines -join ' ') -match 'diary window shown')
$navigated = ($diaryLines -join ' ') -match 'diary nav completed ok=True'
$fetched   = $apiHits -gt 0
Write-Output ("diary window opened  : " + $opened)
Write-Output ("diary page navigated : " + $navigated)
Write-Output ("diary page fetched   : " + $fetched)
Write-Output ("diary page rendered  : " + $rendered)
if ($opened -and $navigated -and $fetched -and $rendered) { Write-Output 'VERDICT              : DIARY PASS' }
elseif ($opened -and $navigated -and $fetched) { Write-Output 'VERDICT              : DIARY WINDOW+DATA OK, DOM UNVERIFIED' }
else { Write-Output 'VERDICT              : DIARY FAIL' }

# ---- 6. cleanup by PID only -------------------------------------------
try { Stop-Process -Id $proc.Id -Force -ErrorAction Stop } catch {}
if (-not $srvProc.HasExited) { try { Stop-Process -Id $srvProc.Id -Force -ErrorAction Stop } catch {} }
Start-Sleep -Milliseconds 500
try { Remove-Item $tmpHome -Recurse -Force -ErrorAction SilentlyContinue } catch {}
if (-not ($opened -and $navigated -and $fetched)) { exit 1 }
