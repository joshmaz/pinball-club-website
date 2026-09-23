import vm from "node:vm";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicPages = [
  "index.html",
  "signin.html",
  "about.html",
  "events.html",
  "games.html",
  "merch.html",
  "resources.html",
  "members.html",
  "donate/index.html"
];

test("major public pages progressively load the shared account navigation", async () => {
  for (const page of publicPages) {
    const html = await readFile(path.join(root, page), "utf8");
    assert.match(html, /data-site-account-link/);
    assert.match(html, /site-account\.js/);
    assert.ok(html.indexOf("supabase-init.js") < html.indexOf("site-auth.js"), page);
    assert.ok(html.indexOf("site-auth.js") < html.indexOf("site-account.js"), page);
  }
});

test("nested donation navigation retains its parent-relative account paths", async () => {
  const html = await readFile(path.join(root, "donate", "index.html"), "utf8");
  assert.match(html, /href="\.\.\/signin\.html" data-site-account-link/);
  assert.match(html, /src="\.\.\/assets\/js\/site-account\.js"/);
});

test("the member dashboard keeps its sidebar logout and redirects after header sign-out", async () => {
  const html = await readFile(path.join(root, "members.html"), "utf8");
  const source = await readFile(path.join(root, "assets", "js", "site-account.js"), "utf8");
  assert.match(html, /id="logout-btn"/);
  assert.match(source, /window\.location\.pathname\.split\("\/"\)\.pop\(\) === "members\.html"/);
  assert.match(source, /window\.location\.href = signinHref/);
});

function accountHarness({ pathname = '/index.html', initial = null, rejectSignout = false } = {}) {
  function element() {
    return { attrs: {}, children: [], events: {}, textContent: '', hidden: false,
      setAttribute(k,v) { this.attrs[k]=v; }, getAttribute(k) { return this.attrs[k]; }, removeAttribute(k) { delete this.attrs[k]; },
      appendChild(el) { this.children.push(el); }, addEventListener(k,fn) { this.events[k]=fn; },
      focus() { this.focused = true; } };
  }
  const link = element(); link.attrs.href = pathname.startsWith('/donate/') ? '../signin.html' : 'signin.html';
  const actions = element(); let notify, resolveSession, calls = 0;
  const pending = new Promise(resolve => { resolveSession = resolve; });
  const window = { location: { pathname }, SNHSiteAuth: {
    getSession: () => pending,
    onAuthStateChange: fn => { notify = fn; },
    signOut: async () => { calls++; if (rejectSignout) throw new Error('unavailable'); }
  } };
  const document = { querySelector: selector => selector === '[data-site-account-link]' ? link : actions, createElement: element };
  return { window, document, link, actions, notify: session => notify('CHANGE', session), resolve: () => resolveSession(initial), calls: () => calls };
}
const accountSource = await readFile(path.join(root, 'assets/js/site-account.js'), 'utf8');
const signedIn = { user: { id: 'test-user' } };
async function startAccount(options) {
  const app = accountHarness(options);
  vm.runInNewContext(accountSource, { window: app.window, document: app.document, console: { warn() {} } });
  app.resolve(); await Promise.resolve(); await Promise.resolve();
  return app;
}

test('header account actions follow session changes and retain nested paths', async () => {
  const app = await startAccount({ pathname: '/donate/index.html' });
  const [button] = app.actions.children;
  assert.equal(app.link.href, '../signin.html'); assert.equal(button.hidden, true);
  app.notify(signedIn);
  assert.equal(app.link.href, '../members.html'); assert.equal(app.link.textContent, 'My Account');
  assert.equal(button.hidden, false);
  await button.events.click();
  assert.equal(app.calls(), 1); assert.equal(button.hidden, true);
  assert.equal(app.link.href, '../signin.html'); assert.equal(app.link.focused, true);
});

test('header sign-out redirects from the member dashboard', async () => {
  const app = await startAccount({ pathname: '/members.html', initial: signedIn });
  await app.actions.children[0].events.click();
  assert.equal(app.window.location.href, 'signin.html');
});

test('failed sign-out keeps the account link and enables retry with visible feedback', async () => {
  const app = await startAccount({ initial: signedIn, rejectSignout: true });
  const [button, status] = app.actions.children;
  await button.events.click();
  assert.equal(button.hidden, false); assert.equal(button.disabled, false);
  assert.equal(app.link.href, 'members.html');
  assert.match(status.textContent, /Could not sign out/);
  assert.equal(app.window.location.href, undefined);
});

test('a newer auth notification is not overwritten by a stale initial session', async () => {
  const app = accountHarness({ initial: signedIn });
  vm.runInNewContext(accountSource, { window: app.window, document: app.document, console });
  app.notify(null); app.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.equal(app.link.href, 'signin.html'); assert.equal(app.actions.children[0].hidden, true);
});
