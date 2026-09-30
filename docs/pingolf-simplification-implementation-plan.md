# Pingolf Simplification Implementation Plan

**Status:** Implemented locally; deployment pending  
**Purpose:** Simplify SNHPC Pingolf functionality into a curated library of reusable targets associated directly with games, while leaving tournament operation, player scoring, courses, rounds, and standings to dedicated tournament platforms such as Match Play.

## Implementation decision (September 29, 2026)

Production contained one feature target with legacy numeric value `1`. The user
waived preservation of that target. The implementation starts with an empty target
library and aborts migration if unreviewed legacy targets appear. This supersedes
the preservation/backfill requirements below for the one reviewed target.
Permanent target deletion is reserved for Games Admins under the canonical policy.
See [Pingolf targets](pingolf-targets.md) for inspection findings and deployment steps.


## 1. Product boundary

SNHPC should maintain useful information about the club's pinball machines.

For Pingolf, that means maintaining a small curated collection of reusable target objectives for each game.

SNHPC should **not** attempt to provide a Pingolf tournament-management system.

The website will not model:

- Pingolf sessions;
- tournament courses;
- holes or course positions;
- players or groups;
- balls/strokes played;
- player results;
- partial-credit/failure scoring;
- tournament standings;
- tournament progression;
- tournament lifecycle.

Those concerns belong to tournament-management platforms.

The SNHPC Pingolf model should answer a much simpler question:

> **What are some useful Pingolf targets for this game?**

---

## 2. Target model

The desired relationship is:

```text
Game
  │
  └──< Pingolf Target
```

A game may have zero to ten Pingolf targets.

Each Pingolf target belongs to exactly one game.

A game may designate at most one target as its **preferred Pingolf target**.

Targets are first-class relational records and should remain in `public.pingolf_targets`. They should not be embedded as JSONB in the `games` record.

---

## 3. Target fields

The target model should contain approximately:

```text
pingolf_targets
────────────────────────────
id
game_id
target_type
description
score_threshold
is_preferred
notes
created_at
updated_at
```

Existing provenance/audit infrastructure should continue to record changes where practical.

### `id`

UUID primary key.

Existing target IDs should be preserved during migration.

### `game_id`

Required foreign key to `public.games(id)`.

This becomes the sole parent relationship for a Pingolf target.

Existing game relationships should be preserved.

### `target_type`

Required classification of the objective.

Initial supported values:

```text
score
feature
progression
hybrid
```

Meanings:

- **score** — reach a numeric score threshold;
- **feature** — accomplish a particular shot, feature, multiball, jackpot, bank completion, or similar machine objective;
- **progression** — reach a particular mode, milestone, or amount of game progression;
- **hybrid** — an either/or or otherwise combined objective.

This classification is intended primarily for organization and presentation.

Do not attempt to structurally model every possible Pin-Golf objective.

### `description`

Required human-readable description of the objective.

Examples:

```text
Reach 10,000,000 points
Start Multiball
Shoot the Hole-in-One
Start 5 modes
Collect a Super Jackpot OR reach 40,000,000 points
```

The description remains the authoritative human-readable definition of the target.

### `score_threshold`

Nullable `bigint`.

Use this only when the objective contains a meaningful numeric score threshold.

Examples:

```text
10,000,000
40,000,000
1,250,000,000
```

It may be used for `score` targets and may also be populated for a `hybrid` target containing a score alternative.

Do not require it for feature or progression targets.

This replaces the ambiguous existing `target_value` integer.

### `is_preferred`

Required boolean, default false.

At most one target per game may have `is_preferred = true`.

Enforce this invariant at the database level, preferably with a partial unique index on `game_id WHERE is_preferred`.

A game is allowed to have no preferred target.

“Preferred” represents the club's currently recommended/default target for that machine. It does **not** represent tournament state or imply the existence of an active Pingolf tournament.

### `notes`

Nullable text for internal/useful context that does not belong in the concise target description.

