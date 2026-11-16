# MatchPlay event review

The Events dashboard can review one MatchPlay tournament at a time. An editor
enters its tournament URL or numeric ID. The server-side Edge Function reads
MatchPlay tournament details and suggests existing club events using an exact
MatchPlay link, local event date and start-time proximity, and title similarity.
A same-day suggestion is never treated as a confirmed duplicate.

The editor can choose an existing club event to open in the event form. Its
saved fields remain populated; MatchPlay links and missing details can be
prepared in the unsaved form. If there is no matching club event, the editor
can prepare an unpublished draft. The review and draft preparation do not write
to the database. The editor confirms and saves manually.

Editors can list tournaments owned by the MatchPlay API token account, list by
another organizer's numeric MatchPlay user ID, list a series by ID, or search
tournament titles. Results are paginated. Search results are not automatically
imported or assumed to be club-hosted.

## Historical reconciliation

The Events dashboard has an operator-triggered, source-first reconciliation.
It reads every available page (up to a defensive 1,000-page ceiling) of the
configured MatchPlay token owner's tournament inventory and the club-name
searches `SNHPC`, `Southern NH Pinball Club`, and `Southern New Hampshire
Pinball Club`, then deduplicates records by tournament ID. The report names the
token owner and title-search scope. It is complete for those sources; it does
not claim to enumerate tournaments owned by unrelated MatchPlay accounts.

Each MatchPlay record is compared with all club event records. Existing
MatchPlay links are checked first. For unlinked records, the candidate matcher
uses local date and start-time proximity to narrow matches, then title
similarity to distinguish likely matches from ambiguous same-date candidates.
Potential field and link changes are displayed for one-field-at-a-time human
approval. Ambiguous matches open the existing tournament review flow. Records
with no local match are counted and left untouched. Matched records with no
proposed changes are counted as unchanged. Nothing is automatically added or
written by starting the scan.

The summary reports source records, the token-owner organizer inventory, already-linked records, proposed changes,
ambiguous matches, unchanged matches, and records with no club match. A
rate-limit, search failure, or page ceiling is reported as an incomplete
inventory, so no-match counts from that run should not be treated as final.
The operator can run the reconciliation again after the source is available.

## Event Management scan and approval

The separate routine scan checks linked upcoming or in-progress club events
and searches MatchPlay titles for current additions and updates. It uses the
server-side cache and runs only when an editor asks for it. Its results may
include possible additions, field changes, possible matches, and unchanged
linked events. Editors approve proposed changes one field at a time. A
date/time change can optionally be recorded as a reschedule. Any new event is
created as an unpublished draft only after an explicit approval.

The MatchPlay tournament format is stored in the optional
`events.matchplay_format` field and shown publicly when present. Format,
title, date/time, location, description, and source link can be reviewed as
individual changes. MatchPlay organizer, series, and status are shown as
source context only; status does not change the club event's lifecycle. Scores,
standings, registration windows, player capacity, and waitlists are not
imported.

## Deployment

The API requires a bearer token. Keep the token only in Supabase Edge Function
secrets:

```bash
supabase secrets set MATCHPLAY_API_TOKEN=<token>
supabase functions deploy matchplay-event-review
```

Do not put the token in browser config, Netlify environment variables, or the
repository. The function checks the signed-in user's event editor role before
calling MatchPlay. It uses a fixed MatchPlay API host and accepts only numeric
tournament IDs, so an arbitrary URL cannot be fetched.

Redeploy the function after changing its code. Updating the Netlify preview
alone does not update a Supabase Edge Function. Review calls are read-only;
saving a club event still uses the existing Events editor and database
permissions.

## Follow-up

- Review NEPL/NPC series 6497 and 6028 and separately owned tournaments through
  the discovery controls.
- If a future integration needs durable cross-source identity mapping or a
  periodic sync, introduce source-neutral link/run records after this one-time
  MatchPlay cleanup proves the review flow.

MatchPlay API reference: https://app.matchplay.events/api-docs/
## Single-tournament lookup regression (September 2026)

A direct unauthenticated probe of tournament `228825` returned HTTP 200 from
`/api/tournaments/228825?includeLocation=1`, with the documented
`data.tournamentId` and `data.location` fields. The endpoint, query parameter,
and wrapped response shape are retained. No alternate envelope was observed.

The reproducible failure was the subsequent club-event query. Passing an array
of objects to Supabase JS 2.56.1's `.contains()` generated
`external_links=cs.{[object Object]}`. PostgreSQL rejects that value as invalid
JSON for the `external_links` JSONB column. This query runs on every single-event
review, including tournaments with no date, but never during discovery. Passing
`JSON.stringify([{ url: tournament.url }])` produces the required JSONB filter.
No database migration is needed.

`node --test scripts/matchplay-event-review.test.mjs scripts/matchplay-lookup.test.mjs`
executes the actual Edge Function handler with mocked HTTP responses and the
same Supabase SDK version as deployment. It covers the exact request, wrapped
response, numeric/string IDs, absent optional fields, rejected payloads, linked
candidates, discovery, and provider diagnostics. A local PostgreSQL test also
checks the invalid old filter and valid JSONB containment. Provider errors keep
HTTP status and at most 240 characters of a credential-redacted message or text
excerpt. Raw request/transport errors are not returned.

These checks reproduce the code defect; they do not inspect production Edge
Function logs or exercise an authenticated production review. After deploying,
verify an individual review from the Events dashboard. The preview shares the
production Supabase project, so deployment affects both environments.
