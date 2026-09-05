param([Parameter(Mandatory)] [string]$ResultRoot)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../../scripts/release/release-verification.ps1')
$summary = Get-Content -LiteralPath (Join-Path $ResultRoot 'summary.json') -Raw -Encoding UTF8 | ConvertFrom-Json
Assert-ReleaseFastGate -Summary $summary -ResultRoot $ResultRoot `
  -SourceIdentity ([pscustomobject]@{ sha256 = ('A' * 64); fileCount = 25 }) `
  -RequiredNodeVersion '24.19.0' -RequiredNpmVersion '11.12.1'
'{"passed":true}'
