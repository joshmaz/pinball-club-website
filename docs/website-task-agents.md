# Website Task Agents (Planning Note)

This note outlines how SNHPC can introduce focused agents that perform repeatable website maintenance tasks safely.

## Why agents here

Some tasks are structured, repetitive, and easy to validate:

- updating game listing content in `data/games.json`
- processing Pinball Map telemetry into normalized machine/location updates

Agentizing these tasks reduces manual drift while keeping humans in approval control.

## Core operating model

Each agent should run a consistent flow:

1. Read current source data (`data/*.json`, telemetry payloads, existing records).
2. Produce a proposed change set.
3. Validate against rules (schema, required fields, date normalization, URL checks).
4. Write through a controlled path (RPC/backend job), not arbitrary client-side edits.
5. Emit audit records using the shared audit log model.

## Agent 1: Game Listing Content Agent

Purpose:

- maintain and normalize records in the games catalog (title/details/images/links/stints)

Inputs:

- operator request (manual edit intent) or scheduled quality checks
- current `data/games.json`
- enrichment references (`data/latest-opdb.json`, known provider URL patterns)

Outputs:

- updated game record(s)
- validation report (what changed and why)
- audit event(s)

Recommended audit shape:

- `module`: `games`
- `action`: `create` | `update` | `retire` | `enrich`
- `entity_type`: `game`
- `entity_id`: stable game id or normalized title key
- `old_data`/`new_data`: changed fields only
- `metadata`: source (`manual-agent`), validator version, request id

Guardrails:

- require image filename to resolve in `assets/images/machines/` when provided
- normalize empty strings to null/omitted where appropriate
- reject invalid provider URLs
- reject date formats that are not ISO `YYYY-MM-DD`

## Agent 2: Pinball Map Telemetry Processor Agent

Purpose:

- ingest Pinball Map activity snapshots and convert them into lineup/location stint updates

Inputs:

- telemetry file(s) such as `data/pinballmap-location-*-activity.json`
- existing game stints in `data/games.json`

Outputs:

- proposed lineup deltas (added/removed machines, stint date adjustments)
- confidence flags for uncertain matches
- audit event(s)

Recommended audit shape:

- `module`: `pinballmap_ingest`
- `action`: `import` | `match` | `upsert_stint` | `close_stint`
- `entity_type`: `game_location_stint`
- `entity_id`: deterministic composite key (for example `game_key:location_id:start_date`)
- `old_data`/`new_data`: before/after stint payload
- `metadata`: telemetry file id, location id, match confidence, run id

Guardrails:

- never silently overwrite conflicting stint dates; mark conflict for review
- keep ingest idempotent by run id + source event ids
- isolate unmatched machines in a review queue

## Suggested implementation boundary

Prefer server-side orchestration over browser-triggered direct writes:

- Supabase Edge Function, backend worker, or privileged RPC entrypoint
- UI can request a run, review dry-run output, and approve apply
- all writes produce audit rows in the same transaction when possible

## Approval and rollout pattern

Start with "propose only" mode:

1. Agent generates diffs + validation report.
2. Human approves.
3. Apply changes through controlled writer.
4. Record audit entries.

After confidence grows, allow auto-apply for low-risk changes only (for example metadata enrichments), while keeping structural stint/date changes review-gated.

## Relationship to audit logging

These agents should be first-class producers of audit records using `docs/audit-logging-design.md`.

That creates a complete history of:

- who triggered a run
- what module/action occurred
- exactly which fields changed (old/new JSON payloads)
- which source telemetry or request initiated the change
