<#
.SYNOPSIS
    Download Pinball Map “location activity” (user submissions) into a JSON data file.

.DESCRIPTION
    Pulls from the public Pinball Map API endpoint used by the site’s per-location activity feed:
      GET https://pinballmap.com/api/v1/user_submissions/location.json

    - Full sync: paginates through every page (API limit max 50/page), uses the API as the source
      of truth, and rewrites the output file. This verifies against the live site and fills any
      gaps (missing IDs, stale copies, local edits).

    - Incremental sync: walks pages newest-first and stops once a full page only contains
      submission IDs already present locally—ideal when you only want new rows since the last run.
      Afterward, the script re-queries page 1 to read pagy.count and ensures the merged dataset’s
      distinct ID count matches; if not, it automatically falls back to a full sync.

    - Auto (default): if the output file is missing, runs Full. If it exists, runs Incremental
      unless -ForceFullSync is set or verification fails (then Full).

    The output schema matches data/pinballmap-location-8908-activity.json:
      { "meta": { ... }, "user_submissions": [ ... ] }

.PARAMETER LocationId
    Pinball Map location id (default: 8908 — Southern NH Pinball Club).

.PARAMETER OutputPath
    Path to the JSON file to write. Default: ..\data\pinballmap-location-<LocationId>-activity.json
    relative to this script directory.

.PARAMETER SyncMode
    Auto | Full | Incremental — see DESCRIPTION.

.PARAMETER ForceFullSync
    When set with SyncMode Auto, always performs a full pagination sync (still merges for a
    stable write if a partial read ever occurred).

.PARAMETER TimeoutSec
    HTTP timeout per request.

.PARAMETER PassThru
    Emit the final PSCustomObject to the pipeline after a successful write.

.EXAMPLE
    .\Refresh-PinballMapLocationActivity.ps1

    Auto: create or update the default JSON under data\ using incremental logic when possible.

.EXAMPLE
    .\Refresh-PinballMapLocationActivity.ps1 -SyncMode Full

    Always re-download every page and replace the dataset from the API.

.EXAMPLE
    .\Refresh-PinballMapLocationActivity.ps1 -SyncMode Incremental -LocationId 8908

    Append only new submissions; auto full sync if counts do not match afterward.

.NOTES
    Requires PowerShell 5.1 or PowerShell 7+. Uses TLS 1.2+.
    Respect Pinball Map’s terms of use; this script performs a small number of GET requests.
#>

[CmdletBinding(SupportsShouldProcess = $false)]
param(
    [Parameter()]
    [int]$LocationId = 8908,

    [Parameter()]
    [string]$OutputPath = "",

    [Parameter()]
    [ValidateSet("Auto", "Full", "Incremental")]
    [string]$SyncMode = "Auto",

    [Parameter()]
    [switch]$ForceFullSync,

    [Parameter()]
    [int]$TimeoutSec = 60,

    [Parameter()]
    [switch]$PassThru
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

#region ----- helpers -----

function Get-ScriptDataOutputPath {
    param([int]$Id)
    Join-Path $PSScriptRoot ("..\data\pinballmap-location-{0}-activity.json" -f $Id)
}

function Read-ActivityJsonFile {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) {
        return $null
    }
    try {
        $raw = Get-Content -LiteralPath $Path -Raw -Encoding UTF8
        if ([string]::IsNullOrWhiteSpace($raw)) {
            throw "File is empty."
        }
        return $raw | ConvertFrom-Json
    } catch {
        throw "Failed to read or parse existing JSON at '$Path': $_"
    }
}

