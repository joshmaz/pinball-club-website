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

test("reads and builds the Audit Log panel route", () => {
  const fixture = loadRoutes({ search: "?panel=audit-log" });
  assert.equal(fixture.routes.read().panel, "operations");
  assert.equal(fixture.routes.read().operationsSection, "audit");
  assert.equal(fixture.routes.build("audit-log"), "/members.html?panel=operations&section=audit");
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

test("opens the new event editor only on the explicit new event route", async () => {
  const fixture = loadRoutes({ search: "?panel=events&event=new" });
  assert.equal(fixture.routes.read().newEvent, true);
  assert.equal(fixture.routes.read().eventId, "");
  assert.equal(fixture.routes.build("events"), "/members.html?panel=events&event=new");
  assert.equal(fixture.routes.build("photos"), "/members.html?panel=photos");
  fixture.routes.setEvent(null);
  assert.equal(fixture.replacedUrl(), "/members.html?panel=events");
  assert.equal(loadRoutes({ search: "?panel=events" }).routes.read().newEvent, undefined);
  const html = await readFile(path.join(root, "members.html"), "utf8");
  assert.match(html, /id="member-events-editor"[^>]+hidden/);
  assert.match(html, /id="member-events-import-panel"[^>]+hidden/);
  assert.match(html, /initialRoute\.newEvent\) \{\s+openNewEvent\(\)/);
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

test("Operations section routes survive reload and legacy hashes", () => {
  const f = loadRoutes({ search: "?panel=operations&section=cache" });
  assert.equal(f.routes.read().operationsSection, "cache");
  assert.equal(f.routes.build("operations"), "/members.html?panel=operations&section=cache");
  assert.equal(f.routes.build("profile"), "/members.html");
  assert.equal(loadRoutes({ hash: "#audit-log" }).routes.read().operationsSection, "audit");
  assert.equal(loadRoutes({ search: "?panel=operations&section=invalid" }).routes.read().operationsSection, "overview");
});

 test("photo album routes validate ids and remove them outside Photos",()=>{
  const fixture=loadRoutes({search:`?panel=photos&album=${GAME_ID}`});
  assert.equal(fixture.routes.read().albumId,GAME_ID);
  assert.equal(fixture.routes.build("photos"),`/members.html?panel=photos&album=${GAME_ID}`);
  assert.equal(fixture.routes.build("games"),"/members.html?panel=games");
  fixture.routes.setAlbum(EVENT_ID);
  assert.equal(fixture.replacedUrl(),`/members.html?panel=photos&album=${EVENT_ID}`);
  fixture.routes.setAlbum("https://evil.invalid");
  assert.equal(fixture.replacedUrl(),"/members.html?panel=photos");
  assert.equal(loadRoutes({search:"?panel=photos&album=bad"}).routes.read().albumId,"");
 });

test('issue reporting context survives sign-in return route and is removed outside Issues', () => {
 const fixture=loadRoutes({search:`?panel=club-issues&issueGame=${GAME_ID}`});
 assert.equal(fixture.routes.read().issueGameId,GAME_ID);
 assert.equal(fixture.routes.build('club-issues'),`/members.html?panel=club-issues&issueGame=${GAME_ID}`);
 assert.equal(fixture.routes.build('profile'),'/members.html');
 assert.equal(loadRoutes({search:'?panel=club-issues&issueGame=bad'}).routes.build('club-issues'),'/members.html?panel=club-issues');
});


test("New event toggles a blank form and keeps open edits", async () => {
  const html = await readFile(path.join(root, "members.html"), "utf8");
  const start = html.indexOf("    function snapshotEventsForm()");
  const end = html.indexOf("    function toggleMatchplayImport()", start);
  const field = { type: "text", value: "" };
  const editor = { hidden: true };
  const context = vm.createContext({
    memberEventsEditor: editor,
    memberEventsId: { value: "" },
    memberEventsForm: { querySelectorAll: () => [field] },
    memberEventsFormSnapshot: null,
    resetEventsForm() { editor.hidden = true; field.value = ""; context.memberEventsFormSnapshot = null; },
    showEventsEditor() { editor.hidden = false; },
    setEventsStatus(message) { context.status = message; }
  });
  vm.runInContext(html.slice(start, end), context);
  vm.runInContext("toggleNewEvent()", context);
  assert.equal(editor.hidden, false);
  vm.runInContext("toggleNewEvent()", context);
  assert.equal(editor.hidden, true);
  vm.runInContext("toggleNewEvent()", context);
  field.value = "Unsaved tournament";
  vm.runInContext("toggleNewEvent()", context);
  assert.equal(editor.hidden, false);
  assert.equal(field.value, "Unsaved tournament");
  assert.match(context.status, /Save or cancel/);
  context.memberEventsFormSnapshot = null;
  field.value = "";
  vm.runInContext("toggleNewEvent()", context);
  assert.equal(editor.hidden, false);
});

test("clearing the tournament field also ignores a pending review result", async () => {
  const html = await readFile(path.join(root, "members.html"), "utf8");
  const start = html.indexOf("    function resetMatchplayTournamentReview()");
  const end = html.indexOf("    if (matchplayReviewCandidates)", start);
  const input = { value: "228825", addEventListener() {}, focus() { this.focused = true; } };
  let clear, submit, finishReview;
  const pending = new Promise(resolve => { finishReview = resolve; });
  const context = vm.createContext({
    matchplayTournamentInput: input,
    matchplayTournamentClear: { addEventListener(_name, handler) { clear = handler; } },
    matchplayReviewForm: { addEventListener(_name, handler) { submit = handler; } },
    matchplayReviewData: null,
    matchplayReviewResults: { hidden: true },
    matchplayReviewStatus: {},
    matchplayReviewRevision: 0,
    matchplayReviewSubmit: {},
    window: { SNHMemberPortal: { reviewMatchplayTournament: () => pending } }
  });
  vm.runInContext(html.slice(start, end), context);
  const reviewing = submit({ preventDefault() {} });
  assert.equal(context.matchplayTournamentClear.hidden, false);
  clear();
  finishReview({ tournament: { title: "Old result" } });
  await reviewing;
  assert.equal(input.value, "");
  assert.equal(input.focused, true);
  assert.equal(context.matchplayTournamentClear.hidden, true);
  assert.equal(context.matchplayReviewResults.hidden, true);
  assert.equal(context.matchplayReviewData, null);
  assert.equal(context.matchplayReviewStatus.textContent, "");
});

test("switching to Match Play closes a clean event editor and confirms before discarding edits", async () => {
  const html = await readFile(path.join(root, "members.html"), "utf8");
  const start = html.indexOf("    function toggleMatchplayImport()");
  const end = html.indexOf("    memberEventsImport.addEventListener", start);
  const editor = { hidden: false };
  const importer = { hidden: true };
  let confirms = 0;
  let discard = false;
  const context = vm.createContext({
    memberEventsEditor: editor,
    memberEventsImportPanel: importer,
    memberEventsFormSnapshot: "saved",
    snapshotEventsForm: () => "unsaved",
    resetEventsForm() { editor.hidden = true; },
    setEventsStatus() {},
    setMatchplayImportOpen(open) { importer.hidden = !open; },
    matchplayTournamentClear: {},
    matchplayTournamentInput: { value: "", focus() {} },
    window: { confirm() { confirms += 1; return discard; } }
  });
  vm.runInContext(html.slice(start, end), context);
  vm.runInContext("toggleMatchplayImport()", context);
  assert.equal(confirms, 1);
  assert.equal(editor.hidden, false);
  assert.equal(importer.hidden, true);
  discard = true;
  vm.runInContext("toggleMatchplayImport()", context);
  assert.equal(confirms, 2);
  assert.equal(editor.hidden, true);
  assert.equal(importer.hidden, false);
  editor.hidden = false;
  importer.hidden = true;
  context.memberEventsFormSnapshot = "unsaved";
  vm.runInContext("toggleMatchplayImport()", context);
  assert.equal(confirms, 2);
  assert.equal(editor.hidden, true);
  assert.equal(importer.hidden, false);
});
