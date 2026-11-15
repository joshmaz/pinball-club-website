# Games AI enrichment assistant

Propose-only AI for the member **Games** catalog editor (`members.html`). Editors review suggestions and apply selected fields; nothing auto-writes without an explicit apply.

## Delivery status (done)

- [x] Edge Function `ai-game-enrich-propose` (JWT, `games_editor` / `games_admin` / `club_admin`, audit `ai_proposal`)
- [x] Description proposals: structured fields, existing `details`, OPDB archive facts, and Kineticist API description, tags, and credits when available; length guard (~220–320 chars), manufacturer + year in prose when metadata supports it, trim labels like `(Pro)` / `(LE)` in generated copy
- [x] Link proposals: IPDB search fallback; **Pinside** and **Kineticist** canonical-style URLs from `slug` + title + release year when derivable
- [x] Metadata proposals: suggest only missing manufacturer, manufacturer full name, machine type, display, and player count from OPDB/Kineticist structured evidence; explicitly apply into blank form fields before normal Save
- [x] Existing metadata review: compare populated supported fields, including release dates explicitly stated in Kineticist descriptions, against exact-ID OPDB/Kineticist records; show differences for review, never auto-replace or save
- [x] Catalog provenance: OPDB ID, match method, and canonical name are read-only integration data; third-party source URLs are grouped at the end of the metadata block
- [x] Portal: `SNHMemberPortal.aiGameEnrichPropose`, proposal UI with checkboxes, external link validation, **AI block under core game fields, above stints**
- [x] Combobox filter **Only at club today** (effective at-club: manual override, then map, then `atClub`)
- [x] Editor UX: collapsible `<details>` sections (location stints, for sale, owner link, high scores, mods, Pingolf) **collapsed by default**; Save/Cancel remain at bottom of form
- [x] Supporting docs: style guide, fixtures notes, rollback runbook, contract script under `scripts/`

## Not in scope yet (ideas)

- [ ] Optional external-image caching/derivative pipeline after reuse and hotlink policy is established; see `docs/game-images.md`
- [ ] Fixture-driven automated tests for every resolver edge case (see `games-ai-fixtures.md`)

## Operator setup

1. **Deploy function** (after code or secret changes):  
   `supabase functions deploy ai-game-enrich-propose`

2. **Secrets** (Supabase project → Edge Functions secrets):
   - `OPENAI_PLATFORM_KEY` or `LLM_API_KEY` (chat completions)
   - Optional: `LLM_PRIMARY_MODEL`, `LLM_SECONDARY_MODEL`

3. **Config**: `supabase/config.toml` sets `verify_jwt = true` for this function.

## Reference sources and link confirmation

A Games Editor can edit the catalog's provider URLs. Enrichment does not fetch
HTML pages from IPDB, Pinside, or Kineticist. Link candidates use the validated
OPDB archive and exact IPDB crosswalk, the Kineticist game API response, and safe
catalog slug patterns. The evidence panel shows the OPDB and Kineticist records
that were used; it does not report blocked page reads. Editors can open a proposed
link and confirm it manually. The confirmation is scoped to the current editing
session and does not make the page text available to enrichment.

Metadata suggestions use only the validated OPDB archive and cached Kineticist
game API response (including credits). Operator notes are only used for
description drafts and are limited to 5,000 characters. Existing metadata review
compares supported fields with exact-ID OPDB/Kineticist records; release date
checks accept month and year only when Kineticist description text explicitly
states a release date, and use the first of that month as a date-field candidate.
Stale Kineticist data is excluded. A difference is a
review suggestion, not an assertion that the catalog value is wrong. Conflicting
sources are surfaced without choosing a value. Kineticist description text is stripped to plain text,
attributed, treated as untrusted evidence, and paraphrased rather than copied.
No enrichment suggestion is saved automatically.

The Edge Function must be deployed separately to the intended Supabase project.
A Netlify preview or Git branch merge alone does not update it. No database
migration or new secret is required for these source-read changes.

Regression tests: `scripts/ai-reference-fetch.test.mjs` covers canonical provider
URL validation, structured source evidence, and safe description context.
`scripts/ai-game-enrich-auth.test.mjs` separately exercises the actual request
handler and canonical SQL role boundary before protected work.

## Editor workflow (short)

1. Open a saved game and choose **Find or verify source links**. Existing URLs stay in place; generated candidates are shown for operator review and never saved automatically.
2. Open the evidence details to review the registered OPDB and Kineticist records. OPDB/Kineticist data is resolved by ID. Edit a proposed URL directly, open it, and confirm the exact machine page before applying it; the site does not fetch provider pages.
3. In **Game metadata**, choose **Suggest missing metadata** to fill blank supported fields from the OPDB/Kineticist catalog records. Operator notes are not used for metadata. Existing values are left alone.
4. In **Game metadata**, choose **Check existing metadata** to compare populated supported fields with OPDB/Kineticist values. The checker also recognizes an explicit release month and year in the exact Kineticist description; because the editor stores a full date, it presents the first of that month and explains the day is unspecified. Review any current-versus-suggested differences, select only the updates you want, then apply them to the form. Both actions require a separate **Save game** to persist changes.
5. OPDB ID, match method, and canonical name are imported integration data and are read-only in this editor. Third-party source URLs appear at the end of the metadata block.
6. Choose **Draft our description** for two editable options grounded in the attributed Kineticist description/credits when available, operator notes, or specific existing catalog copy. **Include current Description text (including unsaved edits)** is checked by default. The collapsed **Draft options** controls select Short, Standard (default), or Expanded length and Club voice (default), Friendly with gentle wit, or More energetic voice. The server enforces the selected maximum; evidence and factuality rules stay the same. Clear the description checkbox to draft without that text. Kineticist text is evidence and is paraphrased; it is not stored verbatim as our editable description. If evidence is thin, the assistant reports that instead of writing generic copy.
7. Add gameplay fragments or rough copy to **Description notes** (up to 5,000 characters) when source coverage is thin, then choose **Draft our description**. **Use this draft** copies an option into the regular description field; review it there and use **Save game** to persist it.

The short card target remains roughly 220–320 characters. Include manufacturer, release year, and a designer only when supported by verified catalog/source evidence. The public Games page is unchanged.

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