Do not expand this into tournament configuration.

### timestamps

Retain `created_at` and `updated_at`.

Continue using the existing shared timestamp behavior where appropriate.

---

## 4. Target limit

Each game may have at most **10 Pingolf targets**.

This is an intentional product constraint.

The target collection is intended to be curated rather than an unlimited historical archive.

### Enforcement

The authoritative limit should be enforced by the target create/upsert RPC.

Before inserting a new target, verify that the game currently has fewer than ten targets.

Updates to an existing target must not be rejected merely because the game already contains ten targets.

The UI should also communicate the limit, for example:

```text
Pingolf Targets
4 of 10 targets
```

At ten targets, disable or hide the Add Target action and explain why.

Do not make this limit configurable at this time.

---

## 5. Remove Pingolf sessions

Remove the `public.pingolf_sessions` concept entirely.

The current implementation uses sessions as named target containers and allows one session to be globally featured. Sessions do not model participants, scoring, rounds, completion, or tournament lifecycle.

The simplified model does not require this intermediate entity.

Remove, after dependent code has been migrated:

- `public.pingolf_sessions`;
- target `session_id`;
- session → target cascade relationship;
- optional session → event relationship;
- session title;
- session dates;
- session notes;
- global `is_featured` session state;
- featured-session unique index;
- session-management RPCs;
- session-management UI;
- browser `featuredPingolfSessionId` state;
- session-specific authorization;
- session-specific audit behavior that no longer has a corresponding entity.

No replacement “course,” “active tournament,” or “session” structure should be introduced as part of this work.

---

## 6. Existing target migration

Preserve useful existing target data.

Existing targets already contain both a required `game_id` and a required `session_id`, so their game association does not need to be reconstructed.

Migration should:

1. preserve target UUIDs;
2. preserve `game_id`;
3. preserve descriptions;
4. preserve timestamps where practical;
5. convert useful existing numeric `target_value` data to `score_threshold` where appropriate;
6. assign an initial `target_type`;
7. remove the required `session_id` relationship after data conversion is complete.

### Target type migration

Existing data does not contain enough structured information to determine target type reliably in all cases.

Do not use aggressive heuristics that could silently misclassify targets.

Where type cannot be determined safely, choose an explicit migration strategy documented before deployment, such as a conservative default followed by manual review.

### Existing numeric values

The current `target_value` has no formally defined unit.

Do not blindly assume every populated `target_value` is necessarily a score threshold without inspecting existing production data.

Before final migration, inspect current Pingolf rows in the deployed database and determine whether populated values are in fact score thresholds.

### Existing featured-session targets

Do not automatically mark every target belonging to the currently featured session as preferred.

Multiple targets may exist for the same game within a session.

A safe migration rule may be:

- if a game has exactly one target associated with the currently featured session, make that target preferred;
- if a game has multiple targets associated with the featured session, preserve them but leave preferred selection unset for manual review;
- if a game has no featured-session target, leave preferred selection unset.

Verify actual production data before applying this rule.

---

## 7. Public game presentation

Continue displaying Pingolf information on the public game profile.

The public game detail should retrieve targets directly by `game_id`, without consulting a session.

Display the preferred target prominently when one exists.

For example:

```text
Pingolf Targets

★ Preferred
Reach 1,250,000 points

Other targets
Complete both detours
Reach 2,000,000 points
```

Target type may be shown as useful secondary metadata.

Games with no targets should simply omit the Pingolf target content.

The public interface should not expose tournament/session terminology.

---

## 8. Games editor

Pingolf target maintenance should remain part of the existing game-management experience.

For an existing game, provide a section approximately like:

```text
Pingolf Targets                         3 of 10

★ Reach 1,250,000 points
  Score · Preferred
  [Edit] [Delete]

Complete both detours
  Feature
  [Edit] [Make Preferred] [Delete]

Start Multiball OR reach 2,000,000
  Hybrid
  [Edit] [Make Preferred] [Delete]

[+ Add target]
```

