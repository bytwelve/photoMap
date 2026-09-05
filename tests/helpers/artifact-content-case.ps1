param(
  [Parameter(Mandatory)] [ValidateSet('Directory', 'Archive', 'CreateArchive')] [string]$Mode,
  [Parameter(Mandatory)] [string]$Root,
  [string]$ArchivePath = ''
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../../scripts/release/artifact-content.ps1')
switch ($Mode) {
  'Directory' { Assert-ArtifactDirectoryClean $Root 'Test package' }
  'Archive' { Assert-ArtifactArchiveClean $Root 'Test archive' }
  'CreateArchive' { [IO.Compression.ZipFile]::CreateFromDirectory($Root, $ArchivePath) }
}
