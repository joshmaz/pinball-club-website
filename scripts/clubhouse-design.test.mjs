import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import vm from 'node:vm';
const read = file => readFile(new URL('../' + file, import.meta.url), 'utf8');

test('normal homepage retains dynamic content and no duplicate comparison route', async () => {
  const html = await read('index.html');
  for (const hook of ['home-gallery.js','home-highlights.js','public-data.js','site-auth.js','site-account.js','id="gallery-image"','id="home-highlights-grid"']) assert.ok(html.includes(hook), hook);
  for (const href of ['events.html','games.html','merch.html','resources.html','about.html','signin.html','donate/','mailto:support@snhpinballclub.com','tel:+16034868659']) assert.ok(html.includes('href="'+href+'"'), href);
  assert.doesNotMatch(html,/home-prototype\.html|Compare with|design study|name="robots"/i);
  await assert.rejects(access(new URL('../home-prototype.html',import.meta.url)), {code:'ENOENT'});
});

test('all seven approved routes share the theme selector without changing other pages', async () => {
  for (const page of ['index.html','events.html','games.html','members.html','resources.html','merch.html','about.html']) {
    const html = await read(page);
    assert.match(html,/assets\/css\/clubhouse\.css/);
    assert.match(html,/assets\/js\/clubhouse\.js/);
    assert.equal((html.match(/id="club-theme"/g)||[]).length,1);
    assert.match(html,/SNHPC_logo_color\.png/);
  }
  for (const page of ['signin.html','donate/index.html']) assert.doesNotMatch(await read(page),/clubhouse\.(css|js)/);
});

test('game search is case-insensitive, conjunctive, nonmutating and preserves lineup order', async () => {
  const source = await read('assets/js/games.js');
  const context = vm.createContext({});
  vm.runInContext(source.slice(source.indexOf('function filterGamesByQuery('), source.indexOf('function renderGamesList(')),context);
  const lineup = [{title:'Star Wars',details:'Stern premium'},{title:'Future Spa',details:'1979 Bally'},{title:'Star Trek',details:'Stern pro'}];
  assert.deepEqual(Array.from(context.filterGamesByQuery(lineup,'  STAR stern ')),[lineup[0],lineup[2]]);
  assert.deepEqual(Array.from(context.filterGamesByQuery(lineup,'BALLY')),[lineup[1]]);
  assert.deepEqual(Array.from(context.filterGamesByQuery(lineup,'')),lineup);
  assert.equal(context.filterGamesByQuery(lineup,'zzzz').length,0);
  assert.equal(lineup.length,3);
});
