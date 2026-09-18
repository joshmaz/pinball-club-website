import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicPages = [
  "index.html",
  "about.html",
  "events.html",
  "games.html",
  "merch.html",
  "resources.html",
  "donate/index.html"
];

test("major public pages progressively load the shared account menu", async () => {
  for (const page of publicPages) {
    const html = await readFile(path.join(root, page), "utf8");
    assert.match(html, /data-site-account-link/);
    assert.match(html, /site-account\.js/);
    assert.ok(html.indexOf("supabase-init.js") < html.indexOf("site-auth.js"), page);
    assert.ok(html.indexOf("site-auth.js") < html.indexOf("site-account.js"), page);
  }
});

test("nested donation navigation retains its parent-relative account paths", async () => {
  const html = await readFile(path.join(root, "donate", "index.html"), "utf8");
  assert.match(html, /href="\.\.\/signin\.html" data-site-account-link/);
  assert.match(html, /src="\.\.\/assets\/js\/site-account\.js"/);
});

test("the account menu provides accessible dashboard and sign-out actions", async () => {
  const source = await readFile(path.join(root, "assets", "js", "site-account.js"), "utf8");
  assert.match(source, /aria-haspopup/);
  assert.match(source, /aria-expanded/);
  assert.match(source, /textContent = "Dashboard"/);
  assert.match(source, /textContent = "Sign out"/);
  assert.match(source, /SNHSiteAuth\.signOut\(\)/);
  assert.match(source, /event\.key === "Escape"/);
});
