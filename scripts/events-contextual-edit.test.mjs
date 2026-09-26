import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
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
  assert.match(loader, /select\('id,title,description,location,starts_at,external_url,source,all_day,time_known,external_links'/);
  assert.match(source, /SNHSiteAuth\.can\(roles, 'events\.manage'\)/);
  assert.match(source, /members\.html\?panel=events&event=/);
  assert.match(source, /Edit \$\{event\.title/);
});

test("Events contextual controls do not add a public write path", async () => {
  const source = await readFile(path.join(root, "assets", "js", "events.js"), "utf8");
  assert.doesNotMatch(source, /\.from\(EVENTS_TABLE\)\.(?:insert|update|upsert|delete)/);
});

test("Add Event uses shared creation access and opens the blank Events workflow", async () => {
  class Element {
    constructor(tagName) {
      this.tagName = tagName;
      this.children = [];
      this.classList = { add() {} };
    }
    appendChild(child) { this.children.push(child); return child; }
    setAttribute() {}
  }
  const context = vm.createContext({
    window: {}, console,
    document: { createElement: (tag) => new Element(tag), createTextNode: (textContent) => ({ textContent, children: [] }) },
  });
  vm.runInContext(await readFile(path.join(root, 'assets/js/site-auth.js'), 'utf8'), context);
  vm.runInContext(await readFile(path.join(root, 'assets/js/event-links.js'), 'utf8'), context);
  const source = await readFile(path.join(root, 'assets/js/events.js'), 'utf8');
  vm.runInContext(source.replace(/^loadEvents\(\);$|^void loadEventsPhotoSpotlight\(\);$/gm, ''), context);
  const auth = context.window.SNHSiteAuth;
  const descendants = (element) => [element, ...element.children.flatMap(descendants)];
  for (const role of [null, 'member', 'games_admin', 'events_editor', 'events_admin', 'club_admin']) {
    auth.getSession = async () => role ? { user: { id: 'test-user' } } : null;
    auth.fetchMemberRoles = async () => [role];
    context.allowed = await context.currentUserCanManageEvents();
    vm.runInContext('eventsCanManage = allowed', context);
    const container = new Element('div');
    context.renderEventsList(container, [{ title: 'Future event', date: '2099-01-01' }]);
    const nodes = descendants(container);
    const links = nodes.filter((node) => node.textContent === '+ Add Event');
    const expected = ['events_editor', 'events_admin', 'club_admin'].includes(role);
    assert.equal(links.length, expected ? 1 : 0, String(role));
    if (expected) {
      assert.equal(links[0].href, 'members.html?panel=events');
      const row = nodes.find((node) => node.className === 'events-upcoming-heading-row');
      assert.equal(row.children[0].tagName, 'h2');
      assert.equal(row.children[1], links[0]);
    } else {
      assert.equal(container.children[0].children[0].tagName, 'h2');
    }
  }
});
