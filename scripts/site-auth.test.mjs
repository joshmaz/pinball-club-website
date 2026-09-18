import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = await readFile(path.join(root, "assets", "js", "site-auth.js"), "utf8");

function loadSiteAuth({ session = null, roles = [] } = {}) {
  let getSessionCalls = 0;
  let memberQueryCalls = 0;
  let roleQueryCalls = 0;
  let authListener = null;
  const location = {
    pathname: "/members.html",
    search: "?panel=games&game=123",
    hash: "#games",
    href: ""
  };
  const client = {
    auth: {
      async getSession() {
        getSessionCalls += 1;
        return { data: { session }, error: null };
      },
      onAuthStateChange(callback) {
        authListener = callback;
        return { data: { subscription: { unsubscribe() {} } } };
      },
      async signOut() {
        return { error: null };
      }
    },
    from(table) {
      if (table === "members") {
        memberQueryCalls += 1;
        return {
          select() { return this; },
          eq() { return this; },
          async maybeSingle() { return { data: { id: "member-1" }, error: null }; }
        };
      }
      assert.equal(table, "member_roles");
      roleQueryCalls += 1;
      return {
        select() { return this; },
        async eq() {
          return { data: roles.map((role_slug) => ({ role_slug })), error: null };
        }
      };
    }
  };
  const context = { window: { snhSupabase: client, location } };
  vm.runInNewContext(source, context, { filename: "site-auth.js" });
  return {
    auth: context.window.SNHSiteAuth,
    location,
    emitAuth: (event, nextSession) => authListener(event, nextSession),
    counts: () => ({ getSessionCalls, memberQueryCalls, roleQueryCalls })
  };
}

test("session lookup is cached and auth changes refresh the cached value", async () => {
  const signedIn = { user: { id: "user-1" } };
  const fixture = loadSiteAuth({ session: signedIn });
  assert.equal(await fixture.auth.getSession(), signedIn);
  assert.equal(await fixture.auth.getSession(), signedIn);
  assert.equal(fixture.counts().getSessionCalls, 1);

  fixture.emitAuth("SIGNED_OUT", null);
  assert.equal(await fixture.auth.getSession(), null);
  assert.equal(fixture.counts().getSessionCalls, 1);
});

test("role lookup is cached and capabilities map to canonical role groups", async () => {
  const fixture = loadSiteAuth({ roles: ["games_editor"] });
  const first = await fixture.auth.fetchMemberRoles("user-1");
  const second = await fixture.auth.fetchMemberRoles("user-1");
  assert.deepEqual(first, ["games_editor"]);
  assert.deepEqual(second, ["games_editor"]);
  assert.deepEqual(fixture.counts(), { getSessionCalls: 0, memberQueryCalls: 1, roleQueryCalls: 1 });
  assert.equal(fixture.auth.can(first, "games.manage"), true);
  assert.equal(fixture.auth.can(first, "events.manage"), false);
  assert.equal(fixture.auth.can(first, "unknown.capability"), false);
});

test("requireAuth preserves the member route when redirecting to sign in", async () => {
  const fixture = loadSiteAuth({ session: null });
  assert.equal(await fixture.auth.requireAuth({ redirectToSignin: true }), null);
  assert.equal(
    fixture.location.href,
    "signin.html?next=" + encodeURIComponent("members.html?panel=games&game=123#games")
  );
});
