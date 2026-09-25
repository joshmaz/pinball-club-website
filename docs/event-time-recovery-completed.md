# Event time recovery completed

Applied and independently verified on September 25, 2026: **206 timestamp-only updates**.

- 127 user-confirmed defaults: 43 Monday leagues and 84 Wednesday knockouts at 7:30 PM America/New_York.
- 79 source-verified times: two from the initial proposal and 77 additional Facebook listings or date-specific recurrence entries.
- 236 published records in the refreshed snapshot; 228 have known times and eight remain unresolved.
- IDs and all unrelated fields were preserved. The automatic updated_at field changed as expected.
- Each update used a comparison against the original timestamp and current updated_at value. Local backups and journals were saved before writing.

The December 21, 2018 Yankee Knockout starts at 7 PM New York, exactly midnight UTC. A source-backed display exception matches its UUID and precise timestamp; other midnight placeholders remain unknown. Explicit database time-precision metadata is a future schema improvement.

## Unresolved records

- **2026-04-26 — Clean Sweep and Memory Lap**: Verify original listing; no confirmed rule applies.
- **2026-04-25 — Last Call Load-Out Party**: Verify original listing; no confirmed rule applies.
- **2026-04-19 — Get-Your-Tools Day**: Verify original listing; no confirmed rule applies.
- **2026-04-18 — Take Your Pin Home from the Club Day**: Verify original listing; no confirmed rule applies.
- **2026-04-11 — American Pinball Warrior Tournament**: Verify original listing; no confirmed rule applies.
- **2026-03-04 — NEPL Season 36 - Week 7 Makeup**: Verify original listing; no confirmed rule applies.
- **2026-01-02 — Friday Night Yankee Swap!!!**: Facebook header: 7 PM; description: doors 7:15, tournament 7:45/8 PM. Review intended start..
- **2022-04-24 — Sunday PinGolf**: Facebook header says 12:30 AM; possible AM/PM error, left for confirmation.

## Evidence and change log

See `event-time-recovery-facebook.json` for source URLs, local times, converted UTC timestamps and row IDs. See `event-time-recovery-applied.json` for the complete applied change log. The initial proposal remains as historical review evidence.

The public snapshot has been refreshed in this PR. Database changes are live; the public display fix remains in the open, unmerged PR.
