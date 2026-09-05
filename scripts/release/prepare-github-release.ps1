[CmdletBinding()]
param(
  [Parameter(Mandatory)] [string]$TagName,
  [Parameter(Mandatory)] [string]$OutputRoot
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'artifact-content.ps1')
. (Join-Path $PSScriptRoot 'filesystem.ps1')
if ($PSVersionTable.PSVersion -lt [version]'7.2') {
  throw 'prepare-github-release.ps1 requires PowerShell 7.2 or newer.'
}

function Assert-OrdinaryDirectory([string]$Path, [string]$Label) {
  $item = Get-Item -LiteralPath $Path -Force
  if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "$Label must be an ordinary directory: $Path"
  }
  $item
}

function Invoke-GitLines([string[]]$Arguments) {
  $output = @(& git -C $script:RepositoryRoot @Arguments 2>&1)
  $exitCode = $LASTEXITCODE
  if ($exitCode -ne 0) {
    $detail = ($output | ForEach-Object { [string]$_ }) -join "`n"
    throw "git $($Arguments -join ' ') failed with exit code ${exitCode}: $detail"
  }
  @($output | ForEach-Object { [string]$_ })
}

function Get-GitFileText([string]$RefName, [string]$RelativePath) {
  $objectName = '{0}:{1}' -f $RefName, $RelativePath
  (Invoke-GitLines @('show', $objectName)) -join "`n"
}

