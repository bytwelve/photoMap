Set-StrictMode -Version Latest

function Get-ProductBuildInputFiles {
  [CmdletBinding()]
  param([Parameter(Mandatory)] [string]$AppRoot)

  # This scope works for Git checkouts and source ZIPs, including new files
  # within source directories before git add.
  $root = (Resolve-Path -LiteralPath $AppRoot -ErrorAction Stop).Path
  $manifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'build/input-manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  $excludedDirectories = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  foreach ($name in $manifest.excludedDirectoryNames) { $null = $excludedDirectories.Add($name) }
  $excludedFiles = @($manifest.excludedFilePatterns | ForEach-Object {
    [Management.Automation.WildcardPattern]::new($_, [Management.Automation.WildcardOptions]::IgnoreCase)
  })

  function Assert-OrdinaryInput([IO.FileSystemInfo]$Item) {
    if (($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "Build input must not be a reparse point: $($Item.FullName)"
    }
  }

  Assert-OrdinaryInput (Get-Item -LiteralPath $root -Force -ErrorAction Stop)
  foreach ($relative in $manifest.files) {
    $item = Get-Item -LiteralPath (Join-Path $root $relative) -Force -ErrorAction Stop
    Assert-OrdinaryInput $item
    if ($item.PSIsContainer) { throw "Build input must be a file: $($item.FullName)" }
    [pscustomobject]@{ relativePath = $relative; fullName = $item.FullName }
  }

  $pending = [Collections.Generic.Stack[IO.DirectoryInfo]]::new()
  foreach ($relative in $manifest.directories) {
    $item = Get-Item -LiteralPath (Join-Path $root $relative) -Force -ErrorAction Stop
    Assert-OrdinaryInput $item
    if (-not $item.PSIsContainer) { throw "Build input must be a directory: $($item.FullName)" }
    $pending.Push($item)
  }
  while ($pending.Count -gt 0) {
    foreach ($item in @(Get-ChildItem -LiteralPath $pending.Pop().FullName -Force -ErrorAction Stop)) {
      # Prune before descending, so dependencies, output and their links are
      # never visited, read or hashed.
      if ($item.PSIsContainer -and $excludedDirectories.Contains($item.Name)) { continue }
      if (-not $item.PSIsContainer -and @($excludedFiles | Where-Object { $_.IsMatch($item.Name) }).Count -gt 0) { continue }
      Assert-OrdinaryInput $item
      if ($item.PSIsContainer) {
        $pending.Push($item)
      } else {
        [pscustomobject]@{
          relativePath = [IO.Path]::GetRelativePath($root, $item.FullName).Replace('\', '/')
          fullName = $item.FullName
        }
      }
    }
  }
}

function Copy-ProductBuildInputs {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)] [object[]]$InputFiles,
    [Parameter(Mandatory)] [string]$DestinationRoot
  )

  $destination = [IO.Path]::GetFullPath($DestinationRoot)
  if (Test-Path -LiteralPath $destination) {
    throw "Build staging destination must not already exist: $destination"
  }
  $null = New-Item -ItemType Directory -Path $destination -ErrorAction Stop
  foreach ($inputFile in $InputFiles) {
    $target = [IO.Path]::GetFullPath((Join-Path $destination $inputFile.relativePath))
    if (-not $target.StartsWith($destination.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
      throw "Build input escaped the staging destination: $($inputFile.relativePath)"
    }
    $null = New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($target)) -Force -ErrorAction Stop
    Copy-Item -LiteralPath $inputFile.fullName -Destination $target -ErrorAction Stop
  }
}
