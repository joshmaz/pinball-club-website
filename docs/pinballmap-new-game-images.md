# Automatic OPDB photos for newly imported games

Pinball Map imports now resolve newly created catalog games against OPDB's structured export, import the matched record's photos as approved, and choose a playfield photo as the default. If there is no playfield, OPDB's primary photo wins, then a stable source-key ordering. Source attribution and image-size variants are retained. `autoApprovedVia: pinballmap_new_game` records this import policy; `rightsReviewed` does not claim a separate human review.

Matching uses an exact supplied OPDB machine/alias ID or a unique IPDB identifier. A group ID limits the search to that group; it does not pick the first edition. Without identifiers, the normalized title, manufacturer and release year must all agree with exactly one entry. Only case and whitespace are normalized; edition names are preserved. Conflicting identifiers and ambiguous candidates are not approved. OPDB distinguishes group, machine and alias IDs: https://opdb.org/about.

Unmatched/ambiguous games and records without photos still enter the catalog, without guessed photos. Jobs records a review warning; the response's `newGameOpdb` lists the affected slugs. Use Games Editor to resolve these cases. No photos are borrowed from sibling editions or parent records. An exact supplied OPDB ID is accepted when the export has no IPDB field; a contradictory populated IPDB field must resolve within that ID's scope or remain unmatched.

New-game photo insertion and catalog creation share one database transaction. A provider outage or unusable export stops before catalog writes, leaving the new games eligible for the next scheduled/manual import; Jobs reports that no catalog changes were saved and to retry. A photo-write failure rolls back catalog changes. Existing-game-only runs retain the previous best-effort reference-only refresh. Existing games, slug conflicts, curated primary photos, and explicit legacy image filenames are preserved. Manual OPDB refresh still requires editor approval. This feature does not retroactively approve historical imports.

## Rollout

1. Apply `supabase/migrations/20261023050000_pinballmap_new_game_opdb_images.sql` to the intended Supabase project through the normal migration process.
2. Redeploy `pinballmap-ingest` with the updated `index.ts` and `_shared/opdb-images.ts`. The migration must precede the function so photos are not silently ignored by the old catalog RPC.
3. For the existing dashboard deployment with flat helper files, upload the updated shared helper as `opdb-images.ts` and keep the import path in `index.ts` mapped from `../_shared/opdb-images.ts` to `./opdb-images.ts`. Keep `merge.ts`, `auth.ts`, existing secrets and gateway settings with the function. No browser deployment is needed for this feature.

Staging uses project `eptbdrwmcwogxcjleudv`; choose the intended target explicitly. No migration or Edge deployment is performed by this pull request.

## Local verification

`node --test scripts/new-game-opdb.test.mjs scripts/opdb-images.test.mjs scripts/opdb-image-sync.test.mjs scripts/pinballmap-ingest-acceptance.test.mjs scripts/pinballmap-ingest-auth.test.mjs scripts/pinballmap-operations-db.test.mjs scripts/interactive-edge-auth.test.mjs`

Tests execute the actual matcher/handler and PostgreSQL migration in PGlite. They cover real exported IDs, ambiguous/conflicting matches, outage ordering, approved images, playfield preference, fallback/no-photo behavior, existing-game/default preservation, repeat imports, Operations counts and transaction rollback.
