[CmdletBinding()]
param(
  [Parameter(Mandatory)] [string]$FastGateResultRoot,
  [Parameter(Mandatory)] [string]$E2EResultRoot,
  [Parameter(Mandatory)] [string]$ExpectedVersion,
  [string]$ReleaseNotesPath = '',
  [string]$ReleaseAcceptancePath = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'release-acceptance.ps1')
. (Join-Path $PSScriptRoot 'release-verification.ps1')
. (Join-Path $PSScriptRoot 'artifact-content.ps1')
. (Join-Path $PSScriptRoot 'filesystem.ps1')
if ($PSVersionTable.PSVersion -lt [version]'7.2') {
  throw 'assemble-release.ps1 requires PowerShell 7.2 or newer.'
}

function New-Artifact([string]$Kind, [string]$Root, [string]$Path) {
  $item = Assert-OrdinaryNonEmptyFile $Path $Kind
  [ordered]@{
    kind = $Kind
    path = [IO.Path]::GetRelativePath($Root, $item.FullName).Replace('\', '/')
    bytes = [int64]$item.Length
    sha256 = Get-Sha256 $item.FullName
  }
}

function Get-ZipEntrySha256([IO.Compression.ZipArchiveEntry]$Entry) {
  $stream = $Entry.Open()
  try {
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try {
      $digest = $algorithm.ComputeHash($stream)
      ([BitConverter]::ToString($digest)).Replace('-', '')
    } finally {
      $algorithm.Dispose()
    }
  } finally {
    $stream.Dispose()
  }
}

function Assert-BuildArtifact([object]$Metadata, [string]$ExpectedRelativePath, [string]$ActualPath, [string]$Label) {
  $item = Assert-OrdinaryNonEmptyFile $ActualPath $Label
  if (([string]$Metadata.path).Replace('\', '/') -ne $ExpectedRelativePath -or
      [int64]$Metadata.bytes -ne [int64]$item.Length -or
      ([string]$Metadata.sha256).ToUpperInvariant() -ne (Get-Sha256 $item.FullName)) {
    throw "$Label does not match out/release-build.json."
  }
}

$appRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
$releaseRoot = Join-Path $appRoot 'releases'
$testResultRoot = Join-Path $appRoot 'test-results'
$fastRoot = (Resolve-Path -LiteralPath $FastGateResultRoot).Path
$e2eRoot = (Resolve-Path -LiteralPath $E2EResultRoot).Path
$null = Assert-ChildPath $testResultRoot $fastRoot 'Fast-gate result root'
$null = Assert-ChildPath $testResultRoot $e2eRoot 'E2E result root'

$package = Get-Content -LiteralPath (Join-Path $appRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($package.version -ne $ExpectedVersion) {
  throw "Expected package version $ExpectedVersion, received $($package.version)."
}
if ($ExpectedVersion -notmatch '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$') {
  throw "ExpectedVersion must be a stable semantic version such as 1.2.3; received $ExpectedVersion."
}
$releaseTag = "v$ExpectedVersion"
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
. (Join-Path $PSScriptRoot '../source-identity.ps1')
$sourceIdentity = Get-ProductBuildInputIdentity -AppRoot $appRoot
$packageLockSha256 = Get-Sha256 (Join-Path $appRoot 'package-lock.json')

$installerSource = Join-Path $appRoot 'out\make\squirrel.windows\x64'
$portableSource = Join-Path $appRoot 'out\PhotoMap-portable-win32-x64'
$rawForgeSource = Join-Path $appRoot 'out\PhotoMap-win32-x64'
$setupSource = Join-Path $installerSource 'PhotoMap-Setup.exe'
$nupkgSource = Join-Path $installerSource "PhotoMap-$ExpectedVersion-full.nupkg"
$releasesSource = Join-Path $installerSource 'RELEASES'
$portableExeSource = Join-Path $portableSource 'PhotoMap.exe'
$portableMarkerSource = Join-Path $portableSource 'photomap.portable'
$portableAsarSource = Join-Path $portableSource 'resources\app.asar'
foreach ($required in @($setupSource, $nupkgSource, $releasesSource, $portableExeSource, $portableMarkerSource, $portableAsarSource)) {
  $null = Assert-OrdinaryNonEmptyFile $required 'Required release file'
}
if (Test-Path -LiteralPath $rawForgeSource) { throw 'Raw Forge package must be absent before publishing.' }
if (Test-Path -LiteralPath (Join-Path $portableSource 'PhotoMapData')) { throw 'Portable source contains PhotoMapData.' }
if (Test-Path -LiteralPath (Join-Path $portableSource 'debug.log')) { throw 'Portable source contains debug.log.' }
Assert-ArtifactDirectoryClean $portableSource 'Portable source'
Assert-ArtifactArchiveClean $nupkgSource 'Installer package'

$buildMetadataPath = Join-Path $appRoot 'out\release-build.json'
$buildMetadata = Get-Content -LiteralPath $buildMetadataPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($buildMetadata.schemaVersion -ne 1 -or $buildMetadata.applicationVersion -ne $ExpectedVersion) {
  throw 'Build metadata version does not match the requested release.'
}
if ($buildMetadata.sourceIdentity.sha256 -ne $sourceIdentity.sha256 -or
    $buildMetadata.sourceIdentity.fileCount -ne $sourceIdentity.fileCount -or
    $buildMetadata.packageLockSha256 -ne $packageLockSha256) {
  throw 'Current product build inputs do not match out/release-build.json.'
}
if ($buildMetadata.toolchain.node -ne "v$requiredNodeVersion" -or $buildMetadata.toolchain.npm -ne $requiredNpmVersion) {
  throw 'Build metadata was created with an unexpected Node.js or npm version.'
}
$buildArtifacts = $buildMetadata.artifacts
Assert-BuildArtifact $buildArtifacts.installer 'out/make/squirrel.windows/x64/PhotoMap-Setup.exe' $setupSource 'Installer'
Assert-BuildArtifact $buildArtifacts.installerPackage "out/make/squirrel.windows/x64/PhotoMap-$ExpectedVersion-full.nupkg" $nupkgSource 'Installer package'
Assert-BuildArtifact $buildArtifacts.installerIndex 'out/make/squirrel.windows/x64/RELEASES' $releasesSource 'Installer index'
Assert-BuildArtifact $buildArtifacts.portableExecutable 'out/PhotoMap-portable-win32-x64/PhotoMap.exe' $portableExeSource 'Portable executable'
Assert-BuildArtifact $buildArtifacts.portableMarker 'out/PhotoMap-portable-win32-x64/photomap.portable' $portableMarkerSource 'Portable marker'
Assert-BuildArtifact $buildArtifacts.applicationPayload 'out/PhotoMap-portable-win32-x64/resources/app.asar' $portableAsarSource 'Application payload'

$portableVersion = (Get-Item -LiteralPath $portableExeSource).VersionInfo
$setupVersion = (Get-Item -LiteralPath $setupSource).VersionInfo
if ($portableVersion.ProductVersion -ne $ExpectedVersion -or $portableVersion.FileVersion -ne $ExpectedVersion) {
  throw 'Portable executable version does not match the release version.'
}
if ($setupVersion.ProductVersion -ne $ExpectedVersion -or $setupVersion.FileVersion -ne $ExpectedVersion) {
  throw 'Installer executable version does not match the release version.'
}

$fastSummary = Get-Content -LiteralPath (Join-Path $fastRoot 'summary.json') -Raw -Encoding UTF8 | ConvertFrom-Json
Assert-ReleaseFastGate -Summary $fastSummary -ResultRoot $fastRoot -SourceIdentity $sourceIdentity `
  -RequiredNodeVersion $requiredNodeVersion -RequiredNpmVersion $requiredNpmVersion
$e2eResult = Get-Content -LiteralPath (Join-Path $e2eRoot 'result.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$expectedE2ERootName = "packaged-e2e-$($e2eResult.runId)"
if ($e2eResult.schemaVersion -ne 1 -or $e2eResult.passed -ne $true -or
    $e2eResult.suite -ne 'full-map' -or
    (Split-Path -Leaf $e2eRoot) -ne $expectedE2ERootName -or
    $e2eResult.environment.node -ne "v$requiredNodeVersion" -or
    ([string]$e2eResult.checks.portableContract.sourceArtifact).Replace('\', '/') -ne 'out/PhotoMap-portable-win32-x64' -or
    $e2eResult.checks.portableContract.stagedFromRawForgePackage -ne $false -or
    $e2eResult.checks.portableContract.hashes.portableExecutableSha256 -ne (Get-Sha256 $portableExeSource) -or
    $e2eResult.checks.portableContract.hashes.portableMarkerSha256 -ne (Get-Sha256 $portableMarkerSource) -or
    $e2eResult.checks.portableContract.hashes.applicationPayloadSha256 -ne (Get-Sha256 $portableAsarSource)) {
  throw 'Packaged E2E is not a passing result for the current portable payload.'
}

$buildId = "$([DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ'))-$($sourceIdentity.sha256.Substring(0, 8))"
if ($buildId -notmatch '^\d{8}T\d{6}Z-[A-F0-9]{8}$') { throw "Unexpected build id: $buildId" }
$null = New-Item -ItemType Directory -Path $releaseRoot -Force
$releaseDirectory = Assert-ChildPath $releaseRoot (Join-Path $releaseRoot $releaseTag) 'Release destination'
if (Test-Path -LiteralPath $releaseDirectory) { throw "Release destination already exists: $releaseDirectory" }
$stagingPrefix = "${releaseTag}.staging-${buildId}-"
$stagingName = "$stagingPrefix$([guid]::NewGuid().ToString('N'))"
$stagingDirectory = Assert-ChildPath $releaseRoot (Join-Path $releaseRoot $stagingName) 'Release staging destination'
$published = $false

try {
  $installerDestination = Join-Path $stagingDirectory 'installer'
  $portableParent = Join-Path $stagingDirectory 'portable'
  $portableDestination = Join-Path $portableParent 'PhotoMap-portable-win32-x64'
  $verificationDestination = Join-Path $stagingDirectory 'verification'
  $null = New-Item -ItemType Directory -Path $installerDestination, $portableParent, $verificationDestination -Force
  Copy-Item -LiteralPath $setupSource, $nupkgSource, $releasesSource -Destination $installerDestination -Force
  Copy-Item -LiteralPath $portableSource -Destination $portableParent -Recurse -Force
  if (Test-Path -LiteralPath (Join-Path $portableDestination 'PhotoMapData')) { throw 'Published portable directory contains PhotoMapData.' }
  if (Test-Path -LiteralPath (Join-Path $portableDestination 'debug.log')) { throw 'Published portable directory contains debug.log.' }
  Assert-ArtifactDirectoryClean $portableDestination 'Published portable directory'

  $zipPath = Join-Path $stagingDirectory 'PhotoMap-portable-win32-x64.zip'
  [IO.Compression.ZipFile]::CreateFromDirectory($portableParent, $zipPath, [IO.Compression.CompressionLevel]::Optimal, $false)
  Assert-ArtifactArchiveClean $zipPath 'Portable ZIP'
  $expectedZipFiles = [Collections.Generic.Dictionary[string, object]]::new([StringComparer]::Ordinal)
  foreach ($file in @(Get-ChildItem -LiteralPath $portableDestination -Recurse -File -Force)) {
    if (($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Portable source contains a reparse point: $($file.FullName)" }
    $key = "PhotoMap-portable-win32-x64/$([IO.Path]::GetRelativePath($portableDestination, $file.FullName).Replace('\', '/'))"
    $expectedZipFiles.Add($key, [pscustomobject]@{ bytes = [int64]$file.Length; sha256 = Get-Sha256 $file.FullName })
  }
  $seenZipFiles = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
  $zip = [IO.Compression.ZipFile]::OpenRead($zipPath)
  try {
    foreach ($entry in @($zip.Entries)) {
      $entryPath = $entry.FullName.Replace('\', '/')
      if ($entry.Name.Length -eq 0) { continue }
      if (-not $seenZipFiles.Add($entryPath)) { throw "Portable ZIP contains a duplicate entry: $entryPath" }
      if (-not $expectedZipFiles.ContainsKey($entryPath)) { throw "Portable ZIP contains an unexpected entry: $entryPath" }
      $expected = $expectedZipFiles[$entryPath]
      if ([int64]$entry.Length -ne $expected.bytes -or (Get-ZipEntrySha256 $entry) -ne $expected.sha256) {
        throw "Portable ZIP entry differs from its source: $entryPath"
      }
    }
  } finally {
    $zip.Dispose()
  }
  if ($seenZipFiles.Count -ne $expectedZipFiles.Count) { throw 'Portable ZIP is missing one or more source files.' }
  if (@($seenZipFiles | Where-Object { ($_ -split '/') -contains 'PhotoMapData' }).Count -gt 0) { throw 'Portable ZIP contains PhotoMapData.' }
  if (@($seenZipFiles | Where-Object { [IO.Path]::GetFileName($_) -eq 'debug.log' }).Count -gt 0) { throw 'Portable ZIP contains debug.log.' }

  $publishedNupkg = Join-Path $installerDestination "PhotoMap-$ExpectedVersion-full.nupkg"
  $portableAsar = Join-Path $portableDestination 'resources\app.asar'
  $nupkgEntryNames = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
  $nupkgAsarSha256 = $null
  $nupkg = [IO.Compression.ZipFile]::OpenRead($publishedNupkg)
  try {
    foreach ($entry in @($nupkg.Entries)) {
      if ($entry.Name.Length -eq 0) { continue }
      $entryPath = $entry.FullName.Replace('\', '/')
      if (-not $nupkgEntryNames.Add($entryPath)) { throw "Installer package contains a duplicate entry: $entryPath" }
      $entrySha256 = Get-ZipEntrySha256 $entry
      if ($entryPath -eq 'lib/net45/resources/app.asar') { $nupkgAsarSha256 = $entrySha256 }
    }
  } finally {
    $nupkg.Dispose()
  }
  if ($null -eq $nupkgAsarSha256) { throw 'Installer package is missing resources/app.asar.' }
  if (@($nupkgEntryNames | Where-Object { ($_ -split '/') -contains 'PhotoMapData' }).Count -gt 0) { throw 'Installer package contains PhotoMapData.' }
  if (@($nupkgEntryNames | Where-Object { [IO.Path]::GetFileName($_) -eq 'photomap.portable' }).Count -gt 0) { throw 'Installer package contains the portable marker.' }
  $portableAsarSha256 = Get-Sha256 $portableAsar
  if ($nupkgAsarSha256 -ne $portableAsarSha256) { throw 'Installer and portable app.asar payloads differ.' }

  $releaseLine = (Get-Content -LiteralPath (Join-Path $installerDestination 'RELEASES') -Raw -Encoding UTF8).Trim()
  $releaseMatch = [regex]::Match($releaseLine, '^([A-Fa-f0-9]{40})\s+(\S+)\s+(\d+)$')
  $nupkgItem = Get-Item -LiteralPath $publishedNupkg
  if (-not $releaseMatch.Success -or $releaseMatch.Groups[2].Value -ne $nupkgItem.Name -or [int64]$releaseMatch.Groups[3].Value -ne $nupkgItem.Length) {
    throw 'Squirrel RELEASES metadata does not match the package name and size.'
  }
  $nupkgSha1 = (Get-FileHash -LiteralPath $publishedNupkg -Algorithm SHA1).Hash
  if ($releaseMatch.Groups[1].Value -ne $nupkgSha1) { throw 'Squirrel RELEASES SHA-1 does not match the package.' }

  Copy-Item -LiteralPath (Join-Path $fastRoot 'summary.json') -Destination (Join-Path $verificationDestination 'fast-gate-summary.json') -Force
  Copy-Item -LiteralPath (Join-Path $fastRoot 'logs') -Destination (Join-Path $verificationDestination 'fast-gate-logs') -Recurse -Force
  Copy-Item -LiteralPath (Join-Path $e2eRoot 'result.json') -Destination (Join-Path $verificationDestination 'e2e-result.json') -Force
  Copy-Item -LiteralPath $buildMetadataPath -Destination (Join-Path $verificationDestination 'build-metadata.json') -Force

  $e2eLogs = @(Get-ChildItem -LiteralPath $e2eRoot -File -Filter '*.log')
  if ($e2eLogs.Count -gt 0) {
    $e2eLogDestination = Join-Path $verificationDestination 'e2e-logs'
    $null = New-Item -ItemType Directory -Path $e2eLogDestination -Force
    Copy-Item -LiteralPath $e2eLogs.FullName -Destination $e2eLogDestination -Force
  }
  $e2eScreenshots = @(Get-ChildItem -LiteralPath $e2eRoot -File -Filter '*.png')
  if ($e2eScreenshots.Count -gt 0) {
    $screenshotDestination = Join-Path $verificationDestination 'e2e-screenshots'
    $null = New-Item -ItemType Directory -Path $screenshotDestination -Force
    Copy-Item -LiteralPath $e2eScreenshots.FullName -Destination $screenshotDestination -Force
  }

  $runtimeEvidenceRelative = [string]$e2eResult.checks.runtimeEvidence.directory
  if ([IO.Path]::IsPathRooted($runtimeEvidenceRelative)) { throw 'E2E runtime-evidence path must be relative.' }
  $runtimeEvidenceSource = Assert-ChildPath $e2eRoot (Join-Path $e2eRoot $runtimeEvidenceRelative) 'E2E runtime evidence'
  $runtimeEvidenceFiles = @(Get-ChildItem -LiteralPath $runtimeEvidenceSource -File -Force)
  $expectedEvidenceNames = @('diagnostics.jsonl', 'index.sqlite3', 'photomap.portable', 'portable-layout.json', 'settings.json')
  $actualEvidenceNames = @($runtimeEvidenceFiles.Name | Sort-Object -CaseSensitive)
  if (@(Compare-Object $expectedEvidenceNames $actualEvidenceNames).Count -ne 0) { throw 'E2E runtime evidence does not contain the expected file set.' }
  foreach ($file in $runtimeEvidenceFiles) { $null = Assert-OrdinaryNonEmptyFile $file.FullName 'E2E runtime evidence' }
  $runtimeEvidenceDestination = Join-Path $verificationDestination 'runtime-evidence'
  Copy-Item -LiteralPath $runtimeEvidenceSource -Destination $runtimeEvidenceDestination -Recurse -Force
  foreach ($file in $runtimeEvidenceFiles) {
    $copy = Join-Path $runtimeEvidenceDestination $file.Name
    if ((Get-Sha256 $file.FullName) -ne (Get-Sha256 $copy)) { throw "Copied runtime evidence differs: $($file.Name)" }
  }

  $payloadVerification = [ordered]@{
    schemaVersion = 1
    applicationVersion = $ExpectedVersion
    portableExecutable = [ordered]@{ fileVersion = $portableVersion.FileVersion; productVersion = $portableVersion.ProductVersion; zipEntry = 'PhotoMap-portable-win32-x64/PhotoMap.exe'; sha256 = Get-Sha256 $portableExeSource }
    installerExecutable = [ordered]@{ fileVersion = $setupVersion.FileVersion; productVersion = $setupVersion.ProductVersion }
    installerPackage = [ordered]@{ name = $nupkgItem.Name; releasesSha1Matches = $true; archiveIntegrityPassed = $true; portableMarkerAbsent = $true; photoMapDataAbsent = $true }
    payload = [ordered]@{ portableZipEntry = 'PhotoMap-portable-win32-x64/resources/app.asar'; portableAsarSha256 = $portableAsarSha256; installerAsarSha256 = $nupkgAsarSha256; matches = $true }
    portable = [ordered]@{ markerZipEntry = 'PhotoMap-portable-win32-x64/photomap.portable'; directoryPhotoMapDataAbsent = $true; directoryDebugLogAbsent = $true; zipAllEntriesReadableAndMatched = $true; zipSingleRoot = $true; zipPhotoMapDataAbsent = $true; zipDebugLogAbsent = $true }
  }
  $payloadVerificationPath = Join-Path $verificationDestination 'payload-verification.json'
  $payloadVerification | ConvertTo-Json -Depth 8 | Out-File -LiteralPath $payloadVerificationPath -Encoding utf8

  $acceptancePath = Join-Path $verificationDestination 'release-acceptance.json'
  $acceptance = Get-ReleaseAcceptance -Path $ReleaseAcceptancePath -Version $ExpectedVersion `
    -InstallerSha256 (Get-Sha256 (Join-Path $installerDestination 'PhotoMap-Setup.exe')) `
    -ApplicationPayloadSha256 (Get-Sha256 $portableAsarSource)
  $acceptance | ConvertTo-Json -Depth 8 | Out-File -LiteralPath $acceptancePath -Encoding utf8

  $releaseNotesDestinationPath = Join-Path $stagingDirectory 'RELEASE-NOTES.md'
  if ($ReleaseNotesPath.Trim().Length -gt 0) {
    $customReleaseNotesPath = (Resolve-Path -LiteralPath $ReleaseNotesPath).Path
    $null = Assert-OrdinaryNonEmptyFile $customReleaseNotesPath 'Custom release notes'
    $customReleaseNotes = Get-Content -LiteralPath $customReleaseNotesPath -Raw -Encoding UTF8
    $firstLine = @($customReleaseNotes -split '\r?\n', 2)[0].Trim()
    if ($firstLine -ne "# PhotoMap $releaseTag") {
      throw "Custom release notes must begin with '# PhotoMap $releaseTag'."
    }
    [IO.File]::WriteAllText($releaseNotesDestinationPath, $customReleaseNotes, [Text.UTF8Encoding]::new($false))
  } else {
    @(
      "# PhotoMap $releaseTag"
      ''
      "候选版本；发布验收状态：$($acceptance.status)。"
      ''
      '## 发布说明'
      ''
      '- GitHub Release 发布流程会根据当前版本标签与上一个可达的语义版本标签附加 `git log`。'
      '- 只有已经提交到 Git 的代码变化才会出现在版本记录中。'
      ''
      '## 制品与验证'
      ''
      '- Windows x64 安装包：`installer/PhotoMap-Setup.exe`'
      '- Windows x64 便携版：`PhotoMap-portable-win32-x64.zip`'
      '- 校验和：`CHECKSUMS.sha256`'
      '- 自动验证证据：`verification/`'
      ''
      '签名状态以 release-manifest.json 为准；人工验收见 verification/release-acceptance.json。'
    ) | Out-File -LiteralPath $releaseNotesDestinationPath -Encoding utf8
  }

  $artifacts = @(
    New-Artifact 'installer' $stagingDirectory (Join-Path $installerDestination 'PhotoMap-Setup.exe')
    New-Artifact 'installer-package' $stagingDirectory $publishedNupkg
    New-Artifact 'installer-index' $stagingDirectory (Join-Path $installerDestination 'RELEASES')
    New-Artifact 'portable-archive' $stagingDirectory $zipPath
    New-Artifact 'release-notes' $stagingDirectory $releaseNotesDestinationPath
  )
  $verificationArtifacts = @(Get-ChildItem -LiteralPath $verificationDestination -Recurse -File -Force | Sort-Object FullName | ForEach-Object {
    New-Artifact 'verification-evidence' $stagingDirectory $_.FullName
  })
  $artifacts += $verificationArtifacts

  $gitHead = (& git -C $appRoot rev-parse HEAD).Trim()
  $installerSignature = (Get-AuthenticodeSignature -LiteralPath (Join-Path $installerDestination 'PhotoMap-Setup.exe')).Status.ToString()
  $portableSignature = (Get-AuthenticodeSignature -LiteralPath (Join-Path $portableDestination 'PhotoMap.exe')).Status.ToString()
  $manifest = [ordered]@{
    schemaVersion = 1
    buildId = $buildId
    releaseTag = $releaseTag
    application = [ordered]@{ name = 'PhotoMap'; productName = '用照片拼地图'; version = $ExpectedVersion; platform = 'win32'; arch = 'x64'; channel = $(if ($acceptance.status -eq 'accepted') { 'stable' } else { 'candidate' }) }
    assembledAtUtc = [DateTime]::UtcNow.ToString('o')
    sourceSnapshot = [ordered]@{
      gitHeadBeforeReleaseCommit = $gitHead
      identityRule = 'Current build inputs, build metadata, fast gate, and packaged E2E payload hashes must agree before publication.'
      productBuildInputs = $sourceIdentity
      packageLockSha256 = $packageLockSha256
    }
    toolchain = [ordered]@{ node = (& node --version).Trim(); npm = (& npm --version).Trim(); powershell = $PSVersionTable.PSVersion.ToString(); buildCommand = 'npm run make' }
    artifacts = $artifacts
    verification = [ordered]@{
      fastGate = [ordered]@{ passed = $true; stepsPassed = $fastSummary.passed; stepsFailed = $fastSummary.failed; runId = $fastSummary.runId; sourceIdentityMatches = $true }
      packagedE2E = [ordered]@{ passed = $true; runId = $e2eResult.runId; payloadHashesMatch = $true; scanStatus = $e2eResult.checks.scan.status; photosScanned = $e2eResult.checks.scan.count; scanErrors = $e2eResult.checks.scan.counts.errors; temporaryPackageRemoved = $e2eResult.checks.cleanup.temporaryPackageRemoved; localAppDataPhotoMapAbsent = $e2eResult.checks.localAppDataSentinel.photoMapAbsent }
      payloadEquivalence = [ordered]@{ installerArchiveIntegrityPassed = $true; releasesMetadataValid = $true; appAsarMatches = $true; portableZipIntegrityPassed = $true; portableZipSingleRootDirectory = $true; productPhotoMapDataAbsent = $true }
      authenticode = [ordered]@{ installer = $installerSignature; portableExecutable = $portableSignature }
      releaseOwnerAcceptance = [ordered]@{ status = $acceptance.status; evidence = 'verification/release-acceptance.json' }
      installerSmokeTest = $acceptance.installerSmokeTest
      offlineSmokeTest = $acceptance.offlineSmokeTest
    }
  }
  $manifestPath = Join-Path $stagingDirectory 'release-manifest.json'
  $manifest | ConvertTo-Json -Depth 14 | Out-File -LiteralPath $manifestPath -Encoding utf8

  $checksumTargets = @($artifacts | ForEach-Object { Join-Path $stagingDirectory ($_.path.Replace('/', '\')) }) + $manifestPath
  $checksumLines = foreach ($target in $checksumTargets) {
    "$(Get-Sha256 $target) *$([IO.Path]::GetRelativePath($stagingDirectory, $target).Replace('\', '/'))"
  }
  $checksumLines | Out-File -LiteralPath (Join-Path $stagingDirectory 'CHECKSUMS.sha256') -Encoding utf8

  Move-Item -LiteralPath $stagingDirectory -Destination $releaseDirectory
  $published = $true
  [pscustomobject]@{
    releaseDirectory = $releaseDirectory
    buildId = $buildId
    releaseTag = $releaseTag
    version = $ExpectedVersion
    sourceTreeSha256 = $sourceIdentity.sha256
    artifacts = $artifacts.Count
    photoMapDataAbsent = -not (Test-Path -LiteralPath (Join-Path $releaseDirectory 'portable\PhotoMap-portable-win32-x64\PhotoMapData'))
    payloadMatches = $true
  } | ConvertTo-Json -Depth 5
} finally {
  if (-not $published -and (Test-Path -LiteralPath $stagingDirectory)) {
    $stagingItem = Get-Item -LiteralPath $stagingDirectory -Force
    if (-not $stagingItem.PSIsContainer -or
        ($stagingItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
        -not $stagingItem.Name.StartsWith($stagingPrefix, [StringComparison]::Ordinal)) {
      throw 'Refusing to clean an unexpected release staging path.'
    }
    Remove-Item -LiteralPath $stagingDirectory -Recurse -Force
  }
}
