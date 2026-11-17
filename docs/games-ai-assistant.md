# Games AI enrichment assistant

Propose-only AI for the member **Games** catalog editor (`members.html`). Editors review suggestions and apply selected fields; nothing auto-writes without an explicit apply.

## Delivery status (done)

- [x] Edge Function `ai-game-enrich-propose` (JWT, `games_editor` / `games_admin` / `club_admin`, audit `ai_proposal`)
- [x] Description proposals: structured fields, existing `details`, OPDB and IPDB archive facts, and Kineticist API description, tags, and credits when available; length guard (~220–320 chars), manufacturer + year in prose when metadata supports it, trim labels like `(Pro)` / `(LE)` in generated copy
- [x] Link proposals: IPDB search fallback; **Pinside** and **Kineticist** canonical-style URLs from `slug` + title + release year when derivable
- [x] Metadata check: one action suggests missing manufacturer, manufacturer full name, machine type, display, and player count, and suggests a missing release date when Kineticist explicitly states its month and year; it also compares populated supported fields with exact-ID OPDB/IPDB/Kineticist records; IPDB manufacture dates remain separate from release dates; apply reviewed values into the form before normal Save
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

## Reference sources and link review

A Games Editor can edit the catalog's provider URLs. Enrichment does not fetch
HTML pages from IPDB, Pinside, or Kineticist. Link candidates use the validated
OPDB archive and exact IPDB crosswalk, the validated IPDB JSON archive, the Kineticist game API response, and safe
catalog slug patterns. The evidence panel shows the OPDB, IPDB, and Kineticist records
that were used; it does not report blocked page reads. Editors can open and review
a proposed link before copying it into the game record. The site does not fetch
the linked page or use its text.

Metadata suggestions use the validated OPDB and IPDB archives and cached Kineticist
game API response (including credits). IPDB records are resolved by exact saved IPDB ID or the exact OPDB crosswalk; conflicts between those IDs omit the IPDB record. IPDB manufacture dates are compared only with the manufacture-date field, never treated as release dates. Operator notes are only used for
description drafts and are limited to 5,000 characters. Existing metadata review
compares supported fields with exact-ID OPDB/IPDB/Kineticist records. The IPDB source refresh date appears in its evidence and data more than 45 days old is flagged for review. For a
blank release date, an explicit release month and year can produce a
review-only suggestion. A production month can also be shown as a
lower-confidence candidate, clearly labeled as production timing because
that may differ from release timing. If its month conflicts with OPDB's
manufacture date, the OPDB date is included in the review reason and
confidence is lowered. When Kineticist supplies only a manufacture year, the
assistant can offer a low-confidence January 1 placeholder for review, with
an explanation that no release month or day is known and January 1 does not
represent a confirmed release date.
Stale Kineticist data is excluded. A difference is a
review suggestion, not an assertion that the catalog value is wrong. Other
conflicting metadata sources are surfaced without choosing a value. Kineticist description text is stripped to plain text,
attributed, treated as untrusted evidence, and paraphrased rather than copied.
No enrichment suggestion is saved automatically.

The Edge Function must be deployed separately to the intended Supabase project.
A Netlify preview or Git branch merge alone does not update it. The IPDB source
adds a database migration, a scheduled reference-sync Edge Function, and the
`IPDB_REFERENCE_SYNC_SCHEDULER_SECRET` Edge Function/Vault secret.

Regression tests: `scripts/ai-reference-fetch.test.mjs` covers canonical provider
URL validation, structured source evidence, and safe description context.
`scripts/ai-game-enrich-auth.test.mjs` separately exercises the actual request
handler and canonical SQL role boundary before protected work.

## Editor workflow (short)

1. Open a saved game and choose **Find or verify source links**. Existing URLs stay in place; generated candidates are shown for operator review. **Copy selected links to fields** places them in the URL fields above; use **Save game** to persist them.
2. Open the evidence details to review the registered OPDB, IPDB, and Kineticist records. Catalog data is resolved by ID. Review any proposed URL before copying it into a field; the site does not fetch provider pages.
3. In **Game metadata**, choose **Check metadata** to check existing values against OPDB/IPDB/Kineticist records and suggest supported values for blank fields in the same result. IPDB's date of manufacture can support the manufacture-date field, not the release date. An explicit release month and year in the exact Kineticist description can produce a suggestion when the release date is blank, or a review recommendation when it differs from an existing date. A production month is shown as a lower-confidence candidate with a note that production timing may differ from release timing. Because the editor stores a full date, the first of that month is proposed and the unspecified day is explained. Select the updates or missing values you want, apply them to the form, then use **Save game** to persist changes. Operator notes are not used for metadata.
4. In Operations → Jobs, review the IPDB archive's last check, embedded source refresh date, record count, and freshness warning. **Check for updates** downloads and indexes the JSON only if its ETag changed.
5. OPDB ID, match method, and canonical name are imported integration data and are read-only in this editor. Third-party source URLs appear at the end of the metadata block.
6. Choose **Draft our description** for two editable options grounded in the attributed Kineticist description/credits when available, IPDB features/notes, operator notes, or specific existing catalog copy. Catalog records provide the original game's identity and history; operator notes are primary evidence about the club's specific unit, including installed upgrades, added features, modifications, condition, and observed gameplay. Both drafts are revised in a final coverage pass so they include relevant operator facts while keeping local details scoped to the club's machine. **Include current Description text (including unsaved edits)** is checked by default. The collapsed **Draft options** controls select Short, Standard (default), or Expanded length and Club voice (default), Friendly with gentle wit, or More energetic voice. The server enforces the selected maximum; evidence and factuality rules stay the same. Clear the description checkbox to draft without that text. Kineticist and IPDB text are evidence and are paraphrased; they are not stored verbatim as our editable description. If evidence is thin, the assistant reports that instead of writing generic copy.
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
