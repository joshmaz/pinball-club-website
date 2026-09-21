import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const html = await readFile(new URL("../members.html", import.meta.url), "utf8");
const migration = await readFile(new URL("../supabase/migrations/20260921140000_member_role_scope.sql", import.meta.url), "utf8");
const integration = await readFile(new URL("./member-role-rpc-boundaries.sql", import.meta.url), "utf8");

test("both role RPCs enforce target-role scope after retaining the allowlist", () => {
  for (const name of ["grant", "revoke"]) {
    const body = migration.split(`create or replace function public.snh_${name}_member_role`)[1].split("$$;")[0];
    assert.match(body, /snh_is_assignable_member_role\(v_slug\)/);
    assert.match(body, /snh_member_can_assign_role\(v_slug\)/);
  }
  assert.match(migration, /p_role_slug <> 'club_admin' and mr\.role_slug = 'membership_admin'/);
  assert.match(migration, /p_role_slug not in \('club_admin', 'membership_admin'\) and mr\.role_slug = 'membership_editor'/);
  assert.match(integration, /snh_grant_member_role\(ids\[1\], slug\)/);
  assert.match(integration, /snh_revoke_member_role\(ids\[4\], slug\)/);
});

test("directory has inline editing, paging, search, and discard protection", () => {
  assert.match(html, /id="member-admin-search"/);
  assert.match(html, /id="member-admin-search-clear"[^>]*aria-label="Clear member search"[^>]*hidden/);
  assert.match(html, /memberAdminSearch\.dispatchEvent\(new Event\("input"/);
  for (const filter of ["all", "with-roles", "active", "inactive"]) assert.match(html, new RegExp(`value="${filter}"`));
  assert.doesNotMatch(html, /id="member-admin-grant-form"|id="member-admin-membership-form"/);
  assert.match(html, /filtered\.slice\(\(adminPage - 1\) \* 25, adminPage \* 25\)/);
  assert.match(html, /Discard unsaved membership changes\?/);
  assert.match(html, /beforeunload/);
  assert.match(html, /Remove role " \+ slug \+ " from " \+ adminMemberName\(row\)/);
  assert.match(html, /adminMayManageRole\(slug\)/);
});
