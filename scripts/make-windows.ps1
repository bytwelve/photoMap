[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$appRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
Push-Location -LiteralPath $appRoot
try {
  & npm run package:forge
  if ($LASTEXITCODE -ne 0) { throw 'Application packaging failed.' }
  & npm run make:squirrel
  if ($LASTEXITCODE -ne 0) { throw 'Windows installer creation failed.' }
  & npm run package:portable
  if ($LASTEXITCODE -ne 0) { throw 'Portable package creation failed.' }
} finally {
  Pop-Location
}
