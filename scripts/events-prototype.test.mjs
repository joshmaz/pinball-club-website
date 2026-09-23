import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../assets/js/events.js', import.meta.url), 'utf8');
const context = vm.createContext({ URL });
vm.runInContext(source.replace(/^loadEvents\(\);$|^void loadEventsPhotoSpotlight\(\);$/gm, ''), context);

test('presentation links support multiple providers, preserve legacy URL, and deduplicate', () => {
  const links = context.eventPresentationLinks({
    url: 'https://www.facebook.com/events/123',
    externalLinks: [{ url: 'https://app.matchplay.events/tournaments/42' },
      { url: 'https://discord.gg/example' }, { url: 'https://www.facebook.com/events/123' }],
  });
  assert.deepEqual(Array.from(links, l => l.label), ['Match Play', 'Discord', 'Facebook']);
  assert.equal(links.length, 3);
});

test('presentation links omit unsafe schemes and do not mislabel lookalike hosts', () => {
  const links = context.eventPresentationLinks({ externalLinks: [
    { url: 'javascript:alert(1)' }, { url: 'data:text/html,test' }, null,
    { url: 'https://facebook.com.example.org/event' },
    { url: 'https://club.example/event', label: 'Registration' },
  ] });
  assert.deepEqual(Array.from(links, l => l.label), ['Event details', 'Registration']);
  assert.equal(context.eventPresentationLinks({}).length, 0);
});

test('existing theme controller follows System and persists an explicit override', async () => {
  const themeSource = await readFile(new URL('../assets/js/theme.js', import.meta.url), 'utf8');
  const saved = new Map();
  function loadTheme(dark) {
    const attrs = new Map();
    const media = { matches: dark, addEventListener(_, fn) { this.change = fn; } };
    const root = { setAttribute: (k, v) => attrs.set(k, v), removeAttribute: k => attrs.delete(k) };
    const window = { matchMedia: () => media, addEventListener() {}, localStorage: {
      getItem: k => saved.get(k), setItem: (k, v) => saved.set(k, v), removeItem: k => saved.delete(k),
    } };
    const document = { documentElement: root, readyState: 'loading', head: {}, querySelector: () => null,
      getElementById: () => null, addEventListener() {} };
    vm.runInNewContext(themeSource, { window, document });
    return { theme: window.SNHTheme, media, attrs };
  }
  let app = loadTheme(true);
  assert.equal(app.attrs.get('data-theme-resolved'), 'dark');
  app.media.matches = false; app.media.change();
  assert.equal(app.attrs.get('data-theme-resolved'), 'light');
  app.theme.set('dark');
  app = loadTheme(false);
  assert.equal(app.theme.get(), 'dark');
  assert.equal(app.attrs.get('data-theme-resolved'), 'dark');
  app.media.matches = true; app.media.change();
  app.media.matches = false; app.media.change();
  assert.equal(app.attrs.get('data-theme-resolved'), 'dark', 'explicit override ignores OS changes');
  app.theme.set('system');
  assert.equal(saved.has('snh-theme'), false);
  app.media.matches = true; app.media.change();
  assert.equal(app.attrs.get('data-theme-resolved'), 'dark', 'System resumes following OS changes');
  app.media.matches = false; app.media.change();
  assert.equal(app.attrs.get('data-theme-resolved'), 'light');
});
