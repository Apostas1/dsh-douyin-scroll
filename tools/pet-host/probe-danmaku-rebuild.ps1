# probe-danmaku-rebuild.ps1 -- prove the "danmaku disappears after off/on" bug is fixed.
#
# Bug ("3.弹幕模式，出问题了，会消失"):
#   setDanmakuMode('off') did `danmakuEl.innerHTML = ''` (detaches 26 nodes) but the JS
#   pool array still held them, and buildPool() starts with `if (pool.length) return`
#   => it never re-created them. Any off/on cycle left the layer empty forever.
#   (The fullscreen page had `pool.length = 0`; the local one did not.)
#
# NOTE: do NOT delete trace.txt between steps -- the host holds an append handle
# (File.AppendAllText) opened once; deleting the file makes its writes vanish.
# Instead we remember how many 'js result:' lines existed and read only NEW ones.
#
# ASCII-only on purpose (PS 5.1 reads BOM-less .ps1 as ANSI).
$ErrorActionPreference = 'Stop'

$root    = 'D:\aiagent\deepseek\dsh-douyin-scroll'
$exe     = Join-Path $root 'tools\pet-host\PetHost.exe'
$trace   = Join-Path $root 'tools\pet-host\trace.txt'
$nodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source

function Start-NoShell([string]$file, [string[]]$arguments) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $file
  if ($arguments -and $arguments.Count -gt 0) { $psi.Arguments = ($arguments -join ' ') }
  $psi.UseShellExecute = $false; $psi.CreateNoWindow = $true
  $p = New-Object System.Diagnostics.Process; $p.StartInfo = $psi; [void]$p.Start(); return $p
}

$tmpHome = Join-Path $env:TEMP ("petdm_" + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $tmpHome | Out-Null

$srv = @'
import http from 'node:http';
const port = Number(process.argv[2]);
const json = (res, o) => { const b = Buffer.from(JSON.stringify(o), 'utf8');
  res.writeHead(200, {'content-type':'application/json; charset=utf-8','content-length':b.length}); res.end(b); };
http.createServer((req, res) => json(res, { ok: true, state: 'idle', chat: { on: false },
  asset_ok: true, now: Date.now(), items: [], stars: 0, days: [], replies: [], nextSeq: 1 }))
  .listen(port, '127.0.0.1');
setTimeout(() => process.exit(0), 180000);
'@
[System.IO.File]::WriteAllText((Join-Path $tmpHome 'fake.mjs'), $srv, (New-Object System.Text.UTF8Encoding($false)))
$srvProc = Start-NoShell $nodeExe @((Join-Path $tmpHome 'fake.mjs'), '18995')
Start-Sleep -Milliseconds 900

$now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$state = [ordered]@{
  on = $true; persona = 'infp'; danmaku = $false; danmakuMode = 'off'
  link = [ordered]@{ state = 'idle' }
  api = 'http://127.0.0.1:18995/api/douyin-duty'
  activity = 'probe'; activityAt = $now; ts = $now
}
($state | ConvertTo-Json -Depth 6) | Set-Content (Join-Path $tmpHome 'pet-window-state.json') -Encoding UTF8

$existing = @(Get-Process PetHost -ErrorAction SilentlyContinue)
foreach ($pp in $existing) { try { Stop-Process -Id $pp.Id -Force -ErrorAction Stop } catch {} }
if ($existing.Count -gt 0) { Start-Sleep -Seconds 2 }

$env:DOUYIN_HOME = $tmpHome
$proc = Start-NoShell $exe @()
Start-Sleep -Seconds 9
Write-Output ("host pid : " + $proc.Id)
if ($proc.HasExited) { Write-Output 'exited early'; Get-Content (Join-Path $root 'tools\pet-host\pet-host-boot.log') -Encoding UTF8 -Tail 10; exit 1 }

$actFile = Join-Path $tmpHome 'pet-test.txt'

function Get-JsResultCount() {
  if (-not (Test-Path $trace)) { return 0 }
  return @(Get-Content $trace -Encoding UTF8 | Select-String 'js result:').Count
}

# Send JS and wait for a NEW result line (ignore stale ones).
function Send-Js([string]$js, [int]$extraWait = 1800) {
  $before = Get-JsResultCount
  [System.IO.File]::WriteAllText($actFile, ('js:' + $js), (New-Object System.Text.UTF8Encoding($false)))
  $deadline = (Get-Date).AddSeconds(12)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 300
    if ((Get-JsResultCount) -gt $before) { break }
  }
  Start-Sleep -Milliseconds $extraWait
  $lines = @(Get-Content $trace -Encoding UTF8 | Select-String 'js result:')
  if ($lines.Count -le $before) { return $null }
  $l = $lines[$before]     # the first NEW one
  $m = [regex]::Match($l.Line, 'js result: "(.*)"\s*$')
  if (-not $m.Success) { return $null }
  $raw = $m.Groups[1].Value -replace '\\"', '"'
  try { return ($raw | ConvertFrom-Json) } catch { return $raw }
}