### Add target

Allow entry of:

- target type;
- description;
- score threshold when applicable;
- notes if included in the editing experience;
- preferred status.

### Edit target

Expose the existing conceptual update operation properly in the UI.

A target should not need to be deleted and recreated merely to correct its description or value.

### Preferred target

Allow an authorized editor to make a target preferred.

Making one target preferred should atomically clear the previous preferred target for that game.

Allow preferred status to be cleared so that a game can have no preferred target.

### Delete target

Allow authorized users to remove obsolete targets according to the finalized Games-domain authorization policy.

Do not introduce session-level controls.

---

## 9. RPC redesign

Replace session-oriented Pingolf RPC behavior with game-oriented target operations.

Exact function naming may be chosen during implementation, but required capabilities are:

### List targets for a game

Input:

```text
game_id
```

Return the game's targets, including:

- ID;
- type;
- description;
- score threshold;
- preferred status;
- notes where appropriate.

### Create target

Input:

```text
game_id
target fields
```

Requirements:

- verify Games-domain authorization;
- verify the game exists and is editable;
- enforce the ten-target limit;
- validate target type;
- validate description;
- validate numeric threshold;
- maintain preferred-target uniqueness;
- audit the operation.

### Update target

Requirements:

- verify authorization;
- verify target/game relationship;
- validate fields;
- support changing preferred status;
- atomically maintain preferred uniqueness;
- audit meaningful old/new state.

### Delete target

Requirements:

- verify authorization;
- delete only the requested target;
- audit the removed target;
- leave the game with no preferred target if the deleted target was preferred unless another target is explicitly selected.

Do not automatically choose a replacement preferred target.

---

## 10. Public More Info RPC

Update `snh_public_game_more_info(uuid)` so Pingolf output comes directly from targets associated with the requested game.

Remove featured-session lookup.

Preserve the public API contract where useful, but extend it deliberately to include the new information required by the UI.

A target response may include approximately:

```json
{
  "id": "...",
  "targetType": "score",
  "description": "Reach 10000000 points",
  "scoreThreshold": 10000000,
  "isPreferred": true
}
```

Do not expose internal notes publicly unless intentionally classified as public information.

---

## 11. Authorization

This refactor should avoid introducing a separate Pingolf role system.

Pingolf target maintenance is part of the Games domain.

The intended policy is:

> Maintaining reusable Pingolf targets is normal game-catalog upkeep.

Games Editors should therefore be able to perform ordinary target maintenance.

The obsolete distinction between:

```text
Games Editor → targets
Games Admin  → sessions
```

disappears because sessions disappear.

Any remaining distinction around destructive actions such as deletion should follow the canonical Games Editor / Games Admin policy established by the website authorization policy rather than creating Pingolf-specific exceptions.

During this refactor, maintain secure backend authorization independently of UI visibility.

---

## 12. Auditing

Continue treating Pingolf target changes as Games-domain audit activity.

Improve audit payload consistency while touching these RPCs.

For create/update/delete operations, audit records should identify the actual target UUID and include sufficient meaningful old/new state to understand the change.

In particular, avoid the current behavior where target insertion uses the game ID as the audit entity ID rather than the generated target ID.

Preferred-target changes should be understandable from audit history.

Do not create a new Pingolf-specific audit subsystem.

---

## 13. Game deletion behavior

Preserve the existing distinction between soft deletion and physical deletion unless implementation review identifies a reason to change it.

Normal game soft deletion may retain Pingolf targets so restoration restores the associated game knowledge.

Physical deletion may continue to cascade-delete associated targets if that remains consistent with Games-domain deletion semantics.

Ensure cascaded behavior is understood and tested.

---

## 14. Tests

Add focused Pingolf tests as part of this work.

The current implementation has no dedicated Pingolf schema/workflow/authorization tests.

At minimum test:

