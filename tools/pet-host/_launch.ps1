# _launch.ps1 -- start a process WITHOUT going through ShellExecute.
# Why: Start-Process uses ShellExecuteEx, which can raise a UAC / "canceled by the
# user" (ERROR_CANCELLED 1223) prompt even for a plain winexe. That means somebody
# has to click. Using ProcessStartInfo with UseShellExecute=$false launches the
# child directly -- no shell, no elevation, no prompt.
#
# ASCII-only on purpose (PS 5.1 reads BOM-less .ps1 as ANSI).
param(
  [Parameter(Mandatory=$true)][string]$FilePath,
  [string[]]$Arguments = @(),
  [string]$WorkingDirectory = '',
  [string]$StdOutFile = '',
  [string]$StdErrFile = ''
)

$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $FilePath
if ($Arguments.Count -gt 0) { $psi.Arguments = ($Arguments -join ' ') }
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true
$psi.RedirectStandardOutput = ($StdOutFile -ne '')
$psi.RedirectStandardError  = ($StdErrFile  -ne '')
if ($WorkingDirectory -ne '') { $psi.WorkingDirectory = $WorkingDirectory }

$p = New-Object System.Diagnostics.Process
$p.StartInfo = $psi
[void]$p.Start()

if ($StdOutFile -ne '') {
  try { $p.StandardOutput.ReadToEnd() | Set-Content $StdOutFile -Encoding UTF8 } catch {}
}
if ($StdErrFile -ne '') {
  try { $p.StandardError.ReadToEnd() | Set-Content $StdErrFile -Encoding UTF8 } catch {}
}

Write-Output $p.Id
