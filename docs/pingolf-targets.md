# Pingolf targets

Pingolf is a curated library of objectives belonging directly to games. Each game
has up to ten targets and at most one preferred target. Tournament operation stays
with external platforms.

## Model and permissions

`pingolf_targets` contains `id`, `game_id`, `target_type`, `description`,
`score_threshold`, `is_preferred`, `notes`, `created_at`, and `updated_at`.
Types are `score`, `feature`, `progression`, and `hybrid`. The description defines
the objective. A score threshold is optional and must be a positive PostgreSQL
`bigint` when supplied. RPCs return thresholds as decimal strings to avoid losing
precision in JavaScript. Notes are internal and excluded from public responses.

Games Editors can list, add, edit, and select or clear a preferred target.
Games Admins and Club Admins can also permanently delete targets. This follows the
website policy reserving permanent deletion for Admins. Direct client table writes
remain blocked by RLS. Every RPC checks backend authorization independently.

All mutations lock the parent game before checking editability and changing targets.
This serializes target counts and preferred selection for a game. A partial unique
index independently enforces preferred uniqueness. Updates still work at ten targets.
Changing preferred target audits both the previous and new preferred records.
Create/update/delete audit entries identify the actual target UUID and record old/new
state. Deleting a preferred target does not select a replacement.

Soft deletion retains targets, hides them from public game detail, and blocks target
maintenance until the game is restored. Physical game deletion cascades to targets.

## Production inspection and migration decision

Read-only inspection on September 29, 2026 found one session and one target:

- Featured session `185d2d03-23fd-4024-85c2-6be0a8ae07ca`, with no linked event.
- Target `cb70ea63-d776-4785-81a0-a6e2eb51719e` belongs to game
  `4994ffc3-30ec-4d9b-9f5c-8ff3909ca7c6`.
- Description: “Start a Road Kings Multiball”; legacy `target_value`: `1`.
- No duplicates, over-limit games, or competing featured targets existed.
- REST row fields matched the repository's legacy model. Linked migration history
  matched repository migrations through `20260928170000`.

The user explicitly waived preservation of that target. Migration
`20260928180000_pingolf_game_targets.sql` removes it and starts with an empty library.
The migration aborts if additional targets exist or the reviewed target's game,
description, or value has changed. It locks both legacy tables during the transition.
There is no heuristic classification or numeric backfill.

The migration replaces the target RPCs and public game detail function, then drops
session RPCs, the target's session/value/order columns, and the session table. The
session table's event FK disappears; event records remain untouched. Historical
audit entries remain intact. No session replacement is introduced.

## Deployment

This change requires a coordinated database and static-site release because the
target RPC argument lists change. Schedule the release when target editors are idle,
apply the forward migration, then publish the matching assets. Editors with an old
page must reload. Public responses remain compatible with old display code, though
the old UI will not show new preferred/type metadata.

Before deployment, recheck legacy rows and linked migration history. If the guard
fails, inspect the changed data and update the reviewed migration decision before
retrying. Do not remove the guard merely to force the migration through.

Run `node --test scripts/pingolf-db.test.mjs scripts/pingolf-ui.test.mjs` and the
repository regression suite (`node --experimental-strip-types --test --test-concurrency=2 scripts/*.test.mjs`).
After deployment, verify target creation/editing,
preferred selection, admin deletion, and the public Play information for a game.
The local tests use PostgreSQL through PGlite; they do not simulate concurrent
database connections. Concurrency protection comes from the shared parent-row lock
and unique index and should also be smoke-tested on staging.
