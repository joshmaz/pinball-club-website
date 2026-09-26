# Event time recovery completed

Applied and independently verified on September 25, 2026: **206 initial timestamp-only updates, plus all eight user-confirmed corrections**.

- 127 user-confirmed defaults: 43 Monday leagues and 84 Wednesday knockouts at 7:30 PM America/New_York.
- 79 source-verified times: two from the initial proposal and 77 additional Facebook listings or date-specific recurrence entries.
- 236 published records in the refreshed snapshot: 232 timed events and four all-day events; none remain unresolved.
- IDs and all unrelated fields were preserved. The automatic updated_at field changed as expected.
- Each update used a comparison against the original timestamp and current updated_at value. Local backups and journals were saved before writing.

The additive all_day and time_known database fields now record precision explicitly. All 206 recovered timestamps are marked known, including the December 21, 2018 Yankee Knockout at 7 PM New York (midnight UTC). The temporary hard-coded display exception has been removed. The editor supports all-day dates; unchanged schedules preserve their existing time precision.

## Final user-confirmed corrections

- April 18, 19, 25, and 26, 2026: all-day events.
- April 11, 2026: first session at 7:30 PM; description records sessions at 7:30 PM and 9:45 PM. These are two starts, not a start/end range.
- March 4, 2026: 7:30 PM.
- January 2, 2026: 7:30 PM, resolving the Facebook ambiguity.
- April 24, 2022: 12:30 PM, correcting Facebook's AM/PM error.

All clock times above are America/New_York, with historical daylight-saving offsets. Existing descriptions were preserved; only April 11 received an appended session note. See `event-time-user-corrections.json` for the applied field values. The schema migration has already been applied and recorded in the remote migration ledger.

## Evidence and change log

See `event-time-recovery-facebook.json` for source URLs, local times, converted UTC timestamps and row IDs. See `event-time-recovery-applied.json` for the complete applied change log. The initial proposal remains as historical review evidence.

The public snapshot has been refreshed in this PR. Database changes are live; the public display fix remains in the open, unmerged PR.
