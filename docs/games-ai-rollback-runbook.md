# Games AI Rollback Runbook

Use this when an AI-assisted apply introduced incorrect game data.

## Goal

Restore affected fields quickly without deleting unrelated edits.

## Preconditions

- Operator has `games_editor` (or higher) access and can open the Games editor.
- The saved game update has an audit entry in `public.audit_log` with module
  `games`, action `update`, and entity type `game`.
- The current game values have not been changed by a later edit, or the operator
  has reviewed those later changes before restoring anything.

## Fast Rollback Steps

1. Identify the saved update
   - In Operations → Audit log, find the `games` update for the affected game
     and time window.
   - Confirm that its `old_data` and `new_data` show the incorrect saved
     values.
   - An `ai_proposal` entry may provide context. Its `runId` is not a
     guaranteed link to the later save.

2. Confirm the current row
   - Open the game in Games Management and compare its current values with the
     audited `new_data`.
   - If any affected field has since changed, stop and resolve the later edit
     with the responsible operator.

3. Restore reviewed fields
   - Use the Games editor to restore the affected values shown in
     `old_data`. Supported fields include game description, release and
     manufacture year, manufacturer, machine type, display, player count, and
     provider links.
   - Save the correction through the editor so the normal authorization and
     audit path records it.
   - Do not assume that setting an empty description clears it. The current
     update RPC preserves the saved description when the submitted value is
     blank. If a correction requires clearing it, get a separately reviewed
     database correction.

4. Verify
   - Reload editor and public catalog row.
   - Confirm restored values and no unrelated fields changed.

5. Record outcome
   - Record the affected game IDs, audit entry IDs, corrected fields, and
     verification outcome in the incident record.

## Safety Notes

- Do not run blanket SQL updates against `games` without filtering by affected IDs.
- Prefer field-level restoration over full-record rewrites.
- Keep manual edit path available while AI propose is paused.
- **Images:** use the Images panel to change the normalized primary association or replace an uploaded club file. Game cards no longer resolve repository-hosted filename fallbacks.

## See also

- Current feature list and secrets: `docs/games-ai-assistant.md`
