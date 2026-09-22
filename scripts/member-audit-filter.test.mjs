import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const root = new URL("../", import.meta.url);

test("audit filters reload the first page and pass automated activity to the RPC", async () => {
  const elements = new Map();
  function element(id) {
    const listeners = {};
    return {
      id, listeners, value: "", checked: false, hidden: false, disabled: false,
      textContent: "", children: [],
      addEventListener(name, callback) { listeners[name] = callback; },
      replaceChildren() { this.children = []; }
    };
  }
  for (const id of ["member-audit-section", "member-audit-table-body", "member-audit-status", "member-audit-module", "member-audit-automated", "member-audit-older", "member-audit-refresh"]) elements.set(id, element(id));
  const calls = [];
  const context = {
    document: { getElementById: id => elements.get(id) },
    window: { SNHMemberPortal: { async listAuditHistoryForAdmin(options) { calls.push({ ...options }); return []; } } }
  };
  vm.runInNewContext(await readFile(new URL("assets/js/member-audit-panel.js", root), "utf8"), context);
  const panel = context.window.SNHMemberAuditPanel;
  panel.init(["club_admin"]);
  const area = elements.get("member-audit-module");
  const automated = elements.get("member-audit-automated");
  await panel.load(false);
  assert.equal(calls[0].showAutomated, false);
  automated.checked = true;
  automated.listeners.change();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls[1].showAutomated, true);
  assert.equal(calls[1].beforeId, null);
  area.value = "games";
  area.listeners.change();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls[2].module, "games");
  assert.equal(calls[2].beforeCreatedAt, null);
});

test("SQL excludes only empty Pinball Map ingests before the page limit and preserves admin gate", async () => {
  const sql = await readFile(new URL("supabase/migrations/20260921130000_audit_automated_activity_filter.sql", root), "utf8");
  assert.match(sql, /drop function public\.snh_audit_history_for_admin\(text, integer, timestamptz, uuid\)/);
  assert.match(sql, /mr\.role_slug = 'club_admin'/);
  assert.match(sql, /al\.module = 'games' and al\.action = 'import' and al\.entity_type = 'pinballmap_ingest'/);
  assert.match(sql, /al\.new_data @> '\{"updates_count": 0, "creates_count": 0\}'::jsonb/);
  assert.ok(sql.indexOf("al.entity_type = 'pinballmap_ingest'") < sql.indexOf("limit p_limit"));
  assert.doesNotMatch(sql, /actor_label\s*<>\s*'System'/);
});

test("browser RPC sends the checkbox value under the new argument name", async () => {
  const source = await readFile(new URL("assets/js/member-portal.js", root), "utf8");
  const rpc = source.slice(source.indexOf("async function listAuditHistoryForAdmin"), source.indexOf("async function grantMemberRole"));
  assert.match(rpc, /p_show_automated: options\.showAutomated === true/);
  assert.match(rpc, /p_before_created_at: options\.beforeCreatedAt \|\| null/);
  assert.match(rpc, /p_before_id: options\.beforeId \|\| null/);
});

test("record labels resolve after pagination without changing the RPC gate or signature", async () => {
  const sql = await readFile(new URL("supabase/migrations/20260921131000_audit_history_record_labels.sql", root), "utf8");
  assert.match(sql, /create or replace function public\.snh_audit_history_for_admin/);
  assert.match(sql, /mr\.role_slug = 'club_admin'/);
  assert.match(sql, /when 'event' then \(select e\.title/);
  assert.match(sql, /when 'game_image' then/);
  assert.ok(sql.indexOf("limit p_limit") < sql.indexOf(") page;"));
  assert.match(sql, /to_jsonb\(page\) \|\| jsonb_build_object\('record_label'/);
});
