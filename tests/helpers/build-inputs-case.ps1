param(
  [Parameter(Mandatory)] [string]$AppRoot,
  [string]$StageRoot = ''
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../../scripts/source-identity.ps1')
$files = @(Get-ProductBuildInputFiles -AppRoot $AppRoot)
$identity = Get-ProductBuildInputIdentity -AppRoot $AppRoot -InputFiles $files
$result = [ordered]@{
  paths = @($files.relativePath | Sort-Object -CaseSensitive)
  identity = $identity
  gitHead = Get-OptionalGitHead -AppRoot $AppRoot
}
if ($StageRoot.Length -gt 0) {
  Copy-ProductBuildInputs -InputFiles $files -DestinationRoot $StageRoot
  $result.stagedIdentity = Get-ProductBuildInputIdentity -AppRoot $StageRoot
}
$result | ConvertTo-Json -Depth 5
