Set-StrictMode -Version Latest

$script:ArtifactPolicy = Get-Content -LiteralPath (Join-Path $PSScriptRoot '../build/artifact-policy.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$script:ArtifactInputManifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot '../build/input-manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$script:ArtifactFilePatterns = @($script:ArtifactInputManifest.excludedFilePatterns | ForEach-Object {
  [Management.Automation.WildcardPattern]::new($_, [Management.Automation.WildcardOptions]::IgnoreCase)
})

function Test-ForbiddenArtifactPath {
  param([string]$Path, [switch]$Directory, [switch]$Source)
  $parts = @($Path.Replace('\', '/').Trim('/') -split '/')
  if (@($parts | Where-Object { $_ -in @('.', '..') }).Count -gt 0) { return $true }
  $directoryCount = if ($Directory) { $parts.Count } else { $parts.Count - 1 }
  for ($index = 0; $index -lt $directoryCount; $index++) {
    $name = $parts[$index]
    if ($Source -and $name -in $script:ArtifactPolicy.sourceAllowedDirectories) { continue }
    if ($name -in $script:ArtifactPolicy.forbiddenDirectoryNames) { return $true }
  }
  if ($Directory) { return $false }
  $fileName = $parts[-1]
  if ($Source -and $fileName -in $script:ArtifactPolicy.sourceAllowedFileNames) { return $false }
  @($script:ArtifactFilePatterns | Where-Object { $_.IsMatch($fileName) }).Count -gt 0
}

function Assert-ArtifactDirectoryClean([string]$Root, [string]$Label) {
  $output = @(& node (Join-Path $PSScriptRoot '../build/artifact-content.cjs') --directory $Root 2>&1)
  if ($LASTEXITCODE -ne 0) { throw "$Label contains forbidden or invalid application content: $($output -join "`n")" }
}

function Assert-ArtifactArchiveClean([string]$Path, [string]$Label) {
  $archive = [IO.Compression.ZipFile]::OpenRead($Path)
  try {
    foreach ($entry in $archive.Entries) {
      $entryPath = $entry.FullName.Replace('\', '/')
      $directory = $entryPath.EndsWith('/')
      if (Test-ForbiddenArtifactPath -Path $entryPath -Directory:$directory) {
        throw "$Label contains forbidden application content: $entryPath"
      }
      if (-not $directory -and $entryPath.EndsWith('.asar', [StringComparison]::OrdinalIgnoreCase)) {
        # Extract only into a generated local filename, never an archive-provided path.
        $temporaryAsar = Join-Path ([IO.Path]::GetTempPath()) ("photomap-artifact-$([guid]::NewGuid().ToString('N')).asar")
        try {
          [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $temporaryAsar, $false)
          $output = @(& node (Join-Path $PSScriptRoot '../build/artifact-content.cjs') --asar $temporaryAsar 2>&1)
          if ($LASTEXITCODE -ne 0) { throw "$Label contains invalid ASAR content at ${entryPath}: $($output -join "`n")" }
        } finally {
          if (Test-Path -LiteralPath $temporaryAsar) { Remove-Item -LiteralPath $temporaryAsar -Force }
        }
      }
    }
  } finally { $archive.Dispose() }
}