function Invoke-PinballMapActivityRequest {
    <#
    .SYNOPSIS
        GET one page of user_submissions for a location (Pinball Map public API).
    #>
    param(
        [int]$LocationId,
        [int]$Page,
        [int]$Limit = 50,
        [int]$TimeoutSec
    )
    $e = { param([string]$s) [uri]::EscapeDataString($s) }
    $qs = "id=$(&$e $LocationId)&limit=$(&$e $Limit)"
    if ($Page -gt 1) {
        $qs += "&page=$(&$e $Page)"
    }
    $uri = "https://pinballmap.com/api/v1/user_submissions/location.json?$qs"

    try {
        return Invoke-RestMethod -Uri $uri -Method Get -TimeoutSec $TimeoutSec `
            -Headers @{ Accept = "application/json" }
    } catch {
        $msg = $_.Exception.Message
        if ($_.ErrorDetails -and $_.ErrorDetails.Message) {
            $msg = $_.ErrorDetails.Message
        }
        throw "HTTP request failed for $uri : $msg"
    }
}

function Get-PinballMapAllSubmissions {
    <#
    .SYNOPSIS
        Paginate through every user_submission row for the location (API max 50 per page).
    .NOTES
        Validates that the number of rows pulled equals pagy.count from page 1.
    #>
    param(
        [int]$LocationId,
        [int]$TimeoutSec
    )
    $all = [System.Collections.Generic.List[object]]::new()
    $page = 1
    $totalPages = 1
    $expectedTotal = -1

    while ($page -le $totalPages) {
        $resp = Invoke-PinballMapActivityRequest -LocationId $LocationId -Page $page -Limit 50 -TimeoutSec $TimeoutSec
        if ($null -eq $resp.user_submissions) {
            throw "Unexpected API response: missing 'user_submissions' on page $page."
        }
        if ($null -eq $resp.pagy) {
            throw "Unexpected API response: missing 'pagy' on page $page."
        }
        if ($page -eq 1) {
            $expectedTotal = [int]$resp.pagy.count
        }
        $totalPages = [int]$resp.pagy.pages
        if ($totalPages -lt 1) {
            throw "Invalid pagy.pages=$totalPages on page $page."
        }
        foreach ($row in $resp.user_submissions) {
            $all.Add($row)
        }
        $page++
    }

    if ($expectedTotal -ge 0 -and $all.Count -ne $expectedTotal) {
        throw "Pagination incomplete or API count changed mid-run: pulled $($all.Count) rows but pagy.count was $expectedTotal."
    }

    return $all
}

function Get-SubmissionIdSet {
    param($SubmissionList)
    $set = @{}
    foreach ($s in $SubmissionList) {
        $id = [int]$s.id
        $set[$id] = $true
    }
    return $set
}

function Merge-SubmissionsById {
    <#
    .SYNOPSIS
        Union local rows with freshly fetched API rows; API copy wins when ids match.
    #>
    param(
        [object[]]$ApiRows,
        [object[]]$LocalRows
    )
    $byId = @{}
    foreach ($s in $LocalRows) {
        $byId[[int]$s.id] = $s
    }
    $added = 0
    $updated = 0
    foreach ($s in $ApiRows) {
        $id = [int]$s.id
        if (-not $byId.ContainsKey($id)) {
            $byId[$id] = $s
            $added++
        } else {
            $byId[$id] = $s
            $updated++
        }
    }
    $merged = @($byId.Values)
    # Newest first: created_at is ISO 8601 with consistent offset from API
    $merged = $merged | Sort-Object @{ Expression = { $_.created_at }; Descending = $true }
    return [pscustomobject]@{
        Merged   = $merged
        Added    = $added
        Updated  = $updated
        Distinct = $merged.Count
    }
}

function Build-OutputObject {
    param(
        [int]$LocationId,
        [object[]]$Submissions,
        [string]$SyncModeLabel,
        [string]$PreviousFetchedAt
    )
    $locName = $null
    foreach ($s in $Submissions) {
        if ($s.location_name) {
            $locName = [string]$s.location_name
            break
        }
    }
    $meta = [ordered]@{
        source             = "https://pinballmap.com/api/v1/user_submissions/location.json"
        location_id        = $LocationId
        location_name      = $locName
        pinballmap_url     = "https://pinballmap.com/map/?by_location_id=$LocationId"
        fetched_at         = [datetime]::UtcNow.ToString("o")
        submission_count   = $Submissions.Count
        last_sync_mode     = $SyncModeLabel
        previous_fetched_at = $PreviousFetchedAt
    }
    return [pscustomobject]@{
        meta              = [pscustomobject]$meta
        user_submissions  = @($Submissions)
    }
}

function Write-ActivityJson {
    param(
        [string]$Path,
        [object]$Object
    )
    $dir = Split-Path -Parent $Path
    if (-not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
    try {
        $json = $Object | ConvertTo-Json -Depth 20
        $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
        [System.IO.File]::WriteAllText($Path, $json + "`n", $utf8NoBom)
    } catch {
        throw "Failed to write JSON to '$Path': $_"
    }
}

