#!/usr/bin/env python3
"""Prepare a read-only recovery proposal from an event audit JSON file."""
import json
import re
import sys
from datetime import datetime, time, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

ZONE = ZoneInfo('America/New_York')
# Facebook event headers read in the signed-in browser on 2026-09-25.
VERIFIED = {
    '21c40393-4962-4b98-ad70-9655ba6601fe': ('2016-01-30', '12:00', 'https://www.facebook.com/events/1671383923132082/', ''),
    'b6994b80-c0fb-4bd8-9800-a5ea6e6e0721': ('2020-03-04', '19:30', 'https://www.facebook.com/events/583061642186822/752180968608221/', ''),
}
# The 2026 Yankee Swap header says 7 PM, but its description says doors 7:15,
# tournament 7:45/8 PM. Keep it in review instead of resolving this silently.

def propose(row):
    raw = row.get('starts_at')
    if not raw:
        return None, 'Missing date'
    instant = datetime.fromisoformat(raw.replace('Z', '+00:00')).astimezone(timezone.utc)
    if instant.time() != time(0):
        return None, 'Existing non-placeholder time retained'
    date = instant.date()
    title = row['title']
    verified = VERIFIED.get(row['id'])
    if verified and date.isoformat() == verified[0]:
        return (verified[1], 'Verified Facebook event header', verified[2]), None
    if date.weekday() == 0 and re.search(r'\b(NEPL|league)\b', title, re.I) and not re.search(r'final|party|makeup', title, re.I):
        return ('19:30', 'User-confirmed Monday league default', row.get('external_url')), None
    if date.weekday() == 2 and re.search(r'\b(Wednesday|Wesnesday)\b', title, re.I) and re.search(r'knock[ -]?outs?', title, re.I):
        return ('19:30', 'User-confirmed Wednesday knockout default', row.get('external_url')), None
    if row['id'] == 'b5d0d0bd-e472-469c-9244-28c0c1cb1dc8':
        return None, 'Facebook header: 7 PM; description: doors 7:15, tournament 7:45/8 PM. Review intended start.'
    return None, 'Verify original listing; no confirmed rule applies'

def main():
    source = json.loads(Path(sys.argv[1]).read_text())
    rows = source.get('unknown', source.get('events', []))
    proposed, review = [], []
    for row in rows:
        match, reason = propose(row)
        if not match:
            review.append({**row, 'reason': reason})
            continue
        local_time, basis, url = match
        date = row['starts_at'][:10]
        local = datetime.fromisoformat(date + 'T' + local_time).replace(tzinfo=ZONE)
        proposed.append({
            'id': row['id'], 'title': row['title'], 'expected_starts_at': row['starts_at'],
            'proposed_starts_at': local.astimezone(timezone.utc).isoformat().replace('+00:00', 'Z'),
            'local_date': date, 'local_time': local_time, 'timezone': str(ZONE),
            'basis': basis, 'evidence_url': url,
        })
    output = Path(sys.argv[2])
    output.write_text(json.dumps({'status': 'proposal_only_not_applied', 'source_checked_at': source.get('checkedAt'),
        'scope': 'Published records only; no database writes', 'proposed': proposed, 'review': review}, indent=2) + '\n')
    md = ['# Event time recovery proposal', '', f'{len(proposed)} proposed updates; {len(review)} records still require review.', '',
        'No database records have been changed. Proposed times use America/New_York with the historical daylight-saving offset. Updates must match UUID and expected timestamp, modify starts_at only, and skip any record changed since this audit.', '',
        'Defaults were confirmed by the user. Facebook evidence was read on September 25, 2026; these local club times are interpreted in America/New_York. Recurring dates are not inferred from another occurrence.', '', '## Proposed updates', '']
    for x in proposed:
        md.append(f"- **{x['local_date']} — {x['title']}**: {x['local_time']} New York → `{x['proposed_starts_at']}`. {x['basis']}. UUID: `{x['id']}`.")
    md += ['', '## Needs review', '']
    for x in review:
        link = f" [Original listing]({x['external_url']})" if x.get('external_url') else ''
        md.append(f"- **{(x.get('starts_at') or 'Undated')[:10]} — {x['title']}**: {x['reason']}.{link}")
    output.with_suffix('.md').write_text('\n'.join(md)+'\n')
    print(f'Proposed: {len(proposed)}; review: {len(review)}')
    from collections import Counter
    print(dict(Counter(x['basis'] for x in proposed)))

if __name__ == '__main__':
    main()
