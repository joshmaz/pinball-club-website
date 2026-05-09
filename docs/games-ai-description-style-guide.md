# Games AI Description Style Guide

House style targets for **`games.details`** when using the enrichment assistant (`docs/games-ai-assistant.md`).

## Purpose

- Keep catalog card copy concise and recognizable on `games.html`.
- Prefer gameplay identity and theme when evidence exists (catalog text + trusted snippets).
- Keep copy truthful: no invented facts beyond supplied evidence.

## Length and shape

- **Target** about **185 characters**, generally **140–220** after server-side trimming.
- Roughly **1–3 sentences**, plain text (no bullets in the stored string).

## Voice

- Friendly, community-oriented, mechanically informative.
- Avoid hype (`best ever`, `ultimate`, `must-play`, empty “dynamic gameplay” filler).
- Prefer present tense.

## Manufacturer and year in prose

- **Convention:** Include **manufacturer** and **release year** in the paragraph when structured fields supply them (card copy aligns with metadata). The proposer warns if prose is missing them while metadata has values.
- Repeating a fact that exists only in metadata is intentional here for skim-friendly cards.

## Edition labels in prose

- Do **not** repeat model trim in prose when it appears only as `(Pro)`, `(Premium)`, `(LE)`, etc. on the title: the assistant strips those parentheticals from generated descriptions. The catalog title field may keep the edition.

## Theme and specificity

- When IPDB/Pinside/Kineticist snippets or existing `details` mention **theme** (sport, band, horror, diner, bowling, etc.) or concrete layout cues, surface them rather than generic “engaging gameplay” lines.
- Uncertain facts: omit or hedge (`likely`, `needs verification`). Do not assert without support.

## Post-proposer checks

- Review generic-filler warnings and brevity / metadata warnings in the portal before apply.
- Confidence thresholds still gate default checkboxes; manual approval always allowed.

## Validation (human)

- Non-empty, within length guard, URLs unchanged unless you apply link fields.
- After apply, spot-check public card and More info if applicable.
