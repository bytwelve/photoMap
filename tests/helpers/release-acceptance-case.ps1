param([string]$EvidencePath = '')
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../../scripts/release/release-acceptance.ps1')
Get-ReleaseAcceptance -Path $EvidencePath -Version '1.0.0' -InstallerSha256 ('A' * 64) -ApplicationPayloadSha256 ('B' * 64) | ConvertTo-Json -Depth 8