#endregion

#region ----- main -----

try {
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    } catch {
        # PS Core uses different stack; ignore if not applicable
    }

if ([string]::IsNullOrWhiteSpace($OutputPath)) {
    $OutputPath = Get-ScriptDataOutputPath -Id $LocationId
}
$OutputPath = $PSCmdlet.SessionState.Path.GetUnresolvedProviderPathFromPSPath($OutputPath)

$previousFetchedAt = $null
$existing = Read-ActivityJsonFile -Path $OutputPath
if ($null -ne $existing -and $existing.meta) {
    $previousFetchedAt = [string]$existing.meta.fetched_at
}

$effectiveMode = $SyncMode
if ($SyncMode -eq "Auto") {
    if ($null -eq $existing -or $ForceFullSync) {
        $effectiveMode = "Full"
    } else {
        $effectiveMode = "Incremental"
    }
}

Write-Verbose "OutputPath=$OutputPath LocationId=$LocationId EffectiveMode=$effectiveMode"

$finalSubmissions = $null
$syncLabel = $effectiveMode

if ($effectiveMode -eq "Full") {
    $rows = Get-PinballMapAllSubmissions -LocationId $LocationId -TimeoutSec $TimeoutSec
    if ($rows.Count -eq 0) {
        Write-Warning "API returned zero submissions for location $LocationId."
    }
    $sorted = @($rows) | Sort-Object @{ Expression = { $_.created_at }; Descending = $true }
    $finalSubmissions = $sorted
    Write-Host ("Full sync: wrote {0} submissions (verified against pagy.count)." -f $finalSubmissions.Count)
} else {
    # Incremental: fetch until a page is entirely contained in local IDs, then merge
    if ($null -eq $existing -or -not $existing.user_submissions) {
        throw "Incremental mode requires an existing JSON file with user_submissions. Run with -SyncMode Full first."
    }
    $localRows = @($existing.user_submissions)
    $localSet = Get-SubmissionIdSet -SubmissionList $localRows

    $newRows = [System.Collections.Generic.List[object]]::new()
    $page = 1
    $totalPages = 1
    $allPageIdsKnown = $false

    while ($page -le $totalPages -and -not $allPageIdsKnown) {
        $resp = Invoke-PinballMapActivityRequest -LocationId $LocationId -Page $page -Limit 50 -TimeoutSec $TimeoutSec
        $totalPages = [int]$resp.pagy.pages
        $pageAllKnown = $true
        foreach ($row in $resp.user_submissions) {
            $rid = [int]$row.id
            if (-not $localSet.ContainsKey($rid)) {
                $newRows.Add($row)
                $pageAllKnown = $false
            }
        }
        if ($pageAllKnown -and $resp.user_submissions.Count -gt 0) {
            $allPageIdsKnown = $true
        }
        $page++
    }

    $merge = Merge-SubmissionsById -ApiRows @($newRows) -LocalRows $localRows
    $finalSubmissions = $merge.Merged
    Write-Host ("Incremental: discovered {0} new submission row(s); merged distinct count {1}." -f $newRows.Count, $merge.Distinct)

    $probe = Invoke-PinballMapActivityRequest -LocationId $LocationId -Page 1 -Limit 50 -TimeoutSec $TimeoutSec
    $expected = [int]$probe.pagy.count
    if ($finalSubmissions.Count -ne $expected) {
        Write-Warning ("Verification failed: merged count {0} != API pagy.count {1}. Falling back to full sync." -f $finalSubmissions.Count, $expected)
        $rows = Get-PinballMapAllSubmissions -LocationId $LocationId -TimeoutSec $TimeoutSec
        $finalSubmissions = @($rows) | Sort-Object @{ Expression = { $_.created_at }; Descending = $true }
        $syncLabel = "Full (after failed incremental verify)"
        Write-Host ("Full sync (fallback): {0} submissions." -f $finalSubmissions.Count)
    }
}

$out = Build-OutputObject -LocationId $LocationId -Submissions $finalSubmissions -SyncModeLabel $syncLabel -PreviousFetchedAt $previousFetchedAt
Write-ActivityJson -Path $OutputPath -Object $out
Write-Host "Wrote: $OutputPath"

if ($PassThru) {
    Write-Output $out
}

} catch {
    Write-Error $_
    exit 1
}

#endregion
