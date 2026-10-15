# Game library links

Use `games.html?game=<catalog-id>` to open a saved game's existing details dialog.
The catalog ID, rather than the title, identifies the record.

The homepage carousel links its active image and its “View in Games Library”
caption to this URL. Inactive neighboring images are inert. A touch gesture that
moves more than 10 pixels suppresses the resulting image click, while horizontal
swipes over 40 pixels retain the existing carousel navigation.

The Games editor includes the same link for saved, non-deleted games and uses its
existing unsaved-changes confirmation when leaving the editor. New and deleted
records have no public link.

After the public catalog loads, a linked game opens once. Historical games, and
games absent from today's timeline snapshot, enable the full-history view.
Restored search text is cleared so the linked card is visible. Closing the dialog
returns focus to the card's More info control, including if permission loading has
rerendered the cards. Unknown, empty, or deleted IDs display an unavailable message
above the usable library. Public snapshot fallback behavior is unchanged.

No database or Edge Function changes are required.

Run focused regression checks with:

```sh
node scripts/game-deep-links.test.mjs
```

Preview checks: click and keyboard-activate a carousel image; tap versus swipe on
a phone; open current and historical links directly and reload; close the dialog;
check the editor link after saving, switching games, deleting, restoring, and
starting a new record; verify light/dark focus styling and reduced motion.
