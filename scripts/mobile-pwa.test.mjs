import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const pages = ['index.html', 'events.html', 'games.html', 'merch.html', 'resources.html', 'about.html', 'signin.html', 'members.html', 'donate/index.html'];
const manifestPath = 'assets/pwa/manifest.webmanifest';
const manifest = JSON.parse(readFileSync(manifestPath));

test('every app entry point shares manifest, iOS identity and an accessible current-page top link', () => {
  assert.equal(manifest.start_url, '/');
  assert.equal(manifest.scope, '/');
  assert.equal(manifest.display, 'standalone');
  for (const page of pages) {
    const html = readFileSync(page, 'utf8');
    const url = new URL(page, 'https://preview.example/');
    const href = html.match(/rel="manifest" href="([^"]+)"/)[1];
    assert.equal(new URL(href, url).pathname, '/' + manifestPath);
    assert.match(html, /apple-mobile-web-app-title" content="SNH Pinball"/);
    assert.match(html, /viewport-fit=cover/);
    assert.match(html, /<header id="page-top" tabindex="-1">/);
    assert.match(html, /href="#page-top" aria-label="Back to top of this page"><img/);
    const nav = html.match(/<nav aria-label="Main navigation">([\s\S]*?)<\/nav>/)[1];
    assert.doesNotMatch(nav, /target=|https?:/);
    for (const [, link] of nav.matchAll(/href="([^"]+)"/g)) {
      const destination = new URL(link, url);
      assert.equal(destination.origin, url.origin);
      assert.ok(existsSync(destination.pathname.slice(1)));
    }
  }
  for (const icon of manifest.icons) {
    const png = readFileSync('assets/pwa/' + icon.src);
    const size = Number(icon.sizes.split('x')[0]);
    assert.equal(png.readUInt32BE(16), size);
    assert.equal(png.readUInt32BE(20), size);
  }
});

test('theme meta uses resolved literal colors before CSS loads and after preference/system changes', () => {
  const attrs = { class: 'clubhouse' };
  const listeners = {};
  const meta = { setAttribute: (key, value) => { meta[key] = value; } };
  const mql = { matches: false, addEventListener: (event, callback) => { listeners[event] = callback; } };
  const root = { getAttribute: key => attrs[key], setAttribute: (key, value) => { attrs[key] = value; }, removeAttribute: key => { delete attrs[key]; } };
  const window = { localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, matchMedia: () => mql, addEventListener() {} };
  const document = { documentElement: root, head: {}, readyState: 'loading', addEventListener() {}, getElementById: () => null, querySelector: selector => selector.includes('theme-color') ? meta : null };
  vm.runInNewContext(readFileSync('assets/js/theme.js', 'utf8'), { window, document, getComputedStyle: () => ({ getPropertyValue: () => '' }) });
  assert.equal(meta.content, '#f4f2eb');
  window.SNHTheme.set('dark');
  assert.equal(meta.content, '#0b151e');
  window.SNHTheme.set('light');
  assert.equal(meta.content, '#f4f2eb');
  window.SNHTheme.set('system');
  mql.matches = true;
  listeners.change();
  assert.equal(meta.content, '#0b151e');
});
