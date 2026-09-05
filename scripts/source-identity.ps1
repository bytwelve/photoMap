Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'build-inputs.ps1')

function Get-ProductBuildInputIdentity {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)] [string]$AppRoot,
    [object[]]$InputFiles
  )

  if (-not $PSBoundParameters.ContainsKey('InputFiles')) {
    $InputFiles = @(Get-ProductBuildInputFiles -AppRoot $AppRoot)
  }
  $records = @{}
  foreach ($inputFile in $InputFiles) {
    $file = Get-Item -LiteralPath $inputFile.fullName -Force -ErrorAction Stop
    if ($file.PSIsContainer -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "Build input must be an ordinary file: $($file.FullName)"
    }
    $key = "app/$($inputFile.relativePath)"
    $records[$key] = [pscustomobject]@{
      key = $key
      bytes = [int64]$file.Length
      sha256 = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256 -ErrorAction Stop).Hash
      lastWriteTimeUtc = $file.LastWriteTimeUtc
    }
  }

  [string[]]$keys = @($records.Keys)
  [Array]::Sort($keys, [StringComparer]::Ordinal)
  $ordered = @($keys | ForEach-Object { $records[$_] })
  $identityText = ($ordered | ForEach-Object { "$($_.key)`0$($_.bytes)`0$($_.sha256)`n" }) -join ''
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try {
    $digestBytes = $algorithm.ComputeHash([Text.Encoding]::UTF8.GetBytes($identityText))
  } finally {
    $algorithm.Dispose()
  }
  $digest = ([BitConverter]::ToString($digestBytes)).Replace('-', '')
  $latest = $ordered | Sort-Object lastWriteTimeUtc -Descending | Select-Object -First 1

  [pscustomobject]@{
    schemaVersion = 2
    identityRule = 'SHA-256 over ordinally sorted scope/path, byte length, and file SHA-256 records.'
    inputManifest = 'scripts/build/input-manifest.json'
    fileCount = $ordered.Count
    bytes = [int64](($ordered | Measure-Object -Property bytes -Sum).Sum)
    latestWriteUtc = if ($null -eq $latest) { $null } else { $latest.lastWriteTimeUtc.ToString('o') }
    sha256 = $digest
    scopes = @('app')
  }
}

function Get-OptionalGitHead {
  [CmdletBinding()]
  param([Parameter(Mandatory)] [string]$AppRoot)

  # A source ZIP is buildable without Git metadata or even a Git install.
  if ($null -eq (Get-Command git -ErrorAction SilentlyContinue)) { return $null }
  $repository = @(& git -C $AppRoot rev-parse --show-toplevel 2>$null)
  if ($LASTEXITCODE -ne 0 -or $repository.Count -ne 1 -or
      [IO.Path]::GetFullPath(([string]$repository[0]).Trim()) -ine [IO.Path]::GetFullPath($AppRoot).TrimEnd([IO.Path]::DirectorySeparatorChar)) { return $null }
  $output = @(& git -C $AppRoot rev-parse --verify HEAD 2>$null)
  if ($LASTEXITCODE -ne 0 -or $output.Count -ne 1) { return $null }
  return ([string]$output[0]).Trim()
}
