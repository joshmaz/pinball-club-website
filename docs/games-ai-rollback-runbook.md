# Games AI Rollback Runbook

Use this when an AI-assisted apply introduced incorrect game data.

## Goal

Restore affected fields quickly without deleting unrelated edits.

## Preconditions

- Operator has `games_editor` (or higher) access.
- Audit entries exist in `public.audit_log` with action `ai_proposal` and normal game updates.

## Fast Rollback Steps

1. Identify the bad run
   - Find `audit_log` entries for module `games` around incident time.
   - Capture `runId` from metadata when present.

2. Identify affected game IDs
   - Filter audit entries by `entity_type = 'game'`.
   - Build a list of impacted IDs.

3. Restore only changed fields
   - For each game, compare `old_data` and `new_data`.
   - Apply corrective update through existing RPC path (`snh_games_upsert`) using previous values for:
     - `details`
     - `ipdbUrl`
     - `pinsideUrl`
     - `kineticistUrl`
     - `imageFilename`

4. Verify
   - Reload editor and public catalog row.
   - Confirm restored values and no unrelated fields changed.

5. Record outcome
   - Add an operator note in incident log with run ID and corrected game count.

## Safety Notes

- Do not run blanket SQL updates against `games` without filtering by affected IDs.
- Prefer field-level restoration over full-record rewrites.
- Keep manual edit path available while AI propose is paused.
- **Images:** `imageFilename` points at static `assets/images/machines/...` on the site. Roll back the filename field and replace or remove the file on the next deploy if a bad asset shipped.

## See also

- Current feature list and secrets: `docs/games-ai-assistant.md`
