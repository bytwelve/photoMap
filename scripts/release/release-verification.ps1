Set-StrictMode -Version Latest

function Assert-ReleaseFastGate {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)] [object]$Summary,
    [Parameter(Mandatory)] [string]$ResultRoot,
    [Parameter(Mandatory)] [object]$SourceIdentity,
    [Parameter(Mandatory)] [string]$RequiredNodeVersion,
    [Parameter(Mandatory)] [string]$RequiredNpmVersion
  )

  $expectedSteps = @('app-check')
  if ($Summary.gate -eq 'all') { $expectedSteps += 'app-make' }
  $actualSteps = @($Summary.steps | ForEach-Object { $_.name } | Sort-Object -CaseSensitive)
  if ($Summary.gate -notin @('fast', 'all') -or $Summary.runId -ne (Split-Path -Leaf $ResultRoot) -or
      $Summary.exitCode -ne 0 -or $Summary.failed -ne 0 -or $Summary.passed -ne $expectedSteps.Count -or
      ([string]$Summary.environment.node).Trim() -ne "v$RequiredNodeVersion" -or
      ([string]$Summary.environment.npm).Trim() -ne $RequiredNpmVersion -or
      $Summary.sourceIdentity.sha256 -ne $SourceIdentity.sha256 -or
      $Summary.sourceIdentity.fileCount -ne $SourceIdentity.fileCount -or
      $actualSteps.Count -ne $expectedSteps.Count -or
      @(Compare-Object $expectedSteps $actualSteps).Count -ne 0 -or
      @($Summary.steps | Where-Object { $_.status -ne 'passed' -or $_.exitCode -ne 0 }).Count -ne 0) {
    throw 'Fast gate is not a passing result for the current product build inputs and required toolchain.'
  }
  # Only real command logs support the gate. No synthetic per-requirement report.
  foreach ($step in $Summary.steps) {
    $expectedLog = "logs/$($step.name).log"
    if (([string]$step.log).Replace('\', '/') -cne $expectedLog) {
      throw "Unexpected fast-gate log path for $($step.name)."
    }
    $log = Get-Item -LiteralPath (Join-Path $ResultRoot $expectedLog) -Force -ErrorAction Stop
    if ($log.PSIsContainer -or $log.Length -le 0 -or ($log.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "Fast-gate log must be an ordinary non-empty file: $expectedLog"
    }
  }
}
