import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("Games loads shared auth before its page script", async () => {
  const html = await readFile(path.join(root, "games.html"), "utf8");
  assert.ok(
    html.indexOf('src="assets/js/site-auth.js"') < html.indexOf('src="assets/js/games.js"')
  );
});

test("Games edit controls use capability gating and the canonical UUID route", async () => {
  const source = await readFile(path.join(root, "assets", "js", "games.js"), "utf8");
  assert.match(source, /SNHSiteAuth\.can\(roles, "games\.manage"\)/);
  assert.match(source, /members\.html\?panel=games&game=/);
  assert.match(source, /gameHasCatalogUuid\(game\)/);
  assert.match(source, /Edit \$\{game\.title\} in Member Tools/);
});

test("Games edit controls remain a UI enhancement rather than a write path", async () => {
  const source = await readFile(path.join(root, "assets", "js", "games.js"), "utf8");
  assert.doesNotMatch(source, /snh_games_upsert|\.from\(["']games["']\)\.(?:insert|update|upsert|delete)/);
});
