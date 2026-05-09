# Games AI enrichment assistant

Propose-only AI for the member **Games** catalog editor (`members.html`). Editors review suggestions and apply selected fields; nothing auto-writes without an explicit apply.

## Delivery status (done)

- [x] Edge Function `ai-game-enrich-propose` (JWT, `games_editor` / `games_admin` / `club_admin`, audit `ai_proposal`)
- [x] Description proposals: structured fields, existing `details`, OPDB/Pinside/IPDB **research snippets** (HTML fetch where possible), length guard (~140–220 chars), manufacturer + year in prose when metadata supports it, trim labels like `(Pro)` / `(LE)` in generated copy
- [x] Link proposals: IPDB search fallback; **Pinside** and **Kineticist** canonical-style URLs from `slug` + title + release year when derivable
- [x] Image candidates: club `image_filename` preview; **OPDB** artwork via `OPDB_API_TOKEN` (playfield-preferring heuristics, resolution dedupe); attribution copy in UI
- [x] Portal: `SNHMemberPortal.aiGameEnrichPropose`, proposal UI with checkboxes, external link validation, **AI block under core game fields, above stints**
- [x] Combobox filter **Only at club today** (effective at-club: manual override, then map, then `atClub`)
- [x] Editor UX: collapsible `<details>` sections (location stints, for sale, owner link, high scores, mods, Pingolf) **collapsed by default**; Save/Cancel remain at bottom of form
- [x] Supporting docs: style guide, fixtures notes, rollback runbook, contract script under `scripts/`

## Not in scope yet (ideas)

- [ ] Auto-download OPDB (or other) images into repo or Storage; **`image_filename` stays a manual club-hosted path**
- [ ] Structured field proposals (type, display, player count) from AI
- [ ] Fixture-driven automated tests for every resolver edge case (see `games-ai-fixtures.md`)

## Operator setup

1. **Deploy function** (after code or secret changes):  
   `supabase functions deploy ai-game-enrich-propose`

2. **Secrets** (Supabase project → Edge Functions secrets):
   - `OPENAI_PLATFORM_KEY` or `LLM_API_KEY` (chat completions)
   - Optional: `LLM_PRIMARY_MODEL`, `LLM_SECONDARY_MODEL`
   - Optional: `OPDB_API_TOKEN` for image previews (from [opdb.org](https://opdb.org) account)

3. **Config**: `supabase/config.toml` sets `verify_jwt = true` for this function.

## Editor workflow (short)

1. Open a game → **AI refresh current game** (or regenerate description / image candidates where offered).
2. Review fields; use **Open in new tab** links to validate URLs.
3. **Apply selected fields** only for rows you trust; image **previews** do not upload files. To use an OPDB shot: save the file under `assets/images/machines/`, deploy, set **Image filename**, save the game, add credit (e.g. in More info).
4. Rollback mistakes: `docs/games-ai-rollback-runbook.md`.

## Related files

| Area | Location |
|------|----------|
| Function | `supabase/functions/ai-game-enrich-propose/index.ts` |
| Portal client | `assets/js/member-portal.js` (`aiGameEnrichPropose`) |
| Games panel UI | `assets/js/member-games-panel.js` |
| Styles | `assets/css/styles.css` (AI + collapsible blocks) |
| Proposal contract | `scripts/ai-enrichment-contract.mjs` |
| Description style | `docs/games-ai-description-style-guide.md` |
| Resolver fixtures (aspirational) | `docs/games-ai-fixtures.md` |
| Rollback | `docs/games-ai-rollback-runbook.md` |
