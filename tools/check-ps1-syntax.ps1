# check-ps1-syntax.ps1 -- report parse errors of a .ps1 with line numbers
# ASCII-only on purpose (PS 5.1 reads BOM-less .ps1 as ANSI).
param([Parameter(Mandatory=$true)][string]$Path)

$tokens = $null
$errors = $null
$null = [System.Management.Automation.Language.Parser]::ParseFile($Path, [ref]$tokens, [ref]$errors)
if ($errors -and $errors.Count -gt 0) {
  Write-Output ("parse errors: " + $errors.Count)
  foreach ($e in $errors) {
    Write-Output ("  line " + $e.Extent.StartLineNumber + ": " + $e.Message)
    Write-Output ("     >>> " + $e.Extent.Text)
  }
  exit 1
}
Write-Output "syntax OK"
