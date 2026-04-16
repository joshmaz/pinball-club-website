param(
    [string]$EventsUrl = "https://www.facebook.com/snhpinball/events",
    [string]$DataFile = (Join-Path $PSScriptRoot "..\data\events.json"),
    [string]$InputHtmlFile = "",
    [switch]$DebugMatches,
    [switch]$SkipEnrichment
)

$ErrorActionPreference = "Stop"

function Get-LdJsonBlocks {
    param([string]$Html)
    $pattern = '<script[^>]*type=["'']application/ld\+json["''][^>]*>([\s\S]*?)</script>'
    $matches = [regex]::Matches($Html, $pattern, [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
    $blocks = @()
    foreach ($m in $matches) {
        $blocks += $m.Groups[1].Value
    }
    return $blocks
}

function Get-EventNodes {
    param($Node)
    $out = @()

    function Walk {
        param($Current, [ref]$Collected)
        if ($null -eq $Current) { return }

        if ($Current -is [System.Collections.IEnumerable] -and -not ($Current -is [string])) {
            foreach ($item in $Current) {
                Walk -Current $item -Collected $Collected
            }
            return
        }

        if ($Current.PSObject -eq $null) { return }

        $eventType = $Current.'@type'
        $isEvent = $false
        if ($eventType -is [string]) {
            $isEvent = $eventType -eq "Event"
        } elseif ($eventType -is [System.Collections.IEnumerable]) {
            foreach ($t in $eventType) {
                if ($t -eq "Event") { $isEvent = $true; break }
            }
        }

        if ($isEvent) {
            $Collected.Value += $Current
        }

        foreach ($prop in $Current.PSObject.Properties) {
            Walk -Current $prop.Value -Collected $Collected
        }
    }

    Walk -Current $Node -Collected ([ref]$out)
    return $out
}

function Normalize-Date {
    param($StartDate)
    if ([string]::IsNullOrWhiteSpace([string]$StartDate)) { return "TBD" }
    try {
        $d = [datetime]$StartDate
        return $d.ToString("yyyy-MM-dd")
    } catch {
        return [string]$StartDate
    }
}

function Normalize-Location {
    param($Location)
    if ($null -eq $Location) { return "TBD" }
    if ($Location -is [string]) { return $Location }
    if ($Location.PSObject -eq $null) { return "TBD" }

    $place = [string]$Location.name
    $addr = $Location.address

    if ($addr -is [string]) {
        if ([string]::IsNullOrWhiteSpace($place)) { return $addr }
        return "$place - $addr"
    }

    if ($addr -and $addr.PSObject -ne $null) {
        $parts = @()
        foreach ($part in @($addr.streetAddress, $addr.addressLocality, $addr.addressRegion, $addr.postalCode)) {
            if (-not [string]::IsNullOrWhiteSpace([string]$part)) {
                $parts += [string]$part
            }
        }
        if ($parts.Count -gt 0) {
            $joined = ($parts -join ", ")
            if ([string]::IsNullOrWhiteSpace($place)) { return $joined }
            return "$place - $joined"
        }
    }

    if (-not [string]::IsNullOrWhiteSpace($place)) { return $place }
    return "TBD"
}

function Normalize-Event {
    param($EventNode)
    $imageUrl = ""
    if ($EventNode.image -is [string]) {
        $imageUrl = [string]$EventNode.image
    } elseif ($EventNode.image -is [System.Collections.IEnumerable] -and -not ($EventNode.image -is [string])) {
        foreach ($img in $EventNode.image) {
            if ($img -is [string] -and -not [string]::IsNullOrWhiteSpace($img)) {
                $imageUrl = [string]$img
                break
            }
            if ($img.PSObject -and -not [string]::IsNullOrWhiteSpace([string]$img.url)) {
                $imageUrl = [string]$img.url
                break
            }
        }
    } elseif ($EventNode.image.PSObject -and -not [string]::IsNullOrWhiteSpace([string]$EventNode.image.url)) {
        $imageUrl = [string]$EventNode.image.url
    }

    [pscustomobject]@{
        name = if ([string]::IsNullOrWhiteSpace([string]$EventNode.name)) { "Untitled Event" } else { [string]$EventNode.name }
        date = Normalize-Date -StartDate $EventNode.startDate
        location = Normalize-Location -Location $EventNode.location
        description = [string]$EventNode.description
        url = [string]$EventNode.url
        imageUrl = (Normalize-EventUrl -Url $imageUrl)
        source = "facebook"
    }
}

function Convert-HtmlEntities {
    param([string]$Text)
    if ([string]::IsNullOrEmpty($Text)) { return "" }
    return [System.Net.WebUtility]::HtmlDecode($Text)
}

function Strip-Html {
    param([string]$Text)
    if ([string]::IsNullOrEmpty($Text)) { return "" }
    $stripped = [regex]::Replace($Text, "<[^>]+>", " ")
    $stripped = [regex]::Replace($stripped, "\s+", " ")
    return (Convert-HtmlEntities -Text $stripped).Trim()
}

function Get-EventIdFromUrl {
    param([string]$Url)
    $m = [regex]::Match($Url, "/events/(?<id>\d+)")
    if ($m.Success) { return $m.Groups["id"].Value }
    return ""
}

function Normalize-EventUrl {
    param([string]$Url)
    if ([string]::IsNullOrWhiteSpace($Url)) { return "" }
    $decoded = Convert-HtmlEntities -Text $Url
    if ($decoded.StartsWith("/")) {
        return "https://www.facebook.com$decoded"
    }
    return $decoded
}

function Get-CanonicalEventUrl {
    param([string]$Url)
    if ([string]::IsNullOrWhiteSpace($Url)) { return "" }
    $normalized = Normalize-EventUrl -Url $Url
    $eventId = Get-EventIdFromUrl -Url $normalized
    if ([string]::IsNullOrWhiteSpace($eventId)) { return $normalized }
    return "https://www.facebook.com/events/$eventId/"
}

function Get-MetaContent {
    param(
        [string]$Html,
        [string]$PropertyName
    )
    $pattern = "<meta[^>]+(?:property|name)=[""']$([regex]::Escape($PropertyName))[""'][^>]+content=[""'](?<content>[^""']+)[""'][^>]*>"
    $m = [regex]::Match($Html, $pattern, [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
    if (-not $m.Success) { return "" }
    return Convert-HtmlEntities -Text $m.Groups["content"].Value
}

function Enrich-EventFromUrl {
    param(
        $Event,
        [hashtable]$Headers
    )
    $needsName = [string]::IsNullOrWhiteSpace([string]$Event.name) -or ([string]$Event.name -like "Facebook Event*")
    $needsDate = [string]$Event.date -eq "TBD"
    $needsLocation = [string]$Event.location -eq "TBD"
    $needsDescription = [string]::IsNullOrWhiteSpace([string]$Event.description)
    $needsImage = [string]::IsNullOrWhiteSpace([string]$Event.imageUrl)
    if (-not ($needsName -or $needsDate -or $needsLocation -or $needsDescription -or $needsImage)) {
        return $Event
    }

    $url = Get-CanonicalEventUrl -Url ([string]$Event.url)
    if ([string]::IsNullOrWhiteSpace($url)) { return $Event }

    try {
        $resp = Invoke-WebRequest -Uri $url -Headers $Headers -UseBasicParsing -MaximumRedirection 5
        $html = $resp.Content

        $blocks = Get-LdJsonBlocks -Html $html
        $pageEvents = @()
        foreach ($block in $blocks) {
            try {
                $parsed = ConvertFrom-JsonCompat -JsonText $block
                $pageEvents += Get-EventNodes -Node $parsed
            } catch {
                # skip malformed block
            }
        }

        if ($pageEvents.Count -gt 0) {
            $norm = Normalize-Event -EventNode $pageEvents[0]
            if ($needsName -and -not [string]::IsNullOrWhiteSpace([string]$norm.name)) { $Event.name = $norm.name }
            if ($needsDate -and [string]$norm.date -ne "TBD") { $Event.date = $norm.date }
            if ($needsLocation -and [string]$norm.location -ne "TBD") { $Event.location = $norm.location }
            if ($needsDescription -and -not [string]::IsNullOrWhiteSpace([string]$norm.description)) { $Event.description = $norm.description }
            if ($needsImage -and -not [string]::IsNullOrWhiteSpace([string]$norm.imageUrl)) { $Event.imageUrl = $norm.imageUrl }
            $Event.url = $url
            return $Event
        }

        $title = Get-MetaContent -Html $html -PropertyName "og:title"
        if ($needsName -and -not [string]::IsNullOrWhiteSpace($title)) {
            $cleanTitle = $title -replace '\s*\|\s*Facebook\s*$', ''
            if (-not [string]::IsNullOrWhiteSpace($cleanTitle)) { $Event.name = $cleanTitle }
        }

        $desc = Get-MetaContent -Html $html -PropertyName "og:description"
        if ($needsDescription -and -not [string]::IsNullOrWhiteSpace($desc)) {
            $Event.description = $desc
        }
        if ($needsImage) {
            $img = Get-MetaContent -Html $html -PropertyName "og:image"
            if (-not [string]::IsNullOrWhiteSpace($img)) {
                $Event.imageUrl = Normalize-EventUrl -Url $img
            }
        }

        # Date/location hints often appear in og:description.
        if (-not [string]::IsNullOrWhiteSpace($desc)) {
            if ($needsDate) {
                $dateMatch = [regex]::Match($desc, '(?<d>[A-Za-z]{3,9},?\s+[A-Za-z]{3,9}\s+\d{1,2}(?:,\s+\d{4})?)')
                if ($dateMatch.Success) { $Event.date = $dateMatch.Groups["d"].Value }
            }
            if ($needsLocation) {
                $locMatch = [regex]::Match($desc, '(?:at|@)\s+(?<loc>[^|]+)$')
                if ($locMatch.Success) { $Event.location = $locMatch.Groups["loc"].Value.Trim() }
            }
        }

        $Event.url = $url
        return $Event
    } catch {
        return $Event
    }
}

function Decode-JsonLikeString {
    param([string]$Value)
    if ([string]::IsNullOrWhiteSpace($Value)) { return "" }
    try {
        $escaped = $Value -replace '\\', '\\' -replace '"', '\"'
        return ConvertFrom-JsonCompat -JsonText ('"' + $escaped + '"')
    } catch {
        return (Convert-HtmlEntities -Text $Value)
    }
}

function LooksLikeUsefulName {
    param([string]$Text)
    if ([string]::IsNullOrWhiteSpace($Text)) { return $false }
    if ($Text.Length -lt 3 -or $Text.Length -gt 140) { return $false }
    if ($Text -match '^Facebook Event\b') { return $false }
    if ($Text -match 'https?://|static\.xx\.fbcdn|rsrc\.php|__bbox|ScheduledServerJS|RelayPrefetched') { return $false }
    return $true
}

function Enrich-EventsFromSourceHtml {
    param(
        [array]$Events,
        [string]$SourceHtml
    )

    if ([string]::IsNullOrWhiteSpace($SourceHtml)) { return $Events }
    $normalized = $SourceHtml -replace "\\/", "/" -replace "\\u0025", "%"
    $out = @()

    foreach ($evt in $Events) {
        $updated = [pscustomobject]@{
            name = [string]$evt.name
            date = [string]$evt.date
            location = [string]$evt.location
            description = [string]$evt.description
            url = [string]$evt.url
            imageUrl = [string]$evt.imageUrl
            source = [string]$evt.source
        }

        $eventId = Get-EventIdFromUrl -Url $updated.url
        if ([string]::IsNullOrWhiteSpace($eventId)) {
            $out += $updated
            continue
        }

        $idx = $normalized.IndexOf("/events/$eventId")
        if ($idx -lt 0) {
            $out += $updated
            continue
        }

        $start = [Math]::Max(0, $idx - 6000)
        $len = [Math]::Min(20000, $normalized.Length - $start)
        $chunk = $normalized.Substring($start, $len)

        if ([string]::IsNullOrWhiteSpace($updated.name) -or $updated.name -like "Facebook Event*") {
            $namePatterns = @(
                '"(?:event_title|title|name|text)":"(?<v>[^"]{3,180})"',
                '"(?:event_title|title|name|text)":\{"(?:text|name)":"(?<v>[^"]{3,180})"'
            )
            foreach ($p in $namePatterns) {
                $m = [regex]::Match($chunk, $p, [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
                if ($m.Success) {
                    $candidate = Decode-JsonLikeString -Value $m.Groups["v"].Value
                    if (LooksLikeUsefulName -Text $candidate) {
                        $updated.name = $candidate.Trim()
                        break
                    }
                }
            }
        }

        if ([string]$updated.date -eq "TBD") {
            $timePatterns = @(
                '"(?:start_time|event_start_time|start_timestamp|event_time)":(?<ts>\d{10})',
                '"startDate":"(?<iso>[^"]+)"'
            )
            foreach ($p in $timePatterns) {
                $m = [regex]::Match($chunk, $p, [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
                if ($m.Success) {
                    if ($m.Groups["ts"].Success) {
                        try {
                            $dt = [DateTimeOffset]::FromUnixTimeSeconds([int64]$m.Groups["ts"].Value).LocalDateTime
                            $updated.date = $dt.ToString("yyyy-MM-dd")
                            break
                        } catch {}
                    }
                    if ($m.Groups["iso"].Success) {
                        $updated.date = Normalize-Date -StartDate $m.Groups["iso"].Value
                        break
                    }
                }
            }
        }

        if ([string]$updated.location -eq "TBD") {
            $locPatterns = @(
                '"(?:location_name|event_place|location|address)":"(?<v>[^"]{2,180})"'
            )
            foreach ($p in $locPatterns) {
                $m = [regex]::Match($chunk, $p, [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
                if ($m.Success) {
                    $loc = Decode-JsonLikeString -Value $m.Groups["v"].Value
                    if (-not [string]::IsNullOrWhiteSpace($loc) -and $loc -notmatch 'https?://|static\.xx\.fbcdn|rsrc\.php') {
                        $updated.location = $loc.Trim()
                        break
                    }
                }
            }
        }

        if ([string]::IsNullOrWhiteSpace($updated.description)) {
            $descMatch = [regex]::Match($chunk, '"description":"(?<v>[^"]{10,400})"', [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
            if ($descMatch.Success) {
                $d = Decode-JsonLikeString -Value $descMatch.Groups["v"].Value
                if (-not [string]::IsNullOrWhiteSpace($d) -and $d -notmatch 'https?://|static\.xx\.fbcdn|rsrc\.php') {
                    $updated.description = $d.Trim()
                }
            }
        }

        if ([string]::IsNullOrWhiteSpace($updated.imageUrl)) {
            $imagePatterns = @(
                '"(?:image|image_url|profile_pic_uri|cover_photo_uri)":"(?<v>https?://[^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"',
                '(?<v>https?://scontent[^"''\s<>]+\.(?:jpg|jpeg|png|webp)[^"''\s<>]*)'
            )
            foreach ($p in $imagePatterns) {
                $m = [regex]::Match($chunk, $p, [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
                if ($m.Success) {
                    $img = Decode-JsonLikeString -Value $m.Groups["v"].Value
                    if (-not [string]::IsNullOrWhiteSpace($img)) {
                        $updated.imageUrl = Normalize-EventUrl -Url $img
                        break
                    }
                }
            }
        }

        $out += $updated
    }

    return $out
}

function Get-EventLinksFromHtml {
    param([string]$Html)
    $events = @()
    $normalizedHtml = $Html -replace "\\/", "/" -replace "\\u0025", "%"

    # First pass: anchor tags with event links and visible labels.
    $anchorPattern = '<a[^>]+href="(?<href>(?:https?:\/\/[^"]*\/events\/\d+\/?[^"]*|\/events\/\d+\/?[^"]*))"[^>]*>(?<label>.*?)<\/a>'
    $anchorMatches = [regex]::Matches($normalizedHtml, $anchorPattern, [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
    foreach ($m in $anchorMatches) {
        $url = Normalize-EventUrl -Url $m.Groups["href"].Value
        if ([string]::IsNullOrWhiteSpace($url)) { continue }
        $name = Strip-Html -Text $m.Groups["label"].Value
        $eventId = Get-EventIdFromUrl -Url $url
        if ([string]::IsNullOrWhiteSpace($name)) {
            if ([string]::IsNullOrWhiteSpace($eventId)) {
                $name = "Facebook Event"
            } else {
                $name = "Facebook Event $eventId"
            }
        }
        $events += [pscustomobject]@{
            name = $name
            date = "TBD"
            location = "TBD"
            description = ""
            url = (Get-CanonicalEventUrl -Url $url)
            imageUrl = ""
            source = "facebook"
        }
    }

    # Second pass: raw event URLs embedded in scripts/JSON strings.
    # Handles escaped forms like https:\/\/www.facebook.com\/events\/123456789.
    $urlPatternEscaped = '(?<url>https?:\\\/\\\/[^"''<>\s]*\\\/events\\\/(?:s\\\/[^\\\/"''<>\s]+\\\/)?\d+[^"''<>\s]*)'
    $urlPatternPlain = '(?<url>https?://[^"''<>\s]*/events/(?:s/[^/"''<>\s]+/)?\d+[^"''<>\s]*|/events/(?:s/[^/"''<>\s]+/)?\d+[^"''<>\s]*)'
    $urlMatches = @()
    $urlMatches += [regex]::Matches($normalizedHtml, $urlPatternEscaped, [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
    $urlMatches += [regex]::Matches($normalizedHtml, $urlPatternPlain, [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
    foreach ($m in $urlMatches) {
        $raw = $m.Groups["url"].Value -replace "\\/", "/"
        $url = Normalize-EventUrl -Url $raw
        if ([string]::IsNullOrWhiteSpace($url)) { continue }
        if ($url -notmatch "/events/\d+") { continue }
        $eventId = Get-EventIdFromUrl -Url $url
        $name = if ([string]::IsNullOrWhiteSpace($eventId)) { "Facebook Event" } else { "Facebook Event $eventId" }
        $events += [pscustomobject]@{
            name = $name
            date = "TBD"
            location = "TBD"
            description = ""
            url = (Get-CanonicalEventUrl -Url $url)
            imageUrl = ""
            source = "facebook"
        }
    }

    # Deduplicate by canonical URL.
    $seen = @{}
    $deduped = @()
    foreach ($evt in $events) {
        $k = $evt.url.ToLowerInvariant()
        if ($seen.ContainsKey($k)) { continue }
        $seen[$k] = $true
        $deduped += $evt
    }

    if ($DebugMatches) {
        Write-Host ("Debug: extracted {0} unique event link candidate(s)." -f $deduped.Count)
        $deduped | Select-Object -First 20 | ForEach-Object { Write-Host (" - " + $_.url) }

        $idMatches = [regex]::Matches($normalizedHtml, "/events/(?:s/[^/]+/)?(?<id>\d+)", [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
        $ids = @{}
        foreach ($m in $idMatches) { $ids[$m.Groups["id"].Value] = $true }
        Write-Host ("Debug: found {0} raw event id token(s) in normalized HTML." -f $ids.Count)
    }

    return $deduped
}

function Deduplicate-ByNameDate {
    param([array]$Events)
    $seen = @{}
    $output = @()
    foreach ($evt in $Events) {
        $key = ("{0}__{1}" -f $evt.name, $evt.date).ToLowerInvariant()
        if ($seen.ContainsKey($key)) { continue }
        $seen[$key] = $true
        $output += $evt
    }
    return $output
}

function ConvertFrom-JsonCompat {
    param([string]$JsonText)
    try {
        return $JsonText | ConvertFrom-Json -Depth 100
    } catch {
        return $JsonText | ConvertFrom-Json
    }
}

function Get-MobileFallbackEvents {
    param([hashtable]$Headers)
    $mobileUrl = "https://mbasic.facebook.com/snhpinball/events/"
    Write-Host "No JSON-LD events found; trying mobile fallback: $mobileUrl"
    $mobileResp = Invoke-WebRequest -Uri $mobileUrl -Headers $Headers -UseBasicParsing -MaximumRedirection 5
    $mobileHtml = $mobileResp.Content

    return Get-EventLinksFromHtml -Html $mobileHtml
}

Write-Host "Fetching $EventsUrl ..."
$headers = @{
    "User-Agent" = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
    "Accept" = "text/html"
}
$html = ""

if (-not [string]::IsNullOrWhiteSpace($InputHtmlFile)) {
    if (-not (Test-Path -Path $InputHtmlFile)) {
        throw "InputHtmlFile was provided but does not exist: $InputHtmlFile"
    }
    Write-Host "Reading saved HTML from $InputHtmlFile ..."
    $html = Get-Content -Raw -Path $InputHtmlFile
} else {
    $response = Invoke-WebRequest -Uri $EventsUrl -Headers $headers -UseBasicParsing -MaximumRedirection 5
    $html = $response.Content
}

$blocks = Get-LdJsonBlocks -Html $html
$rawEvents = @()
foreach ($block in $blocks) {
    try {
        $parsed = ConvertFrom-JsonCompat -JsonText $block
        $rawEvents += Get-EventNodes -Node $parsed
    } catch {
        # Skip non-JSON or unexpected blocks.
    }
}

$facebookEvents = Deduplicate-ByNameDate -Events (@($rawEvents | ForEach-Object { Normalize-Event -EventNode $_ }))
if ($facebookEvents.Count -eq 0 -and -not [string]::IsNullOrWhiteSpace($InputHtmlFile)) {
    Write-Host "No JSON-LD events found in saved HTML; trying link extraction from file content."
    $facebookEvents = Get-EventLinksFromHtml -Html $html
}

if ($facebookEvents.Count -eq 0 -and [string]::IsNullOrWhiteSpace($InputHtmlFile)) {
    $facebookEvents = Get-MobileFallbackEvents -Headers $headers
}

if ($facebookEvents.Count -eq 0 -and [string]::IsNullOrWhiteSpace($InputHtmlFile)) {
    $pgUrl = "https://www.facebook.com/pg/snhpinball/events/"
    Write-Host "Mobile fallback had no events; trying legacy page URL: $pgUrl"
    $pgResp = Invoke-WebRequest -Uri $pgUrl -Headers $headers -UseBasicParsing -MaximumRedirection 5
    $facebookEvents = Get-EventLinksFromHtml -Html $pgResp.Content
}

if ($facebookEvents.Count -eq 0) {
    if (-not [string]::IsNullOrWhiteSpace($InputHtmlFile)) {
        throw "No Facebook events were detected in the provided HTML file: $InputHtmlFile"
    }
    throw "No Facebook events were detected from main, mobile, or legacy page markup. Facebook may require login or has blocked public scraping. Try using -InputHtmlFile with a saved page while logged in."
}

if (-not $SkipEnrichment -and $facebookEvents.Count -gt 0) {
    if (-not [string]::IsNullOrWhiteSpace($InputHtmlFile)) {
        Write-Host "Enriching imported events from saved HTML (offline best effort) ..."
        $enriched = Enrich-EventsFromSourceHtml -Events $facebookEvents -SourceHtml $html
    } else {
        Write-Host "Enriching imported events from event pages (best effort) ..."
        $enriched = @()
        foreach ($evt in $facebookEvents) {
            $enriched += Enrich-EventFromUrl -Event $evt -Headers $headers
        }
    }
    $facebookEvents = $enriched
}

$existing = @()
if (Test-Path $DataFile) {
    $rawExisting = Get-Content -Raw -Path $DataFile
    if (-not [string]::IsNullOrWhiteSpace($rawExisting)) {
        $parsedExisting = ConvertFrom-JsonCompat -JsonText $rawExisting
        if ($parsedExisting -is [array]) {
            $existing = $parsedExisting
        } else {
            $existing = @($parsedExisting)
        }
    }
}

$nonFacebook = @($existing | Where-Object { $_.source -ne "facebook" })
$merged = @($nonFacebook + $facebookEvents)
$json = $merged | ConvertTo-Json -Depth 100
Set-Content -Path $DataFile -Value $json

Write-Host ("Saved {0} Facebook event(s) to {1} ({2} non-Facebook event(s) preserved)." -f $facebookEvents.Count, $DataFile, $nonFacebook.Count)
