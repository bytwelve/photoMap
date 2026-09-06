[CmdletBinding()]
param(
  [ValidateSet('fast', 'all')]
  [string]$Gate = 'fast'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion -lt [version]'7.2') {
  throw 'verify-local.ps1 requires PowerShell 7.2 or newer.'
}

$appRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$package = Get-Content -LiteralPath (Join-Path $appRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$requiredNodeVersion = (Get-Content -LiteralPath (Join-Path $appRoot '.node-version') -Raw -Encoding UTF8).Trim()
$actualNodeVersion = (@(& node --version 2>&1) -join "`n").Trim().TrimStart('v')
if ($LASTEXITCODE -ne 0 -or $actualNodeVersion -ne $requiredNodeVersion) {
  throw "Node.js $requiredNodeVersion is required; current runtime is $actualNodeVersion."
}
$requiredNpmVersion = ([string]$package.packageManager).Replace('npm@', '')
$actualNpmVersion = (@(& npm --version 2>&1) -join "`n").Trim()
if ($LASTEXITCODE -ne 0 -or $actualNpmVersion -ne $requiredNpmVersion) {
  throw "npm $requiredNpmVersion is required; current runtime is $actualNpmVersion."
}
. (Join-Path $PSScriptRoot 'source-identity.ps1')
$sourceIdentity = Get-ProductBuildInputIdentity -AppRoot $appRoot
$runId = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ')
$resultRoot = Join-Path $appRoot "test-results\$runId"
$logRoot = Join-Path $resultRoot 'logs'
$null = New-Item -ItemType Directory -Path $logRoot -Force

function Invoke-ExternalStep {
  param(
    [Parameter(Mandatory)] [string]$Name,
    [Parameter(Mandatory)] [string]$WorkingDirectory,
    [Parameter(Mandatory)] [string]$Command,
    [Parameter(Mandatory)] [string[]]$Arguments,
    [string]$RequiredText = ''
  )

  $startedAt = [DateTime]::UtcNow
  $logPath = Join-Path $logRoot "$Name.log"
  $output = @()
  $exitCode = 1

  Push-Location -LiteralPath $WorkingDirectory
  try {
    $output = @(& $Command @Arguments 2>&1)
    $exitCode = $LASTEXITCODE
    if ($null -eq $exitCode) {
      $exitCode = 0
    }
  }
  catch {
    $output += $_ | Out-String
    $exitCode = 1
  }
  finally {
    Pop-Location
  }

  $output | Out-File -LiteralPath $logPath -Encoding utf8
  if ($exitCode -eq 0 -and $RequiredText.Length -gt 0) {
    $joined = $output -join "`n"
    if (-not $joined.Contains($RequiredText, [StringComparison]::Ordinal)) {
      $output += "Required text not found: $RequiredText"
      $output | Out-File -LiteralPath $logPath -Encoding utf8
      $exitCode = 1
    }
  }

  $status = if ($exitCode -eq 0) { 'passed' } else { 'failed' }
  Write-Host "[$status] $Name"
  if ($exitCode -ne 0) {
    $output | ForEach-Object { Write-Host $_ }
  }

  [pscustomobject]@{
    name = $Name
    command = "$Command $($Arguments -join ' ')"
    workingDirectory = $WorkingDirectory
    startedAtUtc = $startedAt.ToString('o')
    finishedAtUtc = [DateTime]::UtcNow.ToString('o')
    exitCode = $exitCode
    status = $status
    log = "logs/$Name.log"
  }
}

$startedAt = [DateTime]::UtcNow
$steps = @()
$steps += Invoke-ExternalStep `
  -Name 'app-check' `
  -WorkingDirectory $appRoot `
  -Command 'npm' `
  -Arguments @('run', 'check')

if ($Gate -eq 'all') {
  $steps += Invoke-ExternalStep `
    -Name 'app-make' `
    -WorkingDirectory $appRoot `
    -Command 'npm' `
    -Arguments @('run', 'make')
}

$failed = @($steps | Where-Object status -eq 'failed')
$summary = [ordered]@{
  entryVersion = 1
  gate = $Gate
  runId = $runId
  environment = [ordered]@{
    os = [Environment]::OSVersion.VersionString
    powershell = $PSVersionTable.PSVersion.ToString()
    node = @(& node --version 2>&1) -join "`n"
    npm = @(& npm --version 2>&1) -join "`n"
  }
  startedAtUtc = $startedAt.ToString('o')
  finishedAtUtc = [DateTime]::UtcNow.ToString('o')
  sourceIdentity = $sourceIdentity
  gitHeadAtStart = Get-OptionalGitHead -AppRoot $appRoot
  passed = @($steps | Where-Object status -eq 'passed').Count
  failed = $failed.Count
  skipped = 0
  exitCode = if ($failed.Count -eq 0) { 0 } else { 1 }
  steps = $steps
}
$summary | ConvertTo-Json -Depth 8 | Out-File -LiteralPath (Join-Path $resultRoot 'summary.json') -Encoding utf8

Write-Host "Results: $resultRoot"
exit $summary.exitCode
