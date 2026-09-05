Set-StrictMode -Version Latest

function Get-ReleaseAcceptance {
  param(
    [string]$Path,
    [Parameter(Mandatory)] [string]$Version,
    [Parameter(Mandatory)] [string]$InstallerSha256,
    [Parameter(Mandatory)] [string]$ApplicationPayloadSha256
  )
  $record = [ordered]@{
    schemaVersion = 1
    applicationVersion = $Version
    status = 'pending'
    source = 'no-owner-evidence'
    reviewedBy = $null
    reviewedAtUtc = $null
    statement = $null
    installerSha256 = $InstallerSha256
    applicationPayloadSha256 = $ApplicationPayloadSha256
    installerSmokeTest = [ordered]@{ status = 'notRun'; notes = 'No owner evidence supplied.' }
    offlineSmokeTest = [ordered]@{ status = 'notRun'; notes = 'No owner evidence supplied.' }
  }
  if ([string]::IsNullOrWhiteSpace($Path)) { return $record }
  $evidence = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json -AsHashtable
  if ($evidence.schemaVersion -ne 1 -or $evidence.applicationVersion -cne $Version -or
      $evidence.installerSha256 -ine $InstallerSha256 -or
      $evidence.applicationPayloadSha256 -ine $ApplicationPayloadSha256) {
    throw 'Release acceptance must identify this exact version, installer and application payload.'
  }
  foreach ($field in @('reviewedBy', 'reviewedAtUtc', 'statement')) {
    if ([string]::IsNullOrWhiteSpace([string]$evidence[$field])) { throw "Release acceptance requires $field." }
  }
  $reviewedAt = [DateTimeOffset]::Parse([string]$evidence.reviewedAtUtc)
  if ($reviewedAt -gt [DateTimeOffset]::UtcNow.AddMinutes(5)) { throw 'Release acceptance time is in the future.' }
  foreach ($check in @('installerSmokeTest', 'offlineSmokeTest')) {
    if ($evidence[$check] -isnot [Collections.IDictionary] -or
        $evidence[$check].status -cnotin @('passed', 'failed', 'notRun') -or
        [string]::IsNullOrWhiteSpace([string]$evidence[$check].notes)) {
      throw "Release acceptance requires an explicit status and notes for $check."
    }
    $record[$check] = $evidence[$check]
  }
  $record.source = 'supplied-owner-evidence'
  $record.reviewedBy = $evidence.reviewedBy
  $record.reviewedAtUtc = $reviewedAt.ToUniversalTime().ToString('o')
  $record.statement = $evidence.statement
  $record.status = if ($record.installerSmokeTest.status -ceq 'passed' -and $record.offlineSmokeTest.status -ceq 'passed') { 'accepted' } else { 'reviewed-with-gaps' }
  return $record
}