$probe = @'
(function(){
  var d = document.getElementById('danmaku');
  var vis = 0, sample = '';
  for (const c of d.children) {
    if (getComputedStyle(c).display !== 'none') { vis++; if (!sample) sample = (c.textContent||'').slice(0,12); }
  }
  return JSON.stringify({ kids: d.children.length, visible: vis,
    layerDisp: getComputedStyle(d).display, sample: sample,
    hasAct: typeof window.__petAct === 'function' });
})()
'@

Write-Output ''
Write-Output '--- step 0: is the page interactive? ---'
$s0 = Send-Js $probe 600
Write-Output ("  state0: " + ($s0 | ConvertTo-Json -Compress))

Write-Output '--- step 1: local danmaku ON ---'
$null = Send-Js "window.__petAct('danmaku-local')" 2600
$s1 = Send-Js $probe 900
Write-Output ("  on-1  : " + ($s1 | ConvertTo-Json -Compress))

Write-Output '--- step 2: OFF (used to detach every node) ---'
$null = Send-Js "window.__petAct('danmaku-off')" 1600
$s2 = Send-Js $probe 900
Write-Output ("  off   : " + ($s2 | ConvertTo-Json -Compress))

Write-Output '--- step 3: ON again (used to stay empty forever) ---'
$null = Send-Js "window.__petAct('danmaku-local')" 2600
$s3 = Send-Js $probe 1200
Write-Output ("  on-2  : " + ($s3 | ConvertTo-Json -Compress))

$pass = 0; $fail = 0
function Check([bool]$c, [string]$m) { if ($c) { Write-Output ("  OK   " + $m); $script:pass++ } else { Write-Output ("  FAIL " + $m); $script:fail++ } }
Write-Output ''
if ($s0) { Check ([bool]$s0.hasAct) 'page exposes __petAct (script loaded)' }
if ($s1) { Check ($s1.visible -gt 0) ('danmaku visible on first ON (visible=' + $s1.visible + ' kids=' + $s1.kids + ')') } else { Write-Output '  on-1 no result'; $fail++ }
if ($s3) {
  Check ($s3.kids -gt 0) ('nodes rebuilt after OFF/ON (kids=' + $s3.kids + ')')
  Check ($s3.visible -gt 0) ('visible again after OFF/ON (visible=' + $s3.visible + ')')
} else { Write-Output '  on-2 no result'; $fail++ }
Write-Output ''
Write-Output ("RESULT: pass=" + $pass + " fail=" + $fail)

try { Stop-Process -Id $proc.Id -Force } catch {}
if (-not $srvProc.HasExited) { try { Stop-Process -Id $srvProc.Id -Force } catch {} }
Start-Sleep -Milliseconds 400
try { Remove-Item $tmpHome -Recurse -Force } catch {}
if ($fail -gt 0) { exit 1 }
