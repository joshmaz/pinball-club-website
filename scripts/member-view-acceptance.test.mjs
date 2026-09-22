import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);
const read = (path) => readFile(new URL(path, root), 'utf8');

test('directory labels map Basic and Full Access to existing inactive and active values', async () => {
  const html = await read('members.html');
  assert.match(html, /<option value="active">Full Access Members<\/option>/);
  assert.match(html, /<option value="inactive">Basic Members<\/option>/);
  const source = html.slice(html.indexOf('    function adminMemberName('), html.indexOf('    function adminHasUnsaved('));
  const filterSource = html.slice(html.indexOf('    function memberMatchesDirectoryFilter('), html.indexOf('    function adminRender()'));
  const context = {};
  vm.runInNewContext(source + '\n' + filterSource, context);
  const basic = { first_name: 'Alice', membership_status: null, role_slugs: [] };
  const full = { first_name: 'Bob', membership_status: 'active', role_slugs: [] };
  assert.equal(context.memberMatchesDirectoryFilter(basic, 'inactive', ''), true);
  assert.equal(context.memberMatchesDirectoryFilter(full, 'inactive', ''), false);
  assert.equal(context.memberMatchesDirectoryFilter(full, 'active', ''), true);
  assert.equal(context.memberMatchesDirectoryFilter(basic, 'active', ''), false);
  assert.equal(context.memberMatchesDirectoryFilter(full, 'all', 'bob'), true);
});

test('Events source note is hidden publicly and shown to permitted editors', async () => {
  const source = await read('assets/js/events.js');
  const fn = source.slice(source.indexOf('function setDataSourceNote('), source.indexOf('function startOfToday()'));
  let note;
  const container = { parentNode: { insertBefore(value) { note = value; } } };
  const context = {
    document: { getElementById() { return note; }, createElement() { return { hidden: false, textContent: '' }; } },
    window: { SNHPublicData: { sourceLabel: () => 'Data source: Supabase' } }
  };
  vm.runInNewContext(fn, context);
  context.setDataSourceNote(container, {}, false);
  assert.equal(note.hidden, true);
  assert.equal(note.textContent, '');
  context.setDataSourceNote(container, {}, true);
  assert.equal(note.hidden, false);
  assert.equal(note.textContent, 'Data source: Supabase');
});

test('Games source note is hidden publicly and shown to permitted editors', async () => {
  const source = await read('assets/js/games.js');
  const fn = source.slice(source.indexOf('async function fetchGamesCatalogPayload()'), source.indexOf('/** Club opened'));
  for (const allowed of [false, true]) {
    let note;
    const container = { before(value) { note = value; } };
    const context = {
      document: { getElementById(id) { return id === 'games-list' ? container : note; }, createElement() { return { hidden: false, textContent: '' }; } },
      window: { SNHPublicData: { loadGames: async () => ({ data: [], source: 'supabase' }), sourceLabel: () => 'Data source: Supabase' } },
      currentUserCanManageGames: async () => allowed
    };
    vm.runInNewContext(fn, context);
    await context.fetchGamesCatalogPayload();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(note.hidden, !allowed);
    assert.equal(note.textContent, allowed ? 'Data source: Supabase' : '');
  }
});
