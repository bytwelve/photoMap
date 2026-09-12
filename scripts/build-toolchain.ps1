function Assert-CompatibleBuildVersion {
  param(
    [Parameter(Mandatory)] [string]$Tool,
    [Parameter(Mandatory)] [string]$ActualVersion,
    [Parameter(Mandatory)] [string]$RequiredRange
  )

  # Build engines use stable caret ranges with a nonzero major version.
  if ($RequiredRange -notmatch '^\^([1-9][0-9]*\.[0-9]+\.[0-9]+)$') {
    throw "Unsupported build engine range for ${Tool}: $RequiredRange"
  }
  $minimumVersion = [version]$Matches[1]
  if ($ActualVersion -notmatch '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$') {
    throw "$Tool $RequiredRange is required; current runtime is $ActualVersion. Use a stable release."
  }
  $currentVersion = [version]$ActualVersion
  if ($currentVersion.Major -ne $minimumVersion.Major -or $currentVersion -lt $minimumVersion) {
    throw "$Tool $RequiredRange is required; current runtime is $ActualVersion."
  }
}
