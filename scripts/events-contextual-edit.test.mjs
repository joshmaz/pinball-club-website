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
      this.attributes = {};
      this.classList = { add() {}, toggle() {} };
    }
    appendChild(child) { this.children.push(child); return child; }
    setAttribute(name, value) { this.attributes[name] = value; }
    addEventListener() {}
    replaceChildren() { this.children = []; }
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
    for (const events of [
      [],
      [{ title: 'Past event', date: '2000-01-01' }],
      [{ title: 'Future event', date: '2099-01-01' }],
    ]) {
      const container = new Element('div');
      context.renderEventsList(container, events);
      const nodes = descendants(container);
      const links = nodes.filter((node) => node.textContent === '+ Add Event');
      const expected = ['events_editor', 'events_admin', 'club_admin'].includes(role);
      assert.equal(links.length, expected ? 1 : 0, String(role));
      const empty = nodes.find((node) => node.className === 'events-empty-upcoming');
      const isEmpty = !events.some((event) => event.date === '2099-01-01');
      assert.equal(Boolean(empty), isEmpty);
      if (isEmpty) {
        assert.equal(empty.tagName, 'section');
        assert.equal(empty.attributes['aria-labelledby'], empty.children[0].id);
        assert.equal(empty.children[0].tagName, 'h2');
        assert.match(empty.children[1].textContent, /no upcoming events/i);
        assert.equal(nodes.some((node) => node.textContent === 'In the meantime, explore past events below.'), events.length > 0);
        assert.equal(nodes.some((node) => node.id === 'events-past-region'), events.length > 0);
        assert.equal(empty.children.filter((node) => node.tagName === 'a').length, expected ? 1 : 0);
      }
      if (expected) {
        assert.equal(links[0].href, 'members.html?panel=events');
        if (isEmpty) continue;
        const row = nodes.find((node) => node.className === 'events-upcoming-heading-row');
        assert.equal(row.children[0].tagName, 'h2');
        assert.equal(row.children[1], links[0]);
      } else if (!isEmpty) {
        assert.equal(container.children[0].children[0].tagName, 'h2');
      }
    }
  }
});
