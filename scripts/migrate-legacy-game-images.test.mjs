import assert from "node:assert/strict";
import test from "node:test";
import { buildStoragePath, detectImageType, planMigration } from "./migrate-legacy-game-images-lib.mjs";

const baseFile = {
  filename: "alpha.jpg", repoPath: "assets/images/machines/alpha.jpg", absolutePath: "/tmp/alpha.jpg",
  bytes: Buffer.from([0xff, 0xd8, 0xff]), sizeBytes: 3, checksum: "a".repeat(64),
  imageType: { mime: "image/jpeg", extension: "jpg" }, typeError: null,
  mappedGames: [{ slug: "alpha", title: "Alpha", filename: "alpha.jpg" }],
};
const game = { id: "11111111-1111-4111-8111-111111111111", slug: "alpha", title: "Alpha", image_filename: "alpha.jpg" };
const legacy = { id: "legacy-row", game_id: game.id, source_type: "club", source_key: "legacy:alpha.jpg", is_primary: true, metadata: {} };
const url = "https://example.supabase.co";

test("detects content type from bytes instead of a misleading extension", () => {
  const detected = detectImageType(Buffer.from([0xff, 0xd8, 0xff, 0x00]));
  assert.equal(detected.mime, "image/jpeg");
  assert.equal(detected.extension, "jpg");
});

test("plans a single legacy image without disturbing PBDB or uploaded club images", () => {
  const unrelated = [
    { game_id: game.id, source_type: "opdb", source_key: "cabinet", is_primary: false },
    { game_id: game.id, source_type: "club", source_key: "storage:other.jpg", is_primary: false },
  ];
  const [entry] = planMigration({ files: [baseFile] }, [game], [legacy, ...unrelated], url);
  assert.equal(entry.action, "migrate");
  assert.equal(entry.image.id, "legacy-row");
});

test("preserves an explicit primary by targeting the legacy row in place", () => {
  const explicitPrimary = { game_id: game.id, source_type: "external", source_key: "chosen", is_primary: true };
  const nonPrimaryLegacy = { ...legacy, is_primary: false };
  const [entry] = planMigration({ files: [baseFile] }, [game], [nonPrimaryLegacy, explicitPrimary], url);
  assert.equal(entry.action, "migrate");
  assert.equal(entry.image.is_primary, false);
});

test("supports multiple distinct legacy photographs for one game", () => {
  const second = { ...baseFile, filename: "alpha-side.png", checksum: "b".repeat(64), imageType: { mime: "image/png", extension: "png" }, mappedGames: [{ slug: "alpha", title: "Alpha", filename: "alpha-side.png" }] };
  const gameForTest = { ...game, image_filename: "alpha.jpg" };
  // A second filename cannot be inferred from today's single image_filename field;
  // when explicitly mapped, each file gets its own deterministic object path.
  const firstPath = buildStoragePath(game.id, baseFile.checksum, "jpg");
  const secondPath = buildStoragePath(game.id, second.checksum, "png");
  assert.notEqual(firstPath, secondPath);
  const [first] = planMigration({ files: [baseFile] }, [gameForTest], [legacy], url);
  assert.equal(first.action, "migrate");
});

test("skips an already migrated association", () => {
  const storagePath = buildStoragePath(game.id, baseFile.checksum, "jpg");
  const migrated = {
    game_id: game.id, source_type: "club", source_key: `storage:${storagePath}`,
    location_value: `${url}/storage/v1/object/public/game-images/${storagePath}`,
    metadata: { storagePath },
  };
  const [entry] = planMigration({ files: [baseFile] }, [game], [migrated], url);
  assert.equal(entry.action, "skip");
});

test("reports unmapped and ambiguous files for manual review", () => {
  const unmapped = { ...baseFile, mappedGames: [] };
  const ambiguous = { ...baseFile, mappedGames: [baseFile.mappedGames[0], { slug: "beta", title: "Beta", filename: "alpha.jpg" }] };
  assert.equal(planMigration({ files: [unmapped] }, [game], [legacy], url)[0].reason, "unmapped file");
  assert.equal(planMigration({ files: [ambiguous] }, [game], [legacy], url)[0].reason, "ambiguous catalog mapping");
});
