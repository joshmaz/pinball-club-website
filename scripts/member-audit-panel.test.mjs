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

test("expanded details show resolved names and end with only the audit ID", async () => {
  function element() {
    return {
      children: [], textContent: "", hidden: false, value: "", checked: false,
      classList: { toggle() {} },
      appendChild(child) { this.children.push(child); },
      append(...children) { this.children.push(...children); },
      replaceChildren() { this.children = []; },
      addEventListener() {}, setAttribute() {}
    };
  }
  const nodes = new Map();
  for (const id of ["member-audit-section", "member-audit-table-body", "member-audit-status", "member-audit-module", "member-audit-automated", "member-audit-older", "member-audit-refresh"]) nodes.set(id, element());
  const eventId = "123e4567-e89b-42d3-a456-426614174000";
  const gameId = "223e4567-e89b-42d3-a456-426614174001";
  const browser = { window: { SNHMemberPortal: { async listAuditHistoryForAdmin() {
    return [
      { id: "audit-1", created_at: "2026-09-21T12:00:00Z", module: "events", entity_type: "event", entity_id: eventId, record_label: "Open House", action: "update" },
      { id: "audit-2", created_at: "2026-09-21T11:00:00Z", module: "games", entity_type: "game_image", entity_id: gameId, record_label: "Medieval Madness", action: "update" }
    ];
  } } }, document: { getElementById: id => nodes.get(id), createElement: element }, navigator: {} };
  vm.runInNewContext(fs.readFileSync(new URL("../assets/js/member-audit-panel.js", import.meta.url), "utf8"), browser);
  browser.window.SNHMemberAuditPanel.init(["club_admin"]);
  await browser.window.SNHMemberAuditPanel.load(false);
  const rows = nodes.get("member-audit-table-body").children;
  assert.equal(rows[1].children[0].children[0].textContent, "Event: Open House");
  assert.equal(rows[1].children[0].children.at(-1).textContent, "Audit entry ID: audit-1");
  assert.equal(rows[3].children[0].children[0].textContent, "Game image: Medieval Madness");
  assert.equal(rows[3].children[0].children.at(-1).textContent, "Audit entry ID: audit-2");
});
