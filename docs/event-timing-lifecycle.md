# Event timing and lifecycle

Public cards keep exact dates and show Eastern-time relative timing. Labels take
precedence in this order: In Progress, Today, Tomorrow, This Weekend, This Week,
Next Week, Soon, Upcoming. Calendar weeks run Monday–Sunday. This Weekend covers
Saturday/Sunday and a confirmed Friday start at or after 5 PM Eastern in the
current calendar week. Soon covers dates within 14 days after the nearer labels.
Unknown dates stay Upcoming. Calendar-only and legacy unknown-time dates retain
their original calendar date; confirmed timestamps display in America/New_York.
The editor continues to label its browser-local date/time inputs explicitly.

`ends_at` is optional. New timed events receive an editable three-hour default;
changing a new start moves that default until the editor changes or clears it.
Existing events receive no default, and custom ends stay fixed when starts change.
All-day events never receive an end. An end must follow a confirmed start. Events
with a confirmed end remain upcoming until that end (exclusive), including across
midnight, and are In Progress only from start (inclusive) to end (exclusive).
Without an end, the existing same-calendar-day behavior remains, using Eastern
days. Unknown times cannot become In Progress.

Publication and lifecycle are independent. Scheduled, Canceled, and Postponed
remain in their ordinary date-based lists, with canceled/postponed at their
original date. Only publication controls public visibility. Canceled/postponed
never display In Progress. Use lifecycle status to cancel an event; unpublish only
when it should disappear from the public list.

To reschedule, open an existing event, change its schedule, and check the explicit
reschedule checkbox. Saving captures the immediately previous start/end and time
precision, an optional note, and sets lifecycle to Scheduled. Cards show
Rescheduled plus timing, the previous date/time, and the note. Routine edits never
create reschedule metadata. This stores one previous schedule, not a history.

Live reads, snapshot export/fallback, and JSON import preserve the new fields.
Old snapshots need no rewrite or end backfill. UUID-bearing imports upsert by UUID;
legacy imports retain their existing import-key deduplication. Snapshot refresh
uses public RLS and includes only published events.

## Migration and release reference

Migration `20261011120000_event_timing_lifecycle.sql` adds optional end,
lifecycle, previous-schedule, and note columns with validation constraints. It
does not backfill ends or change RLS/publication policies. MatchPlay review reads
candidates; opening the editor loads the full saved event through the existing
admin reader. New MatchPlay drafts use the same editor defaults.

The one-time rollout commands from the original feature PR have been removed.
For current migration review, staging verification, release promotion, and
snapshot refresh instructions, use [Staging, migration, and release
workflow](netlify-previews.md). A static site deployment does not apply this
migration.
