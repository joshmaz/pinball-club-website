import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = await readFile(path.join(root, "assets", "js", "member-routes.js"), "utf8");
const GAME_ID = "123e4567-e89b-42d3-a456-426614174000";
const EVENT_ID = "223e4567-e89b-42d3-a456-426614174001";

function loadRoutes(locationOverrides = {}) {
  const location = { pathname: "/members.html", search: "", hash: "", ...locationOverrides };
  let replacedUrl = "";
  const context = {
    URLSearchParams,
    window: {
      location,
      history: { replaceState(_state, _title, url) { replacedUrl = url; } }
    }
  };
  vm.runInNewContext(source, context, { filename: "member-routes.js" });
  return { routes: context.window.SNHMemberRoutes, replacedUrl: () => replacedUrl };
}

test("reads a canonical game editor route", () => {
  const fixture = loadRoutes({ search: `?panel=games&game=${GAME_ID}` });
  assert.deepEqual(JSON.parse(JSON.stringify(fixture.routes.read())), {
    panel: "games",
    gameId: GAME_ID,
    eventId: ""
  });
});

test("accepts legacy panel hashes but ignores invalid panels and item ids", () => {
  assert.equal(loadRoutes({ hash: "#events" }).routes.read().panel, "events");
  const invalid = loadRoutes({ search: "?panel=admin&game=not-a-uuid", hash: "#nope" });
  assert.deepEqual(JSON.parse(JSON.stringify(invalid.routes.read())), {
    panel: "profile",
    gameId: "",
    eventId: ""
  });
});

test("reads and builds a canonical event editor route", () => {
  const fixture = loadRoutes({ search: `?panel=events&event=${EVENT_ID}` });
  assert.deepEqual(JSON.parse(JSON.stringify(fixture.routes.read())), {
    panel: "events",
    gameId: "",
    eventId: EVENT_ID
  });
  assert.equal(fixture.routes.build("events"), `/members.html?panel=events&event=${EVENT_ID}`);
  fixture.routes.setEvent(null);
  assert.equal(fixture.replacedUrl(), "/members.html?panel=events");
});

test("builds canonical routes and removes item parameters outside their panel", () => {
  const fixture = loadRoutes({ search: `?panel=games&game=${GAME_ID}` });
  assert.equal(fixture.routes.build("games"), `/members.html?panel=games&game=${GAME_ID}`);
  assert.equal(fixture.routes.build("events"), "/members.html?panel=events");
  assert.equal(fixture.routes.build("profile"), "/members.html");
});

test("setGame updates history with a validated UUID", () => {
  const fixture = loadRoutes();
  fixture.routes.setGame(GAME_ID);
  assert.equal(fixture.replacedUrl(), `/members.html?panel=games&game=${GAME_ID}`);
  fixture.routes.setGame("invalid");
  assert.equal(fixture.replacedUrl(), "/members.html?panel=games");
});

test("Member Tools wires route parsing before opening the game editor", async () => {
  const [membersHtml, gamesPanel, signinHtml] = await Promise.all([
    readFile(path.join(root, "members.html"), "utf8"),
    readFile(path.join(root, "assets", "js", "member-games-panel.js"), "utf8"),
    readFile(path.join(root, "signin.html"), "utf8")
  ]);
  assert.ok(
    membersHtml.indexOf('src="assets/js/member-routes.js"') <
      membersHtml.indexOf('src="assets/js/member-portal.js"')
  );
  assert.match(membersHtml, /SNHMemberRoutes\.read\(\)/);
  assert.match(membersHtml, /snhNavigateToMemberGameEditor\(initialRoute\.gameId\)/);
  assert.match(gamesPanel, /SNHMemberRoutes\.setGame\(g\.id \|\| gameId\)/);
  assert.match(signinHtml, /\^members\\\.html/);
});

test("Member Tools opens event deep links through the existing event editor", async () => {
  const membersHtml = await readFile(path.join(root, "members.html"), "utf8");
  assert.match(membersHtml, /snhNavigateToMemberEventEditor\(initialRoute\.eventId\)/);
  assert.match(membersHtml, /SNHMemberRoutes\.setEvent\(row\.id\)/);
  assert.match(membersHtml, /selectEventForEdit\(row\)/);
});
