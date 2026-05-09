# Games AI Resolver Fixtures

These fixtures describe **target behavior** for link and metadata resolution. Use them for manual QA and future automated tests. The live proposer implements a **subset** (see status below).

## Implementation status (snapshot)

- [x] Proposal JSON contract version `1.0` (see `scripts/ai-enrichment-contract.mjs`)
- [x] Pinside / Kineticist **canonical URL guesses** from `slug`, title, and release year (falls back to search URLs when slug cannot be derived)
- [x] IPDB **search** URL fallback when no better link exists
- [x] Search / low-confidence link rows: **not** `applyByDefault`
- [ ] Full alias / cross-edition / cross-year disambiguation suite (items below remain **aspirational** until covered by code + tests)

## Fixture Set (v1)

1. **Alias title**
   - Example shape: short title vs full title alias.
   - Expected: resolver points to canonical page and flags alias in reason metadata.

2. **Variant title (LE/Pro/Premium)**
   - Example shape: shared base title with edition suffix.
   - Expected: resolver avoids cross-edition mismatches and requires review when ambiguous.

3. **Remake or reboot with same title**
   - Example shape: same title, different release year/manufacturer.
   - Expected: resolver uses year/manufacturer to disambiguate.

4. **Shared-page source case**
   - Example shape: source page covers multiple related games.
   - Expected: resolver flags shared-page warning and does not auto-apply by default.

5. **Cross-source disagreement**
   - Example shape: two trusted sources disagree on canonical URL.
   - Expected: marked `needs_review` with warning metadata.

## Expected Assertions

- Proposal payload validates against `proposalVersion` contract.
- Confidence thresholds are enforced by field type.
- Link candidates with search URLs are never preselected by default.
- Shared-page flags prevent default apply selection (when resolver emits those warnings).

## Implemented today vs fixture goals

| Assertion | Status |
|-----------|--------|
| Contract `proposalVersion` | Implemented (`scripts/ai-enrichment-contract.test.mjs`) |
| Thresholds gate apply-by-default | Implemented in function + UI |
| Search URL links not auto-apply | Implemented for IPDB/Pinside/Kineticist fallbacks |
| Alias / edition / shared-page metadata from fixture list | Partially; expand with tests over time |
