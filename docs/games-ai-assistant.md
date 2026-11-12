# Games AI enrichment assistant

Propose-only AI for the member **Games** catalog editor (`members.html`). Editors review suggestions and apply selected fields; nothing auto-writes without an explicit apply.

## Delivery status (done)

- [x] Edge Function `ai-game-enrich-propose` (JWT, `games_editor` / `games_admin` / `club_admin`, audit `ai_proposal`)
- [x] Description proposals: structured fields, existing `details`, IPDB/Pinside/Kineticist **research snippets** (HTML fetch where possible), length guard (~220–320 chars), manufacturer + year in prose when metadata supports it, trim labels like `(Pro)` / `(LE)` in generated copy
- [x] Link proposals: IPDB search fallback; **Pinside** and **Kineticist** canonical-style URLs from `slug` + title + release year when derivable
- [x] Metadata proposals: extract only missing manufacturer, manufacturer full name, machine type, display, and player count from verified source excerpts; review and explicitly apply suggestions into blank form fields before normal Save
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

## Reference-fetch security boundary

A Games Editor can edit the catalog's provider URLs. The enrichment function treats
those saved values as untrusted when fetching research snippets, even if they were
saved through the direct API. Each field permits only its existing canonical HTTPS
host: IPDB → `www.ipdb.org`, Pinside → `pinside.com`, Kineticist →
`www.kineticist.com`. These exact hosts match the catalog snapshot and the function's
link generators; arbitrary subdomains and apex/www aliases are not assumed safe.

The outbound fetch rejects credentials, explicit ports (including `:443`), HTTP,
IP addresses, encoded/ambiguous authorities, and other hosts. Redirects are rejected
rather than followed, including redirects within a provider. Requests carry no
caller or service credentials. Only HTML/XHTML is read, with a 1 MiB streamed byte
limit independent of Content-Length and the existing 4.5-second deadline.
Unsupported, redirected, oversized, blocked, and failed references contribute no
snippet; description generation can continue from the structured game fields.
Saved catalog URLs and the proposal/apply workflow are unchanged.

The fix takes effect only after deploying the updated `ai-game-enrich-propose`
Edge Function to the intended Supabase project. After staging review, verify the
linked project and run `supabase functions deploy ai-game-enrich-propose` there;
repeat through the normal production release. No database migration or new secret
is required for this fetch restriction. A frontend preview or merge alone does
not deploy the Edge Function. The earlier member-identity migration is a separate
rollout prerequisite and is not applied by this deployment.

Regression tests: `scripts/ai-reference-fetch.test.mjs` executes the real fetch
functions with mocked transport, including the current catalog links, private
addresses, lookalikes, credentials, ports, redirects, MIME types, streaming limits,
and graceful failures. `scripts/ai-game-enrich-auth.test.mjs` separately exercises
the actual request handler and canonical SQL role boundary before protected work.

## Editor workflow (short)

1. Open a saved game and choose **Find or verify source links**. Existing URLs stay in place; generated candidates are shown for operator review and never saved automatically.
2. Open the evidence details to review which source pages matched the selected title and the excerpts retrieved from them. Edit a proposed URL directly, open it, and confirm the exact machine page before applying it.
3. Choose **Suggest missing metadata**. Suggestions cover manufacturer names, machine type, display, and player count when verified source excerpts support them. Filled values are never replaced. Select suggestions to copy them into blank form fields, review them, then use **Save game**.
4. OPDB ID, match method, and canonical name are imported integration data and are read-only in this editor. Third-party source URLs appear at the end of the metadata block.
5. After metadata review, choose **Draft our description** for two editable options grounded in verified source text or specific existing catalog copy. Source-site descriptions are shown only as evidence and are not stored as our editable description. If evidence is thin, the assistant reports that instead of writing generic copy.
6. Add gameplay fragments under **Operator notes** and choose **Polish our notes** when source coverage is thin. **Use this draft** copies an option into the regular description field; review it there and use **Save game** to persist it.

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
