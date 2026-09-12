[CmdletBinding()]
param(
  [string]$StageBase = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion -lt [version]'7.2') {
  throw 'make-windows.ps1 requires PowerShell 7.2 or newer.'
}

$appRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$package = Get-Content -LiteralPath (Join-Path $appRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
. (Join-Path $PSScriptRoot 'build-toolchain.ps1')
foreach ($tool in @('node', 'npm')) {
  $actualVersion = (@(& $tool --version 2>&1) -join "`n").Trim().TrimStart('v')
  if ($LASTEXITCODE -ne 0) { throw "Unable to read $tool version: $actualVersion" }
  Assert-CompatibleBuildVersion -Tool $tool -ActualVersion $actualVersion -RequiredRange $package.engines.$tool
}
. (Join-Path $PSScriptRoot 'source-identity.ps1')
$buildInputFiles = @(Get-ProductBuildInputFiles -AppRoot $appRoot)
$buildInputIdentity = Get-ProductBuildInputIdentity -AppRoot $appRoot -InputFiles $buildInputFiles
$nodeModules = (Resolve-Path -LiteralPath (Join-Path $appRoot 'node_modules')).Path
$basePath = if ($StageBase.Trim().Length -gt 0) {
  [IO.Path]::GetFullPath($StageBase)
} else {
  [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
}
if ($basePath -match '[^\x00-\x7F]') {
  throw 'Squirrel staging needs an ASCII-only path. Pass -StageBase with a writable ASCII path.'
}

$stageRoot = Join-Path $basePath "PhotoMapMake-$([guid]::NewGuid().ToString('N'))"
$stageApp = Join-Path $stageRoot 'app'
$stageNodeModules = Join-Path $stageApp 'node_modules'
$stageRootFull = [IO.Path]::GetFullPath($stageRoot)
$baseFull = [IO.Path]::GetFullPath($basePath).TrimEnd([IO.Path]::DirectorySeparatorChar)
if (-not $stageRootFull.StartsWith("$baseFull$([IO.Path]::DirectorySeparatorChar)", [StringComparison]::OrdinalIgnoreCase) -or
    -not (Split-Path -Leaf $stageRootFull).StartsWith('PhotoMapMake-', [StringComparison]::Ordinal)) {
  throw 'Refusing to use an unexpected Squirrel staging path.'
}

$junctionCreated = $false
try {
  Copy-ProductBuildInputs -InputFiles $buildInputFiles -DestinationRoot $stageApp
  $stagedIdentity = Get-ProductBuildInputIdentity -AppRoot $stageApp
  if ($stagedIdentity.sha256 -cne $buildInputIdentity.sha256) {
    throw 'Staged build inputs differ from the source fingerprint. Re-run after source changes finish.'
  }
  $null = New-Item -ItemType Junction -Path $stageNodeModules -Target $nodeModules
  $junctionCreated = $true

  Push-Location -LiteralPath $stageApp
  try {
    & npm run package:forge
    $packageExitCode = $LASTEXITCODE
    if ($packageExitCode -ne 0) {
      throw "Electron Forge package failed with exit code $packageExitCode."
    }
    & npm run package:verify
    if ($LASTEXITCODE -ne 0) { throw 'Packaged resources or full licenses did not pass verification.' }
    & npm run make:squirrel -- --stage-base $stageRootFull
    $makeExitCode = $LASTEXITCODE
    if ($makeExitCode -ne 0) {
      throw "Electron Forge make failed with exit code $makeExitCode."
    }
    & npm run package:portable
    $portableExitCode = $LASTEXITCODE
    if ($portableExitCode -ne 0) {
      throw "Portable package creation failed with exit code $portableExitCode."
    }
  } finally {
    Pop-Location
  }

  $stageMake = (Resolve-Path -LiteralPath (Join-Path $stageApp 'out\make')).Path
  $stageRawPackage = Join-Path $stageApp 'out\PhotoMap-win32-x64'
  if (Test-Path -LiteralPath $stageRawPackage) {
    throw 'Portable packaging left the raw Forge directory in the staging output.'
  }
  $stagePackage = (Resolve-Path -LiteralPath (Join-Path $stageApp 'out\PhotoMap-portable-win32-x64')).Path
  if (Test-Path -LiteralPath (Join-Path $stagePackage 'PhotoMapData')) {
    throw 'Portable packaging unexpectedly included a PhotoMapData user-data root.'
  }
  $setup = Get-ChildItem -LiteralPath $stageMake -Recurse -File -Filter 'PhotoMap-Setup.exe' | Select-Object -First 1
  $packagedExe = Get-Item -LiteralPath (Join-Path $stagePackage 'PhotoMap.exe')
  $portableMarker = Get-Item -LiteralPath (Join-Path $stagePackage 'photomap.portable')
  if ($null -eq $setup -or $setup.Length -le 0) {
    throw 'Squirrel completed without a non-empty PhotoMap-Setup.exe.'
  }
  if ($packagedExe.Length -le 0) {
    throw 'Portable packaging completed without a non-empty PhotoMap.exe.'
  }
  if ($portableMarker.PSIsContainer -or
      $portableMarker.Length -le 0 -or
      ($portableMarker.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'Portable packaging completed without an ordinary non-empty photomap.portable marker.'
  }

  $outRoot = Join-Path $appRoot 'out'
  $destination = [IO.Path]::GetFullPath((Join-Path $outRoot 'make'))
  $packageDestination = [IO.Path]::GetFullPath((Join-Path $outRoot 'PhotoMap-portable-win32-x64'))
  $rawPackageDestination = [IO.Path]::GetFullPath((Join-Path $outRoot 'PhotoMap-win32-x64'))
  $outRootFull = [IO.Path]::GetFullPath($outRoot).TrimEnd([IO.Path]::DirectorySeparatorChar)
  if (-not $destination.StartsWith("$outRootFull$([IO.Path]::DirectorySeparatorChar)", [StringComparison]::OrdinalIgnoreCase) -or
      -not $packageDestination.StartsWith("$outRootFull$([IO.Path]::DirectorySeparatorChar)", [StringComparison]::OrdinalIgnoreCase) -or
      -not $rawPackageDestination.StartsWith("$outRootFull$([IO.Path]::DirectorySeparatorChar)", [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Refusing to replace an unexpected generated output path.'
  }
  $null = New-Item -ItemType Directory -Path $outRoot -Force
  if (Test-Path -LiteralPath $packageDestination) {
    $existingPortablePackage = Get-Item -LiteralPath $packageDestination -Force
    if (-not $existingPortablePackage.PSIsContainer -or
        ($existingPortablePackage.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw 'Refusing to replace an existing portable output that is not an ordinary directory.'
    }
    if (Test-Path -LiteralPath (Join-Path $packageDestination 'PhotoMapData')) {
      throw 'Refusing to replace the existing portable package because it contains PhotoMapData.'
    }
  }
  if (Test-Path -LiteralPath $rawPackageDestination) {
    $existingRawPackage = Get-Item -LiteralPath $rawPackageDestination -Force
    if (-not $existingRawPackage.PSIsContainer -or
        ($existingRawPackage.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw 'Refusing to remove a stale raw output that is not an ordinary directory.'
    }
    if (Test-Path -LiteralPath (Join-Path $rawPackageDestination 'PhotoMapData')) {
      throw 'Refusing to remove the stale raw package because it contains PhotoMapData.'
    }
  }
  if (Test-Path -LiteralPath $destination) {
    Remove-Item -LiteralPath $destination -Recurse -Force
  }
  if (Test-Path -LiteralPath $packageDestination) {
    Remove-Item -LiteralPath $packageDestination -Recurse -Force
  }
  if (Test-Path -LiteralPath $rawPackageDestination) {
    Remove-Item -LiteralPath $rawPackageDestination -Recurse -Force
  }
  Copy-Item -LiteralPath $stageMake -Destination $outRoot -Recurse -Force
  Copy-Item -LiteralPath $stagePackage -Destination $outRoot -Recurse -Force

  $finalSetup = Get-ChildItem -LiteralPath $destination -Recurse -File -Filter 'PhotoMap-Setup.exe' | Select-Object -First 1
  $finalPackagedExe = Get-Item -LiteralPath (Join-Path $packageDestination 'PhotoMap.exe')
  $finalPortableMarker = Get-Item -LiteralPath (Join-Path $packageDestination 'photomap.portable')
  if ($null -eq $finalSetup -or $finalSetup.Length -ne $setup.Length) {
    throw 'The copied installer did not match the staged installer size.'
  }
  if ($finalPackagedExe.Length -ne $packagedExe.Length) {
    throw 'The copied portable application did not match the staged executable size.'
  }
  if ($finalPortableMarker.PSIsContainer -or
      $finalPortableMarker.Length -ne $portableMarker.Length -or
      $finalPortableMarker.Length -le 0 -or
      ($finalPortableMarker.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'The copied portable marker did not match the ordinary staged marker.'
  }
  if (Test-Path -LiteralPath $rawPackageDestination) {
    throw 'The final output unexpectedly contains the raw Forge directory.'
  }
  if (Test-Path -LiteralPath (Join-Path $packageDestination 'PhotoMapData')) {
    throw 'The final portable output unexpectedly contains a PhotoMapData user-data root.'
  }
  $finalHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $finalSetup.FullName).Hash
  $packagedHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $finalPackagedExe.FullName).Hash
  $finalNupkg = Get-Item -LiteralPath (Join-Path $destination "squirrel.windows\x64\PhotoMap-$($package.version)-full.nupkg")
  $finalReleases = Get-Item -LiteralPath (Join-Path $destination 'squirrel.windows\x64\RELEASES')
  $finalAsar = Get-Item -LiteralPath (Join-Path $packageDestination 'resources\app.asar')
  $releaseBuildMetadata = [ordered]@{
    schemaVersion = 1
    applicationVersion = $package.version
    builtAtUtc = [DateTime]::UtcNow.ToString('o')
    sourceIdentity = $buildInputIdentity
    packageLockSha256 = (Get-FileHash -LiteralPath (Join-Path $appRoot 'package-lock.json') -Algorithm SHA256).Hash
    toolchain = [ordered]@{
      node = (& node --version).Trim()
      npm = (& npm --version).Trim()
      powershell = $PSVersionTable.PSVersion.ToString()
    }
    artifacts = [ordered]@{
      installer = [ordered]@{ path = 'out/make/squirrel.windows/x64/PhotoMap-Setup.exe'; sha256 = $finalHash; bytes = $finalSetup.Length }
      installerPackage = [ordered]@{ path = "out/make/squirrel.windows/x64/$($finalNupkg.Name)"; sha256 = (Get-FileHash -LiteralPath $finalNupkg.FullName -Algorithm SHA256).Hash; bytes = $finalNupkg.Length }
      installerIndex = [ordered]@{ path = 'out/make/squirrel.windows/x64/RELEASES'; sha256 = (Get-FileHash -LiteralPath $finalReleases.FullName -Algorithm SHA256).Hash; bytes = $finalReleases.Length }
      portableExecutable = [ordered]@{ path = 'out/PhotoMap-portable-win32-x64/PhotoMap.exe'; sha256 = $packagedHash; bytes = $finalPackagedExe.Length }
      portableMarker = [ordered]@{ path = 'out/PhotoMap-portable-win32-x64/photomap.portable'; sha256 = (Get-FileHash -LiteralPath $finalPortableMarker.FullName -Algorithm SHA256).Hash; bytes = $finalPortableMarker.Length }
      applicationPayload = [ordered]@{ path = 'out/PhotoMap-portable-win32-x64/resources/app.asar'; sha256 = (Get-FileHash -LiteralPath $finalAsar.FullName -Algorithm SHA256).Hash; bytes = $finalAsar.Length }
    }
  }
  $releaseBuildMetadata | ConvertTo-Json -Depth 10 | Out-File -LiteralPath (Join-Path $outRoot 'release-build.json') -Encoding utf8
  Write-Host "Installer: $($finalSetup.FullName)"
  Write-Host "SHA256: $finalHash"
  Write-Host "Portable app: $packageDestination"
  Write-Host "Portable executable SHA256: $packagedHash"
} finally {
  if ($junctionCreated -and (Test-Path -LiteralPath $stageNodeModules)) {
    $junction = Get-Item -LiteralPath $stageNodeModules -Force
    if (($junction.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) {
      throw 'Refusing to clean a staging node_modules path that is not a junction.'
    }
    Remove-Item -LiteralPath $stageNodeModules -Force
  }
  if (Test-Path -LiteralPath $stageRootFull) {
    Remove-Item -LiteralPath $stageRootFull -Recurse -Force
  }
}
