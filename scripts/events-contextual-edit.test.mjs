import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("Events loads shared auth before its page script", async () => {
  const html = await readFile(path.join(root, "events.html"), "utf8");
  assert.ok(
    html.indexOf('src="assets/js/site-auth.js"') < html.indexOf('src="assets/js/events.js"')
  );
});

test("public Events retains UUIDs and capability-gates contextual edit links", async () => {
  const source = await readFile(path.join(root, "assets", "js", "events.js"), "utf8");
  const loader = await readFile(path.join(root, 'assets', 'js', 'public-data.js'), 'utf8');
  assert.match(loader, /select\('id,title,description,location,starts_at,external_url,source'/);
  assert.match(source, /SNHSiteAuth\.can\(roles, 'events\.manage'\)/);
  assert.match(source, /members\.html\?panel=events&event=/);
  assert.match(source, /Edit \$\{event\.title/);
});

test("Events contextual controls do not add a public write path", async () => {
  const source = await readFile(path.join(root, "assets", "js", "events.js"), "utf8");
  assert.doesNotMatch(source, /\.from\(EVENTS_TABLE\)\.(?:insert|update|upsert|delete)/);
});
