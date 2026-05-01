# Games Catalog Relational Migration Plan

This plan moves the games catalog from `data/games.json` to a relational model
without breaking the current UI or Pinball Map ingest flow.

## Goals

- Preserve all fields currently represented in `games.json`.
- Support manual "at club" overrides when Pinball Map coverage is incomplete.
- Add room for ownership, scores, Pingolf targets, issues, and sale status.
- Roll out incrementally with low risk.

## Phase 1 (now): compatibility layer in JSON pipeline

Add and preserve three fields per game:

- `mapAtClub` - floor status derived from Pinball Map ingest.
- `manualAtClubOverride` - optional editor override (`true` / `false` / omitted).
- `atClub` - effective value used by UI.

Resolution rule:

`atClub = manualAtClubOverride ?? mapAtClub ?? atClub_legacy_default_false`

This keeps existing front-end code and CSS behavior working while introducing
manual control where map data is missing.

## Phase 2: introduce relational source of truth

Create tables in Supabase/Postgres:

### `games`

- `id uuid primary key default gen_random_uuid()`
- `slug text not null unique` (stable key for URLs/references)
- `title text not null`
- `details text`
- `image_filename text`
- `release_date date`
- `manufacture_date date`
- `manufacturer text`
- `manufacturer_full_name text`
- `machine_type text` (maps from `type`)
- `display_type text` (maps from `display`)
- `player_count smallint`
- `pinside_url text`
- `ipdb_url text`
- `kineticist_url text`
- `opdb_id text`
- `opdb_matched_via text`
- `opdb_canonical_name text`
- `map_at_club boolean not null default false`
- `manual_at_club_override boolean null`
- `effective_at_club boolean generated always as (coalesce(manual_at_club_override, map_at_club)) stored`
- `created_at timestamptz not null default now()`
- `updated_at timestamptz not null default now()`

### `game_location_stints`

- `id uuid primary key default gen_random_uuid()`
- `game_id uuid not null references games(id) on delete cascade`
- `address text not null`
- `pinball_map_location_id integer`
- `pinball_map_machine_id integer`
- `joined_club_date date`
- `left_club_date date`
- `date_unknown boolean not null default false`
- `sort_key_joined date` (optional: generated in query/view instead)
- `sort_key_left date` (optional: generated in query/view instead)
- `created_at timestamptz not null default now()`
- `updated_at timestamptz not null default now()`

Recommended constraints:

- `check (joined_club_date is null or left_club_date is null or joined_club_date <= left_club_date)`
- unique-ish ingest guard: `(pinball_map_location_id, pinball_map_machine_id, joined_club_date)` where not null

## Phase 3: feature tables

### Owners

- `parties` (member-linked or external)
- `game_ownerships` (`game_id`, `party_id`, role, start/end)

### High scores

- `game_high_scores` (`game_id`, score, member_id or player_name, recorded_at, notes)

### Pingolf targets

- `pingolf_targets` (`game_id`, course_key or event_id, hole_number, target_score, active range)

### Issues / tech queue

- `game_issues` (`game_id`, status, severity, opened_by, assigned_to, opened_at, closed_at, details)

### For sale

- `game_sale_listings` (`game_id`, asking_price_cents, status, listed_at, sold_at, notes)

## Rollout sequence

1. Add relational tables + RLS policies.
2. Import `data/games.json` into DB via one-shot script.
3. Keep public site shape stable by serving a DB-backed JSON payload that matches current schema.
4. Update Pinball Map merge to write through RPC/Edge Function to DB.
5. Keep `data/games.json` as build artifact (optional) until fully cut over.

## RLS outline

- Public: read-only access to catalog view/API payload.
- Editors (`games_editor`, `games_admin`, `club_admin`): write access through
  security-definer RPCs or Edge Function policy checks.
- Ingest: service role or trusted backend only.

## Notes

- Treat `sortKeyJoined` / `sortKeyLeft` as derived editorial fields, not factual history.
- Preserve auditability for all edits and ingest runs using the existing audit logging direction.
