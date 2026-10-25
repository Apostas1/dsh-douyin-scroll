# probe-layout.ps1 -- prove the input box is FIXED and can grow beyond 3 lines.
#
# User complaints (2026-10-25 evening):
#   1. "宠物下面的对话框要固定位置，不要因为点击对话框就自动弹上去了"
#   2. "文本输入框太丑了"
#   3. "文本框只能输入三行就不变化了"
#
# Method: run the REAL host against a temp home + fake upstream, drive the page via
# the pet-test.txt channel (`js:` prefix), read measurements back from trace.txt.
# trace.txt is truncated before each measurement so we never read a stale result
# (that mistake made a previous run report base twice -- caught and fixed here).
#
# ASCII-only on purpose (PS 5.1 reads BOM-less .ps1 as ANSI).
$ErrorActionPreference = 'Stop'

$root    = 'D:\aiagent\deepseek\dsh-douyin-scroll'
$exe     = Join-Path $root 'tools\pet-host\PetHost.exe'
$trace   = Join-Path $root 'tools\pet-host\trace.txt'
$nodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not (Test-Path $exe)) { throw 'no PetHost.exe' }

function Start-NoShell([string]$file, [string[]]$arguments) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $file
  if ($arguments -and $arguments.Count -gt 0) { $psi.Arguments = ($arguments -join ' ') }
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $p = New-Object System.Diagnostics.Process
  $p.StartInfo = $psi
  [void]$p.Start()
  return $p
}

