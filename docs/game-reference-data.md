# Game reference data

## Source responsibilities

- The OPDB V2 export is the source for machine IDs and exact IPDB cross-references.
- Kineticist is queried only on demand by a game's exact OPDB ID. The full JSON response is cached for 24 hours in `external_api_cache`; its own `links.web` field supplies the canonical Kineticist permalink.
- Pinball Map remains the source for current lineup and club-location history.
- Existing values in `games` remain club-managed. Reference matches are shown as evidence and link proposals; they never update a saved game automatically.

The public reference-data API at Kineticist supports lookup by OPDB ID and requires visible attribution whenever its data is displayed. The Game Editor's evidence panel therefore displays “Data provided by Kineticist” next to the source link. Kineticist lookup failures do not block edits or description work based on other verified evidence.

## OPDB archive flow

The weekly worker downloads `https://mp-data.sfo3.cdn.digitaloceanspaces.com/opdb-v2.json` and rejects redirects, non-JSON responses, invalid UTF-8/JSON, duplicate or malformed IDs, a missing `entries` array, invalid dates, too few IPDB mappings, oversized downloads, and a large drop from the previous successful record count.

The validated source bytes are stored under a unique path in the private `game-reference-archives` Storage bucket with a SHA-256 checksum. The worker writes a normalized exact-ID crosswalk in batches. Only after the complete crosswalk count matches the archive does one database transaction mark the snapshot successful and finish its Operations job. Failed or partial runs remain inactive; the last successful archive and crosswalk stay available. Archive objects use immutable timestamped names because Supabase Storage does not provide S3 object versioning.

OPDB IDs are matched exactly, including machine and alias components. The IPDB URL is generated only from the matching entry's numeric `ipdbId` as `https://www.ipdb.org/machine.cgi?id=<id>`. No title or edition guess is used to create an IPDB permalink.

## Schedule and Operations

The migration registers a weekly Sunday 09:00 UTC `pg_cron` job and the `opdb_reference_sync` Operations ledger entry. Operations → Integrations reports whether the Edge Function scheduler secret is configured; Operations → Jobs shows the last run, entry and mapping counts, archive size, and checksum. Club admins can also choose Run Now from that job card.

The staging deployment needs the following secrets:

- Edge Function secret `OPDB_REFERENCE_SYNC_SCHEDULER_SECRET`
- Vault secret `snh_opdb_reference_sync_scheduler_secret`, set to the same value
- The existing Vault secrets `snh_pinballmap_ingest_supabase_url` and `snh_pinballmap_ingest_anon_key`

The function is deployed with `verify_jwt = false` because the scheduled call has no user session; it independently checks the dedicated secret using a constant-time comparison. The Operations manual action first authenticates a club admin and calls the worker server-side. The service role key never leaves the Edge Function environment.

After the migration and function are deployed to staging, configure both scheduler secrets and run the job once from Operations. Confirm a successful job, a private archive object, and the new snapshot's entry count before relying on the next weekly run. No hosted migration, Edge Function deployment, or production change is part of the pull request.

## Existing data-file consumers

The tracked `data/latest-opdb.json` was a V1 maintenance copy. Its consumers were the offline enrichment script and one real-catalog assertion in the OPDB image test; it was not read by the public site, and the publish checks already excluded it. The script and tracked export are removed in favor of the private V2 archive. The image test now uses a small checked-in fixture, while the existing image sync continues to fetch the official V1 image export from its CDN URL. Pinball Map activity snapshots are unchanged.

## One-game proof

The staging catalog's `2001` record has OPDB ID `G48nw-M5RPZ`, IPDB ID `2697`, and an existing IPDB permalink ending in `id=2697`. The current V2 export has an exact `G48nw-M5RPZ` entry with IPDB ID `2697`. Kineticist accepts the same exact OPDB ID and returns the canonical permalink `https://www.kineticist.com/games/pinball/2001-dimension-galaxie`. The resolver uses those exact values and leaves the current saved URLs unchanged.
