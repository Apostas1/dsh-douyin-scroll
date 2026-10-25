# build-host.ps1 -- compile PetHost.cs into PetHost.exe (PS 5.1, .NET Framework csc.exe)
# ASCII-only on purpose: PS 5.1 reads BOM-less .ps1 as ANSI and mangles UTF-8 comments.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File tools\pet-host\build-host.ps1
$ErrorActionPreference = 'Stop'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$csc = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) { throw "csc.exe not found: $csc" }

$refs = @(
  'C:\Windows\Microsoft.NET\assembly\GAC_MSIL\WindowsBase\v4.0_4.0.0.0__31bf3856ad364e35\WindowsBase.dll',
  'C:\Windows\Microsoft.NET\assembly\GAC_64\PresentationCore\v4.0_4.0.0.0__31bf3856ad364e35\PresentationCore.dll',
  'C:\Windows\Microsoft.NET\assembly\GAC_MSIL\PresentationFramework\v4.0_4.0.0.0__31bf3856ad364e35\PresentationFramework.dll',
  'C:\Windows\Microsoft.NET\assembly\GAC_MSIL\System.Xaml\v4.0_4.0.0.0__b77a5c561934e089\System.Xaml.dll',
  (Join-Path $here 'Microsoft.Web.WebView2.Core.dll'),
  (Join-Path $here 'Microsoft.Web.WebView2.Wpf.dll')
)
foreach ($r in $refs) { if (-not (Test-Path $r)) { throw "missing reference: $r" } }

$tmp = Join-Path $env:TEMP ("ph_" + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $tmp | Out-Null

$argList = @('/nologo', '/target:winexe', '/platform:x64', '/optimize+', "/out:$tmp\PetHost.exe")
foreach ($r in $refs) { $argList += "/r:$r" }
$argList += (Join-Path $here 'PetHost.cs')

& $csc @argList 2>&1 | Where-Object { $_ -notmatch 'warning CS0414' } | ForEach-Object { Write-Output $_ }
if ($LASTEXITCODE -ne 0) {
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
  throw "csc failed (exit=$LASTEXITCODE)"
}
if (-not (Test-Path "$tmp\PetHost.exe")) { throw 'csc reported success but produced no exe' }

# deploy: stop any running instance (the exe file is locked while running), backup, overwrite
$target = Join-Path $here 'PetHost.exe'
$running = @(Get-Process -Name PetHost -ErrorAction SilentlyContinue)
if ($running.Count -gt 0) {
  Write-Output ("stopping running PetHost (PID: " + ($running.Id -join ',') + ")")
  foreach ($p in $running) {
    try { Stop-Process -Id $p.Id -Force -ErrorAction Stop } catch { Write-Output ("  stop " + $p.Id + " failed: " + $_.Exception.Message) }
  }
  Start-Sleep -Seconds 1
}
# 2026-10-25: Copy-Item -Force can silently do NOTHING when the target is locked.
# Symptom: build reports success and the timestamp changes, but the old binary still runs.
# Fix: delete the old file explicitly, File.Copy it, then compare SHA256.
# Every step throws loudly on failure; nothing is silent.
if (Test-Path $target) {
  try { Copy-Item $target "$target.bak" -Force } catch { Write-Output ("  backup failed: " + $_.Exception.Message) }
  $removed = $false
  for ($attempt = 0; $attempt -lt 10 -and -not $removed; $attempt++) {
    # NOTE: keep this file pure ASCII. PS 5.1 reads a BOM-less .ps1 as ANSI and
    # any non-ASCII byte (emoji/CJK) can break quote pairing -> "Unexpected token".
    # That is exactly how an emoji in a comment broke this script once.
    try { Remove-Item $target -Force -ErrorAction Stop; $removed = $true } catch { Start-Sleep -Milliseconds 400 }
  }
  if (-not $removed) { throw "cannot delete old $target (still locked) - stop PetHost and retry" }
}
try {
  [System.IO.File]::Copy("$tmp\PetHost.exe", $target, $true)
} catch {
  throw ("copy to target failed: " + $_.Exception.Message)
}
# Byte-for-byte check: what we deploy must BE the freshly built file.
$srcHash = (Get-FileHash "$tmp\PetHost.exe" -Algorithm SHA256).Hash
$dstHash = (Get-FileHash $target -Algorithm SHA256).Hash
if ($srcHash -ne $dstHash) {
  throw ("deployed exe does not match the freshly built one!`n  built:    $srcHash`n  deployed: $dstHash")
}
Write-Output ("hash verified: " + $srcHash.Substring(0, 16) + "...")
Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue

$fi = Get-Item $target
Write-Output ("built: " + $fi.Name + "  " + $fi.Length + " bytes  " + $fi.LastWriteTime.ToString('HH:mm:ss'))