- a game can have zero targets;
- a game can have multiple targets;
- targets belong directly to games;
- creation succeeds through target 10;
- creation of target 11 is rejected;
- editing an existing target at the ten-target limit succeeds;
- at most one preferred target exists per game;
- making a new target preferred clears the previous preferred target;
- preferred status can be cleared;
- deleting the preferred target leaves no preferred target;
- target type validation;
- score threshold supports values larger than a signed 32-bit integer;
- Games Editor authorization for ordinary target maintenance;
- unauthorized users cannot mutate targets;
- public game detail returns the appropriate targets;
- soft-deleted games do not expose inappropriate public Pingolf data;
- session-independent target behavior;
- migration preserves existing target/game relationships.

Add focused tests for any destructive operation whose authorization differs between Games Editor and Games Admin.

---

## 15. Documentation cleanup

Update documentation affected by removal of Pingolf sessions.

In particular:

- update the website roles and authorization policy to remove Pingolf session administration from Games Admin;
- update the current roles report or clearly mark its Pingolf session descriptions as historical;
- retain the current Pingolf data-model report as documentation of the pre-refactor architecture;
- document the new game-target model;
- remove or update any other documentation describing featured sessions or session-based target management.

The historical current-state report should not be rewritten to pretend the old architecture never existed.

---

## 16. Suggested implementation sequence

Implement this as a controlled migration rather than deleting session infrastructure first.

### Phase 1 — Verify production data

Before destructive schema changes:

- inspect deployed `pingolf_sessions`;
- inspect deployed `pingolf_targets`;
- identify target counts per game;
- identify duplicate targets;
- inspect `target_value` usage;
- identify targets belonging to the featured session;
- determine whether any game has multiple targets in that session;
- verify deployed schema matches repository expectations.

Record findings before proceeding.

### Phase 2 — Introduce new target model

Add:

- target type;
- score threshold;
- preferred flag;
- notes if adopted;
- per-game preferred uniqueness;
- target-limit enforcement.

Make `session_id` temporarily compatible with migration as necessary.

Backfill/convert existing target data.

### Phase 3 — Replace target RPCs

Introduce or revise game-oriented target list/create/update/delete operations.

Add tests for the new behavior and authorization.

### Phase 4 — Update public game detail

Remove featured-session selection from the public More Info path.

Read targets directly by game.

Update public rendering and tests.

### Phase 5 — Replace Games editor UI

Remove featured-session assumptions from target management.

Add:

- target count;
- target type;
- add;
- edit;
- preferred selection;
- delete;
- ten-target UX.

### Phase 6 — Remove session functionality

After all readers/writers have moved away from sessions:

- remove session UI;
- remove session browser state and wrappers;
- remove session RPCs;
- remove session-specific authorization;
- remove event FK dependency;
- remove `session_id` from targets;
- drop `pingolf_sessions`;
- remove obsolete indexes/policies/triggers.

### Phase 7 — Documentation and regression review

Update policy/documentation.

Run full regression tests covering Games, Events, public game profiles, authorization, audit behavior, and navigation.

Verify that removal of the session → event FK does not produce unexpected Event behavior.

---

## 17. Non-goals

This project should **not** expand into:

- Match Play replacement functionality;
- tournament creation;
- Pingolf course building;
- player registration;
- score entry;
- stroke calculation;
- partial-credit/failure scales;
- handicapping systems;
- tournament results;
- standings;
- automated target difficulty calculation;
- complex structured representations of machine rules;
- synchronization of tournament state.

Future integrations may consume the reusable target library, but such integrations should be separate projects with independently justified requirements.

---

## 18. Resulting architecture

After completion:

```text
GAMES
  │
  │ 1:N, maximum 10
  ▼
PINGOLF_TARGETS
  ├── type
  ├── description
  ├── optional score threshold
  ├── preferred flag
  ├── optional notes
  └── timestamps
```

At most one target per game is preferred.

The SNHPC website owns a curated library of useful Pingolf targets for its machines.

Tournament-management platforms own tournaments.

