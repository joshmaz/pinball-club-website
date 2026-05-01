# Games Catalog Relational Migration Plan

This document tracks moving the games catalog from `data/games.json` into Supabase while keeping the public site and Pinball Map ingest working.

## Implemented (Phase 2 baseline)

### Database (migration)

Single migration: [`supabase/migrations/20260501103000_games_catalog.sql`](../supabase/migrations/20260501103000_games_catalog.sql)

- **Tables:** `public.games`, `public.game_location_stints`, `public.game_sale_listings`
- **Audit:** `public.audit_log` (append-only; writes from SECURITY DEFINER RPCs)
- **Public read:** view `public.games_catalog_v1` — one row per game, column `game` (`jsonb`) matches the legacy `games.json` object shape (camelCase, including derived `sortKey*` on stints).
- **Floor fields:** `map_at_club`, `manual_at_club_override`, `manual_at_club_note`; effective floor for the view is `coalesce(manual_at_club_override, map_at_club)` surfaced as `atClub` in the `game` JSON.

### RPCs (authenticated unless noted)

| RPC | Purpose |
|-----|---------|
| `snh_games_editor_load()` | Full editor payload (`games[]` with camelCase `locationStints`). |
| `snh_games_upsert(p_game_id, p_fields jsonb)` | Update core metadata / URLs / OPDB / dates (camelCase keys in `p_fields`). |
| `snh_games_upsert_stint(p_game_id, p_stint jsonb)` | Insert or update a stint (`id` optional). |
| `snh_games_delete_stint(p_stint_id)` | Admin-only stint delete. |
| `snh_games_set_manual_at_club(p_game_id, p_override, p_note)` | Set boolean override + note. |
| `snh_games_clear_manual_at_club(p_game_id)` | Clear override (follow map). |
| `snh_games_get_sale_listing` / `snh_games_set_sale_listing` | Read / upsert latest sale row for a game. |
| `snh_games_import_from_json(p_json)` | **service_role** — bulk import `{ games: [...] }` (replaces stints per game). |
| `snh_pinballmap_upsert_from_activity(p_payload)` | **service_role** — applies Edge merge output (`updates` + `creates`). |

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

- Owners / parties, high scores, Pingolf targets, issues — add tables + RPCs when needed.
- AI description drafts + resource-link search (propose-only) — Edge Functions; see project plan file.

## Rollout checklist

1. `supabase db push` (or apply migration on hosted project).
2. `node --env-file=.env scripts/import-games-json.mjs`
3. Deploy Edge Function `pinballmap-ingest`; set secrets; add cron.
4. Set `GAMES_CATALOG_SOURCE=db` locally and in GitHub Actions after verifying `games_catalog_v1` in SQL/Table Editor.
5. Regenerate `assets/js/config.js` (`node scripts/write-config.mjs`) and deploy site.

## Notes

- Sort keys on stints remain **derived** in the view (same rules as `assets/js/games.js`).
- Never expose `SUPABASE_SERVICE_ROLE_KEY` in the browser or in Actions for public PRs from forks.
