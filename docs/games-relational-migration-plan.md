# Games Catalog Relational Migration Plan

This document tracks moving the games catalog from `data/games.json` into Supabase while keeping the public site and Pinball Map ingest working.

## Current status (where we are)

**Phase 2 is implemented in-repo:** migrations (see below), `games_catalog_v1`, member editor RPCs, public read toggle (`GAMES_CATALOG_SOURCE` / `gamesCatalogSource`), Pinball Map Edge ingest (`pinballmap-ingest`), JSON import and DB→JSON export scripts, and docs/README/CI wiring.

**Production:** The hosted site reads the catalog from Supabase (`games_catalog_v1` / `GAMES_CATALOG_SOURCE=db`).

**Phase 3 sequencing:** **Near-term** — extended catalog data (high scores, Pingolf, club issues) and **game owners / parties** (see [Phase 3 (future)](#phase-3-future)). **Parked (later)** — Edge **editor-assistant** work (AI description drafts, resource-link search as propose-only flows); pick up after extended data + owners unless priorities change.

**Intentionally not in Phase 2:** game **owners / parties** — no legacy owner data was migrated from JSON; direction is under [Game owners / parties](#game-owners--parties) in Phase 3.

**Operational checklist** (per environment): apply migrations (`supabase db push`), run one-shot import if needed, deploy Edge function + secrets + cron, set GitHub secret `GAMES_CATALOG_SOURCE=db` when the hosted project is ready, regenerate `assets/js/config.js` via deploy. (Prod cutover for this club is complete; the checklist below remains for other environments or re-validation.)

**Follow-up delivered after Phase 2:** game soft-delete + restore. Deleted games are excluded from `games_catalog_v1` (public), while member editor still shows them with delete metadata and restore controls.

## Implemented (Phase 2 baseline)

### Database (migrations)

Games catalog DDL and RPCs are split across four migrations (apply in timestamp order via `supabase db push`):

| Migration | Role |
|-----------|------|
| [`20260501103000_games_catalog.sql`](../supabase/migrations/20260501103000_games_catalog.sql) | Tables, initial `games_catalog_v1`, audit helper, core editor RPCs, `snh_games_import_from_json`, `snh_pinballmap_upsert_from_activity` |
| [`20260501124500_games_create_rpc.sql`](../supabase/migrations/20260501124500_games_create_rpc.sql) | `snh_games_create` |
| [`20260505135500_games_soft_delete.sql`](../supabase/migrations/20260505135500_games_soft_delete.sql) | Soft-delete columns, `games_catalog_v1` revision (non-deleted rows only), `snh_games_soft_delete` / `snh_games_restore`, updated `snh_games_editor_load` |
| [`20260506120000_pinballmap_ignore_soft_deleted_games.sql`](../supabase/migrations/20260506120000_pinballmap_ignore_soft_deleted_games.sql) | `snh_pinballmap_upsert_from_activity` — updates (and create slug fallback) ignore soft-deleted `games` rows |

- **Tables:** `public.games`, `public.game_location_stints`, `public.game_sale_listings`
- **Audit:** `public.audit_log` (append-only; writes from SECURITY DEFINER RPCs)
- **Public read:** view `public.games_catalog_v1` — one row per game, column `game` (`jsonb`) matches the legacy `games.json` object shape (camelCase, including derived `sortKey*` on stints).
- **Floor fields:** `map_at_club`, `manual_at_club_override`, `manual_at_club_note`; effective floor for the view is `coalesce(manual_at_club_override, map_at_club)` surfaced as `atClub` in the `game` JSON.

### RPCs (authenticated unless noted)

| RPC | Purpose |
|-----|---------|
| `snh_games_editor_load()` | Full editor payload (`games[]` with camelCase `locationStints`). |
| `snh_games_create(p_fields jsonb)` | Insert a new game row from camelCase fields (same editor RBAC as upsert). |
| `snh_games_upsert(p_game_id, p_fields jsonb)` | Update core metadata / URLs / OPDB / dates (camelCase keys in `p_fields`). |
| `snh_games_upsert_stint(p_game_id, p_stint jsonb)` | Insert or update a stint (`id` optional). |
| `snh_games_delete_stint(p_stint_id)` | Admin-only stint delete. |
| `snh_games_set_manual_at_club(p_game_id, p_override, p_note)` | Set boolean override + note. |
| `snh_games_clear_manual_at_club(p_game_id)` | Clear override (follow map). |
| `snh_games_soft_delete(p_game_id, p_note)` | Admin-only soft-delete; hides from public catalog. |
| `snh_games_restore(p_game_id)` | Admin-only restore of a soft-deleted game. |
| `snh_games_get_sale_listing` / `snh_games_set_sale_listing` | Read / upsert latest sale row for a game. |
| `snh_games_import_from_json(p_json)` | **service_role** — bulk import `{ games: [...] }` (replaces stints per game). |
| `snh_pinballmap_upsert_from_activity(p_payload)` | **service_role** — applies Edge merge output (`updates` + `creates`); **updates** match only rows with `deleted_at is null`; create slug fallback does not attach stints to soft-deleted rows. |

### Public site (`games.html`)

- Loads `assets/js/config.js`, Supabase UMD, `supabase-init.js`, then `games.js`.
- When `window.SNH_CONFIG.gamesCatalogSource === 'db'`, [`assets/js/games.js`](../assets/js/games.js) reads `games_catalog_v1` via the anon client. Otherwise it keeps using `data/games.json`.
- `scripts/write-config.mjs` emits `gamesCatalogSource` from env `GAMES_CATALOG_SOURCE` (`json` default, or `db`).

### Member portal editor

- [`assets/js/member-games-panel.js`](../assets/js/member-games-panel.js) — games editor UI (metadata, stints, manual override, sale).
- [`assets/js/member-portal.js`](../assets/js/member-portal.js) — RPC wrappers (`gamesEditorLoad`, `gamesUpsert`, …).
- Requires `games_editor`, `games_admin`, or `club_admin` (same as existing RBAC).

### Import script

- [`scripts/import-games-json.mjs`](../scripts/import-games-json.mjs) — POST to `snh_games_import_from_json` with service role key.

### Export script (JSON fallback refresh)

- [`scripts/export-games-json-from-supabase.mjs`](../scripts/export-games-json-from-supabase.mjs) — reads `games_catalog_v1`, writes `data/games.json` for static/`json` mode or rollback snapshots.

### Pinball Map Edge Function

- [`supabase/functions/pinballmap-ingest/index.ts`](../supabase/functions/pinballmap-ingest/index.ts) + [`merge.ts`](../supabase/functions/pinballmap-ingest/merge.ts)
- Fetches paginated `user_submissions`, loads current `games` + `game_location_stints`, builds `{ location_id, location_address, updates, creates }`, calls `snh_pinballmap_upsert_from_activity`.
- [`supabase/config.toml`](../supabase/config.toml) — `verify_jwt = false` for scheduled/service invokes.

**Schedule:** In Supabase Dashboard → Edge Functions → `pinballmap-ingest` → add a cron schedule (e.g. daily). Set secrets: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, optional `PINBALLMAP_LOCATION_ID` (default `8908`), optional `PINBALLMAP_ACTIVITY_URL`.

### CI / deploy

- Optional GitHub Actions secret `GAMES_CATALOG_SOURCE` (e.g. `db` after cutover). See [`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml).

## Phase 1 (JSON file pipeline)

Compatibility fields on `data/games.json` (`mapAtClub`, `manualAtClubOverride`, resolved `atClub`) remain supported for static-json mode and for the Python merge script until you fully switch ingest to the Edge path.

## Phase 3 (future)

### Near-term: extended catalog data

Ship first when scoped (tables + RPCs + portal/public surfaces as product rules dictate):

- **High scores** — persistence model and who may read/write.
- **Pingolf targets** — link to games and events as needed.
- **Club issues** — machine-linked or general club ops issues per your workflow.

Implementation is intentionally incremental; track migrations and RLS with the same patterns as the games catalog.

### Game owners / parties

**Scope:** represent who “owns” or is associated with a machine (member-linked or free-text), for the member portal and optional public display — **not** shipped in Phase 2; **no** import of any historical owner blobs from `data/games.json`.

**Proposed direction (for a later migration):**

- **Tables** (sketch): e.g. `game_parties` or `game_owners` with `game_id`, optional `member_id` FK to `public.members`, display name fallback, role/relationship enum (owner, co-owner, donor, on-loan, etc.), optional start/end dates and notes.
- **Writes:** SECURITY DEFINER RPCs gated like other games editor RPCs (`games_editor` / `games_admin` / `club_admin`), with `private.snh_audit_game` (or sibling) in the same transaction.
- **Reads:** optional inclusion in `games_catalog_v1` or a separate editor-only RPC payload so the public site only exposes what policy allows.
- **RLS:** no broad anon table access; prefer RPCs or a narrow view.

Revisit when product rules are clear (public names vs. members-only, edit permissions, and whether multiple concurrent parties per game are required).

### Later (parked): Edge editor-assistant

**Not** in the same delivery wave as extended data + owners:

- AI description drafts and resource-link search as **propose-only** Edge flows (operator accepts edits in the portal).
- Pick up after Phase 3 near-term work is underway or shipped; reference your separate project notes when this becomes active.

## Morning quick-win checklist

Ship the relational catalog cutover prerequisites in one focused pass:

- [x] Apply hosted migration: `supabase db push`
- [x] Import catalog seed: `node --env-file=.env scripts/import-games-json.mjs`
- [x] Deploy `pinballmap-ingest`, set required secrets, and add daily cron
- [x] Verify `games_catalog_v1` rows in Supabase SQL/Table Editor
- [x] Set `GAMES_CATALOG_SOURCE=db` (local + GitHub Actions)
- [x] Regenerate deploy config: `node scripts/write-config.mjs`
- [x] Deploy site and spot-check `games.html`

### Definition of done

- Public `games.html` loads from `games_catalog_v1` without regression.
- Member games editor reads/writes through RPCs as expected.
- Pinball Map ingest runs on schedule and records successful upserts.

## Rollback checklist

1. Set `GAMES_CATALOG_SOURCE=json`.
2. Regenerate `assets/js/config.js` via `node scripts/write-config.mjs`.
3. Redeploy site.
4. If needed, refresh JSON snapshot from DB using `scripts/export-games-json-from-supabase.mjs`.

## Notes

- Sort keys on stints remain **derived** in the view (same rules as `assets/js/games.js`).
- Never expose `SUPABASE_SERVICE_ROLE_KEY` in the browser or in Actions for public PRs from forks.
- Operator restore path: use member games editor "Restore game" action (admin roles) or call `snh_games_restore(p_game_id)` from SQL when needed.
- **JSON export / soft-delete:** `export-games-json-from-supabase.mjs` reads `games_catalog_v1` only, so soft-deleted games are **not** written to `data/games.json`. Full backups that include deleted rows need another approach (e.g. query `games` with service role, or restore then export).
- **Pinball Map ingest / soft-delete:** `snh_pinballmap_upsert_from_activity` (see [`20260506120000_pinballmap_ignore_soft_deleted_games.sql`](../supabase/migrations/20260506120000_pinballmap_ignore_soft_deleted_games.sql)) **does not** apply **updates** to soft-deleted games (`deleted_at is null` required for slug/title match). The **creates** path still inserts new rows; if `on conflict (slug) do nothing` hits an existing row, stint inserts attach only when the resolved row is **not** soft-deleted. Reactivating a slug that exists only on a soft-deleted row may require a manual restore or slug change (unique constraint).