$tmpHome = Join-Path $env:TEMP ("petlay_" + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $tmpHome | Out-Null

$srv = @'
import http from 'node:http';
const port = Number(process.argv[2]);
const json = (res, o) => { const b = Buffer.from(JSON.stringify(o), 'utf8');
  res.writeHead(200, {'content-type':'application/json; charset=utf-8','content-length':b.length}); res.end(b); };
http.createServer((req, res) => {
  if (req.url.startsWith('/api/douyin-duty/pet/chat')) {
    let body=''; req.on('data',c=>body+=c);
    req.on('end',()=>json(res,{ok:true,brain:'session',relayed:true,mode:'followup',
      sessionId:'session-probe',queued:true,runningNow:false,afterSeq:1,say:'ok-probe',anim:''}));
    return;
  }
  if (req.url.startsWith('/api/douyin-duty/pet/reply')) return json(res,{ok:true,replies:[],nextSeq:2});
  if (req.url.startsWith('/api/douyin-duty/pet/diary')) return json(res,{ok:true,day:'2026-10-25',items:[],stars:0,days:[]});
  if (req.url.startsWith('/api/douyin-duty/pet/state')) return json(res,{ok:true,state:'idle',chat:{on:false},asset_ok:true,now:Date.now()});
  return json(res,{ok:true});
}).listen(port,'127.0.0.1');
setTimeout(()=>process.exit(0),180000);
'@
$srvPath = Join-Path $tmpHome 'fake.mjs'
[System.IO.File]::WriteAllText($srvPath, $srv, (New-Object System.Text.UTF8Encoding($false)))
$srvProc = Start-NoShell $nodeExe @($srvPath, '18996')
Start-Sleep -Milliseconds 900

$now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$state = [ordered]@{
  on = $true; persona = 'infp'; danmaku = $false; danmakuMode = 'off'
  link = [ordered]@{ state = 'idle' }
  api = 'http://127.0.0.1:18996/api/douyin-duty'
  activity = 'probe'; activityAt = $now; ts = $now
}
($state | ConvertTo-Json -Depth 6) | Set-Content (Join-Path $tmpHome 'pet-window-state.json') -Encoding UTF8

$existing = @(Get-Process PetHost -ErrorAction SilentlyContinue)
if ($existing.Count -gt 0) {
  Write-Output ("stopping existing pet (PID: " + ($existing.Id -join ',') + ")")
  foreach ($pp in $existing) { try { Stop-Process -Id $pp.Id -Force -ErrorAction Stop } catch {} }
  Start-Sleep -Seconds 2
}

$env:DOUYIN_HOME = $tmpHome
$proc = Start-NoShell $exe @()
Start-Sleep -Seconds 9

Write-Output '================ LAYOUT PROBE ================'
Write-Output ("host pid : " + $proc.Id)
if ($proc.HasExited) {
  Write-Output 'host exited early; boot log tail:'
  Get-Content (Join-Path $root 'tools\pet-host\pet-host-boot.log') -Encoding UTF8 -Tail 12
  try { Stop-Process -Id $srvProc.Id -Force } catch {}
  exit 1
}

$actFile = Join-Path $tmpHome 'pet-test.txt'

function Send-PageJs([string]$js, [int]$waitMs = 2200) {
  if (Test-Path $trace) { try { Remove-Item $trace -Force -ErrorAction Stop } catch {} }
  [System.IO.File]::WriteAllText($actFile, ('js:' + $js), (New-Object System.Text.UTF8Encoding($false)))
  Start-Sleep -Milliseconds $waitMs
  if (-not (Test-Path $trace)) { return $null }
  $line = Get-Content $trace -Encoding UTF8 | Select-String -Pattern 'js result:' | Select-Object -Last 1
  if (-not $line) { return $null }
  $m = [regex]::Match($line.Line, 'js result: "(.*)"\s*$')
  if (-not $m.Success) { return $null }
  $raw = $m.Groups[1].Value -replace '\\"', '"'
  try { return ($raw | ConvertFrom-Json) } catch { return $raw }
}

$pass = 0; $fail = 0
function Check([bool]$cond, [string]$msg) {
  if ($cond) { Write-Output ("  OK   " + $msg); $script:pass++ }
  else { Write-Output ("  FAIL " + $msg); $script:fail++ }
}

Write-Output ''
Write-Output '--- 1) open chat, 1 line ---'
$null = Send-PageJs "window.__petAct && window.__petAct('chat')" 2500
$base = Send-PageJs @'
(function(){
  function R(id){var e=document.getElementById(id);if(!e)return null;
    var r=e.getBoundingClientRect(),s=getComputedStyle(e);
    return {y:Math.round(r.top),h:Math.round(r.height),bottom:Math.round(r.bottom),
      maxH:s.maxHeight,minH:s.minHeight,lineH:s.lineHeight,disp:s.display};}
  var ta=document.getElementById('chat-input');
  if(ta){ ta.value='one line'; ta.dispatchEvent(new Event('input')); }
  return JSON.stringify({phase:'base',open:document.getElementById('talkbar').classList.contains('on'),
    talkbar:R('talkbar'),input:R('chat-input'),toolbar:R('toolbar')});
})()
'@ 2000
if ($base) { Write-Output ("  base : input y=" + $base.input.y + " h=" + $base.input.h + " bottom=" + $base.input.bottom + " | toolbar bottom=" + $base.toolbar.bottom + " open=" + $base.open) }

Write-Output ''
Write-Output '--- 2) 7 lines ---'
$grown = Send-PageJs @'
(function(){
  function R(id){var e=document.getElementById(id);if(!e)return null;
    var r=e.getBoundingClientRect(),s=getComputedStyle(e);
    return {y:Math.round(r.top),h:Math.round(r.height),bottom:Math.round(r.bottom),
      maxH:s.maxHeight,minH:s.minHeight,lineH:s.lineHeight,disp:s.display};}
  var ta=document.getElementById('chat-input');
  if(ta){ ta.value='L1\nL2\nL3\nL4\nL5\nL6\nL7'; ta.dispatchEvent(new Event('input')); }
  return JSON.stringify({phase:'grown',open:document.getElementById('talkbar').classList.contains('on'),
    talkbar:R('talkbar'),input:R('chat-input'),toolbar:R('toolbar'),
    scrollH:ta?ta.scrollHeight:0, styleH:ta?ta.style.height:''});
})()
'@ 2000
if ($grown) { Write-Output ("  grown: input y=" + $grown.input.y + " h=" + $grown.input.h + " bottom=" + $grown.input.bottom + " scrollH=" + $grown.scrollH + " styleH=" + $grown.styleH) }

Write-Output ''
Write-Output '--- 3) judge input behaviour ---'
if ($base -and $grown) {
  Check ([bool]$base.open) 'chat bar opens'
  Check ($grown.input.h -gt $base.input.h) ('input grows with content: ' + $base.input.h + ' -> ' + $grown.input.h + 'px')
  Check ([Math]::Abs($grown.input.bottom - $base.input.bottom) -le 2) ('input bottom edge stays put (' + $base.input.bottom + ' -> ' + $grown.input.bottom + ')')
  Check ([Math]::Abs($grown.toolbar.bottom - $base.toolbar.bottom) -le 2) ('toolbar does not move (' + $base.toolbar.bottom + ' -> ' + $grown.toolbar.bottom + ')')
  Check ($base.input.bottom -lt $base.toolbar.y) ('input sits ABOVE toolbar (input.bottom=' + $base.input.bottom + ' < toolbar.top=' + $base.toolbar.y + ')')
  $maxPx = [double](($base.input.maxH -replace 'px','')); if ($maxPx -le 0) { $maxPx = 96 }
  $lhPx  = [double](($base.input.lineH -replace 'px','')); if ($lhPx -le 0) { $lhPx = 19 }
  $maxLines = [Math]::Floor($maxPx / $lhPx)
  Write-Output ("  max-height=" + $maxPx + "px line-height=" + $lhPx + "px => up to " + $maxLines + " lines")
  Check ($maxLines -ge 4) ('more than 3 lines possible (max ' + $maxLines + ')')
} else { Write-Output '  missing measurements'; $fail++ }

Write-Output ''
Write-Output '--- 4) danmaku off/on must rebuild nodes ---'
$null = Send-PageJs "window.__petAct('danmaku-local')" 1500
$on1 = Send-PageJs "JSON.stringify({k:document.getElementById('danmaku').children.length})" 1200
$null = Send-PageJs "window.__petAct('danmaku-off')" 1500
$off1 = Send-PageJs "JSON.stringify({k:document.getElementById('danmaku').children.length})" 1200
$null = Send-PageJs "window.__petAct('danmaku-local')" 1500
$on2 = Send-PageJs @'
(function(){ var d=document.getElementById('danmaku'); var vis=0;
  for(const c of d.children) if(getComputedStyle(c).display!=='none') vis++;
  return JSON.stringify({k:d.children.length,vis:vis,disp:getComputedStyle(d).display}); })()
'@ 2500
Write-Output ("  on1=" + ($on1 | ConvertTo-Json -Compress) + "  off=" + ($off1 | ConvertTo-Json -Compress) + "  on2=" + ($on2 | ConvertTo-Json -Compress))
if ($on2) {
  Check ($on2.k -gt 0) ('danmaku DOM rebuilt after off/on (children=' + $on2.k + ')')
  Check ($on2.vis -gt 0) ('danmaku visible again after off/on (visible=' + $on2.vis + ')')
} else { Write-Output '  no dm result'; $fail++ }

Write-Output ''
Write-Output ("RESULT: pass=" + $pass + " fail=" + $fail)
try { Stop-Process -Id $proc.Id -Force -ErrorAction Stop } catch {}
if (-not $srvProc.HasExited) { try { Stop-Process -Id $srvProc.Id -Force -ErrorAction Stop } catch {} }
Start-Sleep -Milliseconds 400
try { Remove-Item $tmpHome -Recurse -Force -ErrorAction SilentlyContinue } catch {}
if ($fail -gt 0) { exit 1 }
