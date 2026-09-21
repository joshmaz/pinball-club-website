# MatchPlay event review

The Events dashboard can review one MatchPlay tournament at a time. An editor
enters its tournament URL or numeric ID. The server-side Edge Function reads
MatchPlay tournament details and suggests existing club events using the same
MatchPlay URL, local event date, start-time proximity, and title. A same-day
suggestion is **not** treated as a confirmed duplicate.

The editor chooses an existing club event to open in the event form. Empty
description, location, date, and external URL fields can be filled from
MatchPlay; existing values are preserved. No club event is created or saved by
the review itself. The editor reviews and saves any changes manually. This
also allows a club event to be enriched without duplicating it.

## Deployment

The API requires a bearer token. The club has no dedicated MatchPlay account,
so an authorized organizer or site admin must create a token under their
MatchPlay account settings and keep ownership of that credential documented.
Store the token only in Supabase Edge Function secrets:

```bash
supabase secrets set MATCHPLAY_API_TOKEN=<token>
supabase functions deploy matchplay-event-review
```

Do not put the token in browser config, Netlify environment variables, or the
repository. The function checks the signed-in user's event editor role before
calling MatchPlay. It uses a fixed MatchPlay API host and accepts only numeric
tournament IDs, so an arbitrary URL cannot be fetched.

The Netlify preview uses the same Supabase project as production. The UI will
show a configuration or function error until the secret is set and the Edge
Function is deployed. Review calls are read-only. Saving a club event still
uses the existing Events editor and database permissions.

## Follow-up

- Discover tournaments from NEPL/NPC series 6497 and 6028 and the president's
  separately owned tournaments; do not assume one account owns all events.
- Store external identities and multiple source links per club event before
  replacing a Facebook or other existing `external_url` with a MatchPlay link.
- Add a reviewed create/link workflow with explicit duplicate decisions, then
  consider periodic sync. Include off-site finals as candidates for review,
  rather than automatically publishing them as club-hosted events.

MatchPlay API reference: https://app.matchplay.events/api-docs/
