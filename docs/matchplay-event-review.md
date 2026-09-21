# MatchPlay event review

The Events dashboard can review one MatchPlay tournament at a time. An editor
enters its tournament URL or numeric ID. The server-side Edge Function reads
MatchPlay tournament details and suggests existing club events using the same
MatchPlay URL, local event date, start-time proximity, and title. A same-day
suggestion is **not** treated as a confirmed duplicate.

The editor can choose an existing club event to open in the event form. Its
saved fields remain populated; empty description, location, date, and external
URL fields can be filled from MatchPlay. If there is no matching club event,
the editor can prepare a new unpublished draft with MatchPlay details. The
review and draft preparation do not write to the database. The editor confirms
that it is a club event and saves manually. This lets a club event be enriched
without duplicating it and avoids automatically publishing off-site finals.

Editors can list tournaments owned by the MatchPlay API token account, list by
another organizer's numeric MatchPlay user ID, list a series by ID, or search
tournament titles (for example, `SNHPC`). Results are paginated. The token
account is the MatchPlay account that supplied the server secret; it may differ
from the member signed in to the club website. Choosing "Review match" opens
the date/time review flow. Search results are not automatically imported or
assumed to be club-hosted.

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

Redeploy the function after changing its code. Updating the Netlify preview
alone does not update a Supabase Edge Function.

The Netlify preview uses the same Supabase project as production. The UI will
show a configuration or function error until the secret is set and the Edge
Function is deployed. Review calls are read-only. Saving a club event still
uses the existing Events editor and database permissions.

## Follow-up

- Review NEPL/NPC series 6497 and 6028 and the president's separately owned
  tournaments through the new discovery controls.
- Store external identities and multiple source links per club event before
  replacing a Facebook or other existing `external_url` with a MatchPlay link.
- Store reviewed source links and explicit duplicate decisions, then consider
  periodic sync. Keep off-site finals out of the public club calendar unless
  an editor explicitly chooses to publish them.

MatchPlay API reference: https://app.matchplay.events/api-docs/
