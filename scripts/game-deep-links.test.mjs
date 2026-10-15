import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const gamesSource = read('assets/js/games.js').replace(/loadGames\(\);\s*$/, '');

function library(search, records) {
  const nodes = new Map();
  const make = id => {
    const node = { id, value: '', hidden: false, disabled: false, notes: [], dataset: {},
      classList: { toggle() {} }, addEventListener() {}, setAttribute() {},
      before(note) { this.notes.push(note); }, focus() {}, scrollIntoView() {} };
    nodes.set(id, node);
    return node;
  };
  for (const id of ['games-list', 'games-search', 'games-show-all', 'games-date-input']) make(id);
  const opened = [], rendered = [];
  const context = vm.createContext({ console, URLSearchParams,
    document: { getElementById: id => nodes.get(id) || null, querySelector: () => null,
      createElement: () => make('note'), querySelectorAll: () => [] },
    window: { location: { search } } });
  vm.runInContext(gamesSource, context);
  context.fetchGamesCatalogPayload = async () => ({ games: records });
  context.renderGamesList = games => rendered.push(Array.from(games, g => g.id));
  context.openGameMoreInfoModal = game => opened.push(game.id);
  context.currentUserCanManageGames = async () => false;
  return { context, nodes, opened, rendered };
}

const current = { id: 'current', title: 'Current', atClub: true,
  locationStints: [{ joinedClubDate: '2020-01-01' }] };
const historical = { id: 'past', title: 'Past', atClub: false,
  locationStints: [{ joinedClubDate: '2018-01-01', leftClubDate: '2019-01-01' }] };

test('current game opens without enabling history and clears restored search', async () => {
  const app = library('?game=current', [current, historical]);
  app.nodes.get('games-search').value = 'unrelated';
  await app.context.loadGames();
  assert.deepEqual(app.opened, ['current']);
  assert.equal(app.nodes.get('games-show-all').checked, false);
  assert.equal(app.nodes.get('games-search').value, '');
  assert.deepEqual(app.rendered[0], ['current']);
});

test('historical deep link enables full history and opens once', async () => {
  const app = library('?game=past', [current, historical]);
  app.context.currentUserCanManageGames = async () => true;
  await app.context.loadGames();
  assert.deepEqual(app.opened, ['past']);
  assert.equal(app.nodes.get('games-show-all').checked, true);
  assert.equal(app.nodes.get('games-date-input').disabled, true);
  assert.ok(app.rendered[0].includes('past'));
  assert.equal(app.rendered.length, 2, 'permission refresh rerenders without reopening the dialog');
});

test('missing, empty and deleted links leave library available with a message', async () => {
  for (const query of ['?game=missing', '?game=', '?game=deleted']) {
    const app = library(query, [current, { ...historical, id: 'deleted', deletedAt: '2026-01-01' }]);
    await app.context.loadGames();
    assert.deepEqual(app.opened, []);
    assert.match(app.nodes.get('games-list').notes[0].textContent, /unavailable/);
    assert.deepEqual(app.rendered[0], ['current']);
  }
});

test('ordinary library visit keeps current lineup and shows no link error', async () => {
  const app = library('', [current, historical]);
  await app.context.loadGames();
  assert.deepEqual(app.opened, []);
  assert.equal(app.nodes.get('games-list').notes.length, 0);
  assert.deepEqual(app.rendered[0], ['current']);
});

test('editor link follows saved record and hides for new or deleted games', () => {
  const source = read('assets/js/member-games-panel.js');
  const start = source.indexOf('  function syncGameLibraryLink');
  const end = source.indexOf('  function isGameAtClubToday', start);
  const link = { removeAttribute(name) { delete this[name]; } };
  const context = vm.createContext({ document: { getElementById: () => link }, encodeURIComponent });
  vm.runInContext(source.slice(start, end), context);
  context.syncGameLibraryLink({ id: 'a/b' });
  assert.equal(link.hidden, false);
  assert.equal(link.href, 'games.html?game=a%2Fb');
  for (const game of [null, {}, { id: 'a', deletedAt: '2026-01-01' }]) {
    context.syncGameLibraryLink(game);
    assert.equal(link.hidden, true);
    assert.equal(link.href, undefined);
  }
});

test('carousel links the active image and caption, excludes neighbors and suppresses swipe clicks', async () => {
  class Element {
    constructor(tag = 'div') {
      this.tagName = tag.toUpperCase(); this.listeners = {}; this.children = [];
      this.attrs = {}; this.style = {}; this.clientWidth = 500;
      this.classList = { toggle() {} };
    }
    append(child) { this.children.push(child); }
    after(child) { this.sibling = child; }
    remove() {}
    setAttribute(key, value) { this.attrs[key] = value; }
    addEventListener(key, callback) { this.listeners[key] = callback; }
    closest() { return this; }
  }
  const ids = ['gallery', 'gallery-track', 'gallery-caption', 'gallery-status', 'gallery-previous', 'gallery-next'];
  const nodes = Object.fromEntries(ids.map(id => [id, new Element()]));
  const observers = [];
  const context = vm.createContext({ console, Date, Math, clearTimeout() {}, setTimeout() {},
    document: { hidden: false, getElementById: id => nodes[id], createElement: tag => new Element(tag),
      addEventListener() {} },
    window: { matchMedia: () => ({ matches: true, addEventListener() {} }),
      SNHGameImages: { variants: () => [] },
      SNHPublicData: { loadGames: async () => ({ data: [current, historical].map(game =>
        ({ ...game, primaryImage: { url: 'https://example.com/image.webp' } })) }) } },
    IntersectionObserver: class { constructor(callback) { observers.push(callback); } observe() {} },
    ResizeObserver: class { observe() {} }
  });
  vm.runInContext(read('assets/js/home-gallery.js'), context);
  await new Promise(resolve => setImmediate(resolve));
  observers[0]([{ isIntersecting: true }]);
  const slides = nodes['gallery-track'].children;
  assert.equal(slides.length, 3);
  const active = slides.find(slide => slide.attrs['aria-hidden'] === 'false');
  assert.equal(active.tagName, 'A');
  assert.equal(active.tabIndex, 0);
  assert.equal(active.inert, false);
  assert.equal(nodes['gallery-caption'].sibling.href, active.href);
  assert.match(active.href, /^games.html\?game=/);
  for (const slide of slides.filter(slide => slide !== active)) {
    assert.equal(slide.tabIndex, -1);
    assert.equal(slide.inert, true);
  }
  const track = nodes['gallery-track'];
  let prevented = false;
  track.listeners.pointerdown({ pointerType: 'touch', clientX: 150, clientY: 0 });
  track.listeners.pointerup({ clientX: 50, clientY: 0 });
  track.listeners.click({ target: active, preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  prevented = false;
  track.listeners.pointerdown({ pointerType: 'touch', clientX: 50, clientY: 0 });
  track.listeners.pointerup({ clientX: 50, clientY: 0 });
  track.listeners.click({ target: active, preventDefault() { prevented = true; } });
  assert.equal(prevented, false);
});
