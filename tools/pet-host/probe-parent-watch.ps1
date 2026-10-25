# probe-parent-watch.ps1 -- prove she dies when the DSH host dies.
#
# User's report: "closing DSH does not close the pet".
#
# Design note (this is why the first version of this probe was wrong):
# PetHost resolves its parent via WMI `ParentProcessId`. For that to be the DSH
# host, the DSH host must be the process that ACTUALLY spawned PetHost. Starting a
# node process and PetHost side by side does NOT make node its parent -- and the
# probe then "proves" a bug that is not there.
#
# So here a small node script (_fake-dsh.mjs) plays the DSH host: it spawns PetHost
# itself (real parent-child), stays alive, then exits. We then check both directions:
#   A) parent alive -> she must stay
#   B) parent gone  -> she must exit within the grace window
#
# Every process is started without a shell (no UAC prompts; nobody clicks anything).
# ASCII-only on purpose (PS 5.1 reads BOM-less .ps1 as ANSI).
$ErrorActionPreference = 'Stop'

$root    = 'D:\aiagent\deepseek\dsh-douyin-scroll'
$exe     = Join-Path $root 'tools\pet-host\PetHost.exe'
$nodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source
$fakeDsh = 'D:\aiagent\deepseek\_fake-dsh.mjs'
if (-not (Test-Path $exe))     { throw 'no PetHost.exe' }
if (-not (Test-Path $fakeDsh)) { throw ('no ' + $fakeDsh) }
if (-not $nodeExe)             { throw 'node not found' }

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

$tmpHome = Join-Path $env:TEMP ("petparent_" + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $tmpHome | Out-Null

$now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$state = [ordered]@{
  on = $true; persona = 'infp'; danmaku = $false; danmakuMode = 'off'
  link = [ordered]@{ state = 'idle' }
  api = 'http://127.0.0.1:18997/api/douyin-duty'
  activity = 'probe'; activityAt = $now; ts = $now
}
($state | ConvertTo-Json -Depth 6) | Set-Content (Join-Path $tmpHome 'pet-window-state.json') -Encoding UTF8

$report = Join-Path $tmpHome 'report.json'

# --- start the fake DSH; it spawns the pet as its own child ---------------
$dsh = Start-NoShell $nodeExe @('"' + $fakeDsh + '"', '"' + $exe + '"', '"' + $tmpHome + '"', '16', '"' + $report + '"')
Start-Sleep -Seconds 2

if (-not (Test-Path $report)) { throw 'fake DSH did not write its report' }
$rec = Get-Content $report -Raw -Encoding UTF8 | ConvertFrom-Json
$petPid = [int]$rec.petPid
Write-Output '================ PARENT WATCH PROBE ================'
Write-Output ("fake DSH pid : " + $rec.parentPid)
Write-Output ("PetHost pid  : " + $petPid)

# --- A. parent is alive, is she alive too? -------------------------------
$pet = Get-Process -Id $petPid -ErrorAction SilentlyContinue
$aliveA = ($null -ne $pet)
Write-Output ("A) parent alive -> pet alive : " + $aliveA)

# confirm SHE resolved the right parent (this is the exact thing that used to be wrong)
$trace = Join-Path $root 'tools\pet-host\trace.txt'
$herParent = ''
if (Test-Path $trace) {
  $line = Get-Content $trace -Encoding UTF8 | Where-Object { $_ -match 'parent watch: parent pid=' } | Select-Object -Last 1
  if ($line) { $herParent = ([regex]::Match($line, 'parent pid=(\d+)')).Groups[1].Value }
}
Write-Output ("   she thinks her parent is : " + $herParent + $(if ($herParent -eq $rec.parentPid) { '  (correct)' } else { '  (WRONG - expected ' + $rec.parentPid + ')' }))

# --- B. wait for the fake DSH to exit on its own, then watch her ---------
Write-Output 'waiting for the fake DSH to exit on its own...'
$deadline = (Get-Date).AddSeconds(30)
while (-not $dsh.HasExited -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
Write-Output ("   fake DSH exited : " + $dsh.HasExited)

$died = $false
$waited = 0
$killAt = Get-Date
while ($waited -lt 20) {
  Start-Sleep -Seconds 1
  $waited++
  $pet.Refresh()
  if ($pet.HasExited) { $died = $true; break }
}
Write-Output ("B) parent dead  -> pet dead  : " + $died + "  (after ~" + $waited + "s)")

# --- evidence from her own log ------------------------------------------
$traceLines = @()
foreach ($tf in @($trace, (Join-Path $tmpHome 'pet-host.log'), (Join-Path $tmpHome 'trace.txt'))) {
  if (Test-Path $tf) { $traceLines += Get-Content $tf -Encoding UTF8 | Where-Object { $_ -match 'parent' } | Select-Object -Last 10 }
}
Write-Output '--- parent-watch log lines ---'
foreach ($l in $traceLines) { Write-Output ('  ' + $l) }

# --- verdict -------------------------------------------------------------
$parentCorrect = ($herParent -eq [string]$rec.parentPid)
if ($aliveA -and $died -and $parentCorrect) { Write-Output 'VERDICT : PARENT WATCH PASS' }
elseif (-not $aliveA) { Write-Output 'VERDICT : FAIL (she died while the parent was still alive -- the old self-kill bug)' }
elseif (-not $died)   { Write-Output 'VERDICT : FAIL (parent died but she is still running)' }
else { Write-Output 'VERDICT : FAIL (she resolved the wrong parent pid)' }

# --- cleanup: only our own pids -----------------------------------------
try { if (-not $pet.HasExited) { Stop-Process -Id $petPid -Force -ErrorAction Stop } } catch {}
try { if (-not $dsh.HasExited) { Stop-Process -Id $dsh.Id -Force -ErrorAction Stop } } catch {}
Start-Sleep -Milliseconds 500
try { Remove-Item $tmpHome -Recurse -Force -ErrorAction SilentlyContinue } catch {}

if (-not ($aliveA -and $died -and $parentCorrect)) { exit 1 }