function Assert-ManifestArtifact([object]$Manifest, [string]$ReleaseDirectory, [string]$RelativePath, [string]$Label) {
  $records = @($Manifest.artifacts | Where-Object { ([string]$_.path).Replace('\', '/') -eq $RelativePath })
  if ($records.Count -ne 1) {
    throw "Manifest must contain exactly one $Label artifact at $RelativePath."
  }
  $path = Assert-ChildPath $ReleaseDirectory (Join-Path $ReleaseDirectory $RelativePath.Replace('/', [IO.Path]::DirectorySeparatorChar)) $Label
  $item = Assert-OrdinaryNonEmptyFile $path $Label
  if ([int64]$records[0].bytes -ne [int64]$item.Length -or
      ([string]$records[0].sha256).ToUpperInvariant() -ne (Get-Sha256 $item.FullName)) {
    throw "$Label does not match release-manifest.json."
  }
  $item
}

$tagMatch = [regex]::Match($TagName, '^v(?<version>(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*))$')
if (-not $tagMatch.Success) {
  throw "TagName must be a stable semantic version tag such as v1.2.3; received $TagName."
}
$version = $tagMatch.Groups['version'].Value
$currentVersion = [version]$version

$appRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
$repositoryResult = @(& git -C $appRoot rev-parse --show-toplevel 2>&1)
if ($LASTEXITCODE -ne 0 -or $repositoryResult.Count -ne 1) {
  throw "Unable to resolve the Git repository root: $($repositoryResult -join "`n")"
}
$script:RepositoryRoot = [IO.Path]::GetFullPath(([string]$repositoryResult[0]).Trim())

$tagRef = "refs/tags/$TagName"
$tagCommitLines = @(Invoke-GitLines @('rev-parse', '--verify', "${tagRef}^{commit}"))
if ($tagCommitLines.Count -ne 1 -or $tagCommitLines[0] -notmatch '^[a-f0-9]{40,64}$') {
  throw "Tag $TagName did not resolve to exactly one commit."
}
$tagCommit = $tagCommitLines[0]

# These are the Git blob object IDs of the two validated TianDiTu GeoJSON
# payloads in this SHA-1 repository. Checking object IDs catches the same
# bytes even when a file is renamed before a public tag is created.
$forbiddenMapBlobIds = @{
  '5d3aacc1f6ebc929303f4abcc015225b22e68399' = '省份地图 GeoJSON'
  '985f4d8e736850db3ed046eb2d4e38fa9e32885f' = '城市地图 GeoJSON'
}
$tagTreeLines = @(Invoke-GitLines @('-c', 'core.quotePath=false', 'ls-tree', '-r', '--full-tree', $tagCommit))
foreach ($line in $tagTreeLines) {
  $treeMatch = [regex]::Match($line, '^[0-7]{6} blob (?<object>[a-f0-9]+)\t(?<path>.+)$')
  if (-not $treeMatch.Success) { continue }
  $objectId = $treeMatch.Groups['object'].Value
  $entryPath = $treeMatch.Groups['path'].Value
  if (Test-ForbiddenArtifactPath -Path $entryPath -Source) {
    throw "Tag $TagName contains a local, backup or private input at $entryPath. Create the public tag from a sanitized tree."
  }
  if ($forbiddenMapBlobIds.ContainsKey($objectId)) {
    throw "Tag $TagName contains $($forbiddenMapBlobIds[$objectId]) at $($treeMatch.Groups['path'].Value). Create the public tag from a sanitized tree."
  }
}

$packageRelativePath = [IO.Path]::GetRelativePath($script:RepositoryRoot, (Join-Path $appRoot 'package.json')).Replace('\', '/')
$lockRelativePath = [IO.Path]::GetRelativePath($script:RepositoryRoot, (Join-Path $appRoot 'package-lock.json')).Replace('\', '/')
$tagPackage = Get-GitFileText $TagName $packageRelativePath | ConvertFrom-Json
$tagLock = Get-GitFileText $TagName $lockRelativePath | ConvertFrom-Json -AsHashtable
if ([string]$tagPackage.version -ne $version -or
    [string]$tagLock['version'] -ne $version -or
    [string]$tagLock['packages']['']['version'] -ne $version) {
  throw "Tag $TagName does not contain matching package.json and package-lock.json versions."
}

$releaseRoot = Join-Path $appRoot 'releases'
$releaseDirectory = Assert-ChildPath $releaseRoot (Join-Path $releaseRoot $TagName) 'Versioned release directory'
$releaseDirectoryItem = Assert-OrdinaryDirectory $releaseDirectory 'Versioned release directory'
if ($releaseDirectoryItem.Name -cne $TagName) {
  throw "Release directory name must exactly match tag $TagName."
}

$manifestPath = Join-Path $releaseDirectory 'release-manifest.json'
$manifestItem = Assert-OrdinaryNonEmptyFile $manifestPath 'Release manifest'
$manifest = Get-Content -LiteralPath $manifestItem.FullName -Raw -Encoding UTF8 | ConvertFrom-Json
if ([string]$manifest.application.version -ne $version) {
  throw "Release manifest version does not match tag $TagName."
}
if ($manifest.verification.releaseOwnerAcceptance.status -cne 'accepted' -or
    $manifest.verification.installerSmokeTest.status -cne 'passed' -or
    $manifest.verification.offlineSmokeTest.status -cne 'passed') {
  throw 'Public release requires explicit owner evidence for installer and offline smoke tests. Draft assembly is not release acceptance.'
}
$currentHead = @(Invoke-GitLines @('rev-parse', 'HEAD'))[0].Trim()
if ($currentHead -cne $tagCommit -or $manifest.sourceSnapshot.gitHeadBeforeReleaseCommit -cne $tagCommit) {
  throw 'Release payload, checked-out commit and public tag must identify the same source commit.'
}
$pendingSourceChanges = @(Invoke-GitLines @('status', '--porcelain', '--untracked-files=normal', '--', $appRoot))
if ($pendingSourceChanges.Count -gt 0) { throw 'Commit the release source before preparing public artifacts.' }
. (Join-Path $PSScriptRoot '../source-identity.ps1')
$currentSourceIdentity = Get-ProductBuildInputIdentity -AppRoot $appRoot
if ($currentSourceIdentity.sha256 -cne $manifest.sourceSnapshot.productBuildInputs.sha256) {
  throw 'The release source no longer matches the build input fingerprint.'
}
if ($manifest.PSObject.Properties.Name -contains 'releaseTag' -and [string]$manifest.releaseTag -cne $TagName) {
  throw "Release manifest tag does not match $TagName."
}

$releaseNotesPath = Join-Path $releaseDirectory 'RELEASE-NOTES.md'
$releaseNotesItem = Assert-OrdinaryNonEmptyFile $releaseNotesPath 'Release notes'
$releaseNotes = Get-Content -LiteralPath $releaseNotesItem.FullName -Raw -Encoding UTF8
$releaseNotesHeading = @($releaseNotes -split '\r?\n', 2)[0].Trim()
if ($releaseNotesHeading -cne "# PhotoMap $TagName") {
  throw "Release notes must begin with '# PhotoMap $TagName'."
}

$checksumPath = Join-Path $releaseDirectory 'CHECKSUMS.sha256'
$checksumItem = Assert-OrdinaryNonEmptyFile $checksumPath 'Release checksums'
$checksumEntries = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
foreach ($line in @(Get-Content -LiteralPath $checksumItem.FullName -Encoding UTF8)) {
  if ($line.Trim().Length -eq 0) { continue }
  $match = [regex]::Match($line, '^(?<sha>[A-Fa-f0-9]{64}) \*(?<path>.+)$')
  if (-not $match.Success) { throw "Invalid CHECKSUMS.sha256 line: $line" }
  $relativePath = $match.Groups['path'].Value.Replace('\', '/')
  if ([IO.Path]::IsPathRooted($relativePath) -or @($relativePath -split '/' | Where-Object { $_ -eq '..' }).Count -gt 0) {
    throw "Checksum path must stay inside the release directory: $relativePath"
  }
  if (-not $checksumEntries.Add($relativePath)) { throw "Duplicate checksum path: $relativePath" }
  $targetPath = Assert-ChildPath $releaseDirectory (Join-Path $releaseDirectory $relativePath.Replace('/', [IO.Path]::DirectorySeparatorChar)) 'Checksum target'
  $targetItem = Assert-OrdinaryNonEmptyFile $targetPath 'Checksum target'
  if ((Get-Sha256 $targetItem.FullName) -ne $match.Groups['sha'].Value.ToUpperInvariant()) {
    throw "SHA-256 mismatch for $relativePath. Git LFS content may not have been downloaded."
  }
}

$requiredChecksumPaths = @(
  'installer/PhotoMap-Setup.exe'
  "installer/PhotoMap-$version-full.nupkg"
  'PhotoMap-portable-win32-x64.zip'
  'RELEASE-NOTES.md'
  'release-manifest.json'
)
foreach ($relativePath in $requiredChecksumPaths) {
  if (-not $checksumEntries.Contains($relativePath)) {
    throw "CHECKSUMS.sha256 is missing $relativePath."
  }
}

$setupItem = Assert-ManifestArtifact $manifest $releaseDirectory 'installer/PhotoMap-Setup.exe' 'Installer'
$portableItem = Assert-ManifestArtifact $manifest $releaseDirectory 'PhotoMap-portable-win32-x64.zip' 'Portable archive'
$installerPackageItem = Assert-ManifestArtifact $manifest $releaseDirectory "installer/PhotoMap-$version-full.nupkg" 'Installer package'
Assert-ArtifactArchiveClean $portableItem.FullName 'Public portable archive'
Assert-ArtifactArchiveClean $installerPackageItem.FullName 'Public installer package'

$mergedTags = @(Invoke-GitLines @(
  'for-each-ref'
  "--merged=$tagCommit"
  '--sort=-version:refname'
  '--format=%(refname:short)'
  'refs/tags'
))
$previousCandidates = @(
  foreach ($candidateTag in $mergedTags) {
    $candidateMatch = [regex]::Match($candidateTag, '^v(?<version>(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*))$')
    if (-not $candidateMatch.Success -or $candidateTag -ceq $TagName) { continue }
    $candidateVersion = [version]$candidateMatch.Groups['version'].Value
    if ($candidateVersion -lt $currentVersion) {
      [pscustomobject]@{ tag = $candidateTag; version = $candidateVersion }
    }
  }
)
$previousTag = @($previousCandidates | Sort-Object version -Descending | Select-Object -First 1)
$previousTagName = if ($previousTag.Count -eq 0) { $null } else { [string]$previousTag[0].tag }
$logRange = if ($null -eq $previousTagName) { $TagName } else { "$previousTagName..$TagName" }
$gitLogLines = @(Invoke-GitLines @(
  'log'
  '--first-parent'
  '--date=short'
  '--pretty=format:- %s (%h, %ad)'
  $logRange
))
if ($gitLogLines.Count -eq 0 -or @($gitLogLines | Where-Object { $_.Trim().Length -gt 0 }).Count -eq 0) {
  throw "git log produced no commits for $logRange."
}

$combinedNotes = [Collections.Generic.List[string]]::new()
$combinedNotes.Add($releaseNotes.TrimEnd())
$combinedNotes.Add('')
$combinedNotes.Add('## 代码变更（Git Log）')
$combinedNotes.Add('')
if ($null -eq $previousTagName) {
  $combinedNotes.Add("范围：首次发布，截至 ``$TagName``。")
} else {
  $combinedNotes.Add("范围：``$previousTagName..$TagName``。")
}
$combinedNotes.Add("目标提交：``$tagCommit``。")
$combinedNotes.Add('')
foreach ($line in $gitLogLines) { $combinedNotes.Add($line) }
$combinedNotes.Add('')
$combinedNotes.Add('以上列表由已提交的 Git 历史生成；未提交的工作区变化不会出现在版本记录中。')

$outputDirectory = [IO.Path]::GetFullPath($OutputRoot)
if (Test-Path -LiteralPath $outputDirectory) {
  throw "OutputRoot must not already exist: $outputDirectory"
}
$null = New-Item -ItemType Directory -Path $outputDirectory

$setupOutputName = "PhotoMap-$TagName-Setup-win32-x64.exe"
$portableOutputName = "PhotoMap-$TagName-portable-win32-x64.zip"
$manifestOutputName = "PhotoMap-$TagName-release-manifest.json"
$checksumOutputName = "PhotoMap-$TagName-SHA256SUMS.txt"
$notesOutputName = 'RELEASE-NOTES.md'

$setupOutputPath = Join-Path $outputDirectory $setupOutputName
$portableOutputPath = Join-Path $outputDirectory $portableOutputName
$manifestOutputPath = Join-Path $outputDirectory $manifestOutputName
$notesOutputPath = Join-Path $outputDirectory $notesOutputName
Copy-Item -LiteralPath $setupItem.FullName -Destination $setupOutputPath
Copy-Item -LiteralPath $portableItem.FullName -Destination $portableOutputPath
Copy-Item -LiteralPath $manifestItem.FullName -Destination $manifestOutputPath
[IO.File]::WriteAllText($notesOutputPath, (($combinedNotes -join "`n") + "`n"), [Text.UTF8Encoding]::new($false))

$downloadArtifacts = @($setupOutputPath, $portableOutputPath, $manifestOutputPath)
$downloadChecksumLines = foreach ($artifactPath in $downloadArtifacts) {
  "$(Get-Sha256 $artifactPath) *$([IO.Path]::GetFileName($artifactPath))"
}
$checksumOutputPath = Join-Path $outputDirectory $checksumOutputName
[IO.File]::WriteAllText($checksumOutputPath, (($downloadChecksumLines -join "`n") + "`n"), [Text.UTF8Encoding]::new($false))

[pscustomobject]@{
  tag = $TagName
  version = $version
  tagCommit = $tagCommit
  previousTag = $previousTagName
  gitLogRange = $logRange
  releaseDirectory = $releaseDirectory
  outputDirectory = $outputDirectory
  notes = $notesOutputPath
  assets = @($downloadArtifacts + $checksumOutputPath)
} | ConvertTo-Json -Depth 5
