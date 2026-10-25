# probe-utf8.ps1 -- prove the TcpListener decodes UTF-8 request bodies correctly.
#
# Why this shape: PetHost locates the plugin root by walking UP from its own exe
# looking for tools\pet-page\index.html. A copy in %TEMP% cannot find it, so the
# static server never starts. So we run the REAL exe (real plugin root) and only
# point DOUYIN_HOME at a temp home + point its "api" at a local echo server.
#
# ASCII-only script on purpose: PS 5.1 reads BOM-less .ps1 as ANSI and mangles UTF-8.
$ErrorActionPreference = 'Stop'

$root = 'D:\aiagent\deepseek\dsh-douyin-scroll'
$exe = Join-Path $root 'tools\pet-host\PetHost.exe'
if (-not (Test-Path $exe)) { throw "no PetHost.exe at $exe" }

$echoPort = 18999
$tmpHome = Join-Path $env:TEMP ("petutf_" + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $tmpHome | Out-Null

# --- 1. start the fake upstream (node) --------------------------------------
$nodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $nodeExe) { throw 'node not found' }
$echoScript = 'D:\aiagent\deepseek\_echo-upstream.mjs'
$echoOut = Join-Path $tmpHome 'echo.out'
$echoErr = Join-Path $tmpHome 'echo.err'
$echo = Start-Process -FilePath $nodeExe -ArgumentList @($echoScript, $echoPort) -PassThru -WindowStyle Hidden -RedirectStandardOutput $echoOut -RedirectStandardError $echoErr
Start-Sleep -Milliseconds 900

# --- 2. temp home whose api points at the echo server ----------------------
$state = [ordered]@{
  on = $true
  persona = 'infp'
  danmaku = $false
  danmakuMode = 'off'
  link = [ordered]@{ state = 'idle' }
  api = ("http://127.0.0.1:$echoPort/api/douyin-duty")
  activity = 'probe'
  activityAt = 0
  ts = 0
}
($state | ConvertTo-Json -Depth 6) | Set-Content (Join-Path $tmpHome 'pet-window-state.json') -Encoding UTF8

# --- 3. launch the real host against the temp home -------------------------
$env:DOUYIN_HOME = $tmpHome
$proc = Start-Process -FilePath $exe -PassThru -WindowStyle Hidden
Start-Sleep -Seconds 7

$port = 0
foreach ($p in 8611..8616) {
  $c = Get-NetTCPConnection -State Listen -LocalPort $p -ErrorAction SilentlyContinue
  if ($c -and ($c.OwningProcess -contains $proc.Id)) { $port = $p; break }
}

# Payload comes from a real UTF-8 FILE, never from a PS string literal:
# PS 5.1 reads a BOM-less .ps1 as ANSI, so a Chinese literal inside this script
# would already be mangled before it is ever sent.
$payloadFile = Join-Path $root 'tools\pet-host\probe-payload.json'
if (-not (Test-Path $payloadFile)) { throw "missing payload file $payloadFile" }
$bodyBytes = [System.IO.File]::ReadAllBytes($payloadFile)
# strip a possible trailing CRLF so the comparison is exact
while ($bodyBytes.Length -gt 0 -and ($bodyBytes[$bodyBytes.Length - 1] -eq 10 -or $bodyBytes[$bodyBytes.Length - 1] -eq 13)) {
  $bodyBytes = $bodyBytes[0..($bodyBytes.Length - 2)]
}
$payload = [System.Text.Encoding]::UTF8.GetString($bodyBytes)

$respText = ''
if ($port -gt 0) {
  $url = ("http://127.0.0.1:$port" + '/api/dsh/douyin-duty/pet/chat')
  try {
    $req = [System.Net.HttpWebRequest]::Create($url)
    $req.Method = 'POST'
    $req.ContentType = 'application/json; charset=utf-8'
    $req.Timeout = 10000
    $req.ContentLength = $bodyBytes.Length
    $rs = $req.GetRequestStream()
    $rs.Write($bodyBytes, 0, $bodyBytes.Length)
    $rs.Close()
    $resp = $req.GetResponse()
    $sr = New-Object System.IO.StreamReader($resp.GetResponseStream(), [System.Text.Encoding]::UTF8)
    $respText = $sr.ReadToEnd()
    $sr.Close(); $resp.Close()
  } catch { $respText = 'EXC: ' + $_.Exception.Message }
}

Start-Sleep -Milliseconds 1200

# --- 4. stop by PID only ---------------------------------------------------
try { Stop-Process -Id $proc.Id -Force -ErrorAction Stop } catch { }
if (-not $echo.HasExited) { try { Stop-Process -Id $echo.Id -Force -ErrorAction Stop } catch { } }
Start-Sleep -Milliseconds 400

# --- 5. verdict ------------------------------------------------------------
$echoLine = ''
if (Test-Path $echoOut) { $echoLine = (Get-Content $echoOut -Encoding UTF8 | Where-Object { $_ -like 'REQ *' } | Select-Object -First 1) }

Write-Output '================ PROBE RESULT ================'
Write-Output ("host pid        : " + $proc.Id)
Write-Output ("static port     : " + $port)
Write-Output ("proxy response  : " + $respText)
Write-Output ("upstream saw    : " + $echoLine)

$ok = $false
if ($echoLine) {
  $j = ($echoLine.Substring(4) | ConvertFrom-Json)
  Write-Output ("upstream utf8   : " + $j.utf8)
  Write-Output ("upstream bytes  : " + $j.bytes)
  Write-Output ("sent bytes      : " + $bodyBytes.Length)
  Write-Output ("has '????'      : " + $j.hasQuestionMarks)
  Write-Output ("has U+FFFD      : " + $j.hasReplacement)
  if ($j.utf8 -eq $payload -and -not $j.hasQuestionMarks -and $j.bytes -eq $bodyBytes.Length) { $ok = $true }
}
Write-Output ("VERDICT         : " + $(if ($ok) { 'UTF-8 PASS' } else { 'UTF-8 FAIL' }))

Remove-Item $tmpHome -Recurse -Force -ErrorAction SilentlyContinue
if (-not $ok) { exit 1 }
