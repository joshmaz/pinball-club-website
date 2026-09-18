import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("static catalog no longer carries legacy image filenames", async () => {
  const catalog = JSON.parse(await readFile(path.join(root, "data", "games.json"), "utf8"));
  assert.equal(catalog.games.some((game) => Object.hasOwn(game, "imageFilename")), false);
});

test("public image resolvers do not construct legacy machine asset paths", async () => {
  const sources = await Promise.all([
    readFile(path.join(root, "assets", "js", "games.js"), "utf8"),
    readFile(path.join(root, "assets", "js", "home-gallery.js"), "utf8"),
  ]);
  for (const source of sources) {
    assert.equal(source.includes("assets/images/machines"), false);
    assert.equal(source.includes("IMAGE_BASE_PATH"), false);
  }
});

test("legacy machine image directory is absent", async () => {
  await assert.rejects(access(path.join(root, "assets", "images", "machines")));
});
