import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const context = { window: {} };
vm.runInNewContext(fs.readFileSync(new URL("../assets/js/member-audit-panel.js", import.meta.url), "utf8"), context);
const { changes, valueText, label } = context.window.SNHMemberAuditPanel;

test("updates include only changed, added, and removed fields", () => {
  const result = changes({ action: "update", old_data: { title: "Same", nested: { a: 1, b: 2 }, removed: 3 }, new_data: { title: "Same", nested: { b: 2, a: 1 }, added: false } });
  assert.equal(result.mode, "compare");
  assert.deepEqual(Array.from(result.fields, field => field.key), ["removed", "added"]);
});

test("create, delete, grant, revoke and unknown actions choose useful sides", () => {
  assert.equal(changes({ action: "create", new_data: { title: "New" } }).mode, "after");
  assert.equal(changes({ action: "delete", old_data: { title: "Old" } }).mode, "before");
  assert.equal(changes({ action: "grant", new_data: { role_slug: "admin" } }).mode, "after");
  assert.equal(changes({ action: "revoke", old_data: { role_slug: "admin" } }).mode, "before");
  assert.equal(changes({ action: "finalize_upload", old_data: { status: "draft" }, new_data: { status: "ready" } }).fields.length, 1);
  assert.equal(changes({ action: "update", old_data: null, new_data: null }).fields.length, 0);
});

test("generic labels and values remain readable", () => {
  assert.equal(label("external_url"), "External URL");
  assert.equal(label("future_field_name"), "Future field name");
  assert.equal(valueText(false), "No");
  assert.equal(valueText(null), "—");
  assert.equal(valueText(["a", "b"]), "a, b");
  assert.match(valueText({ nested: { ok: true } }), /"nested"/);
  assert.equal(valueText("2026-09-20", "start_date"), "Sep 20, 2026");
});
