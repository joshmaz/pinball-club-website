import test from "node:test";
import assert from "node:assert/strict";
import {
  entriesByOpdbId,
  imageImportsForEntry,
} from "../supabase/functions/_shared/opdb-images.ts";

test("imageImportsForEntry uses explicit OPDB fields and prefers the large URL", () => {
  const rows = imageImportsForEntry({
    opdbId: "Gtest-Mtest",
    name: "Test Game",
    images: [
      {
        group: "image-group-1",
        title: "Playfield",
        type: "playfield",
        primary: true,
        urls: {
          small: "https://img.opdb.org/test-small.jpg",
          medium: "https://img.opdb.org/test-medium.jpg",
          large: "https://img.opdb.org/test-large.jpg",
        },
        sizes: { large: { width: 900, height: 1200 } },
      },
    ],
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].sourceKey, "image-group-1");
  assert.equal(rows[0].imageUrl, "https://img.opdb.org/test-large.jpg");
  assert.equal(rows[0].sourceUrl, "https://app.matchplay.events/opdb/entries/Gtest-Mtest");
  assert.equal(rows[0].imageType, "playfield");
  assert.equal(rows[0].metadata.width, 900);
  assert.equal(rows[0].metadata.rightsReviewed, false);
});

test("imageImportsForEntry does not crawl unrelated URLs", () => {
  const rows = imageImportsForEntry({
    opdbId: "Gtest-Mtest",
    name: "Test Game",
    unrelated: "https://example.com/not-an-opdb-image.jpg",
    images: [{ group: "missing-url", title: "No URL", urls: {} }],
  });
  assert.deepEqual(rows, []);
});

test("entriesByOpdbId indexes machines and aliases once", () => {
  const entries = entriesByOpdbId({
    machines: [{ opdbId: "G-one", name: "One", images: [] }],
    aliases: [
      { opdbId: "G-two-A-one", name: "Two alias", images: [] },
      { opdbId: "G-one", name: "Duplicate", images: [] },
    ],
  });
  assert.equal(entries.size, 2);
  assert.equal(entries.get("G-one").name, "One");
  assert.equal(entries.get("G-two-A-one").name, "Two alias");
});

