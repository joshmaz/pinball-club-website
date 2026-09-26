import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

class Element {
  constructor(tagName = 'div') {
    this.tagName = tagName;
    this.children = [];
    this.attributes = new Map();
    this.listeners = new Map();
    this.classes = new Set();
    this.disabled = false;
    this.hidden = false;
    this.classList = {
      add: (name) => this.classes.add(name),
      toggle: (name, active) => active ? this.classes.add(name) : this.classes.delete(name),
      contains: (name) => this.classes.has(name),
    };
  }

  appendChild(child) { this.children.push(child); return child; }
  replaceChildren() { this.children = []; }
  setAttribute(name, value) { this.attributes.set(name, value); }
  getAttribute(name) { return this.attributes.get(name); }
  addEventListener(name, listener) { this.listeners.set(name, listener); }
  click() { if (!this.disabled) this.listeners.get('click')?.(); }
  getBoundingClientRect() { return { left: 0, right: 100 }; }
  scrollBy() {}
}

test('past years open, navigate, and collapse with correct selection and boundaries', async () => {
  const source = await readFile(path.join(root, 'assets/js/events.js'), 'utf8');
  const document = {
    createElement: (tagName) => new Element(tagName),
    createTextNode: (value) => ({ textContent: value }),
  };
  const context = vm.createContext({ document, window: {} });
  vm.runInContext(await readFile(path.join(root, 'assets/js/event-links.js'), 'utf8'), context);
  vm.runInContext(source.replace(/^loadEvents\(\);$|^void loadEventsPhotoSpotlight\(\);$/gm, ''), context);

  const region = new Element();
  const years = ['2026', '2025', '2024', '2016'].map((year) => ({
    year,
    events: [{ title: `Event ${year}`, date: `${year}-01-01`, location: 'Club' }],
  }));
  context.renderPastEventsYearNavigator(region, years);

  const [hint, nav, panel] = region.children;
  const [newer, tabsWrap, older] = nav.children;
  const tabs = tabsWrap.children;
  const selected = () => tabs.filter((tab) => tab.classList.contains('events-past-year-tab-selected'));
  const displayed = () => panel.children.find((child) => child.tagName === 'h3')?.textContent;

  assert.equal(hint.textContent, 'Select a year to show past events.');
  assert.equal(nav.getAttribute('aria-describedby'), hint.id);
  assert.equal(tabs.length, 4);
  assert.equal(panel.hidden, true);
  assert.equal(panel.children.length, 0);
  assert.equal(selected().length, 0);
  assert.ok(tabs.every((tab) => tab.getAttribute('aria-pressed') === 'false'));
  assert.equal(newer.disabled, true);
  assert.equal(older.disabled, true);

  tabs[0].click();
  assert.equal(displayed(), '2026');
  assert.equal(hint.textContent, 'Click the highlighted year to hide past events.');
  assert.equal(panel.hidden, false);
  assert.equal(panel.children.length, 3);
  assert.deepEqual(selected(), [tabs[0]]);
  assert.equal(newer.disabled, true);
  assert.equal(older.disabled, false);

  tabs[2].click();
  assert.equal(displayed(), '2024');
  assert.deepEqual(selected(), [tabs[2]]);
  newer.click();
  assert.equal(displayed(), '2025');
  assert.equal(hint.textContent, 'Click the highlighted year to hide past events.');
  older.click();
  older.click();
  assert.equal(displayed(), '2016');
  assert.equal(newer.disabled, false);
  assert.equal(older.disabled, true);

  tabs[3].click();
  assert.equal(panel.hidden, true);
  assert.equal(panel.children.length, 0);
  assert.equal(selected().length, 0);
  assert.ok(tabs.every((tab) => tab.getAttribute('aria-pressed') === 'false'));
  assert.equal(newer.disabled, true);
  assert.equal(older.disabled, true);
  assert.equal(hint.textContent, 'Select a year to show past events.');
  assert.equal(region.children[1], nav);

  tabs[1].click();
  assert.equal(displayed(), '2025');
  assert.equal(hint.textContent, 'Click the highlighted year to hide past events.');
  assert.deepEqual(selected(), [tabs[1]]);
  assert.equal(newer.disabled, false);
  assert.equal(older.disabled, false);
});
