function Get-Sha256([string]$Path) {
  (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
}

function Assert-ChildPath([string]$Parent, [string]$Candidate, [string]$Label) {
  $parentFull = [IO.Path]::GetFullPath($Parent).TrimEnd([IO.Path]::DirectorySeparatorChar)
  $candidateFull = [IO.Path]::GetFullPath($Candidate)
  if (-not $candidateFull.StartsWith("$parentFull$([IO.Path]::DirectorySeparatorChar)", [StringComparison]::OrdinalIgnoreCase)) {
    throw "$Label escaped its expected parent: $candidateFull"
  }
  $candidateFull
}

function Assert-OrdinaryNonEmptyFile([string]$Path, [string]$Label) {
  $item = Get-Item -LiteralPath $Path -Force
  if ($item.PSIsContainer -or $item.Length -le 0 -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "$Label must be an ordinary non-empty file: $Path"
  }
  $item
}
