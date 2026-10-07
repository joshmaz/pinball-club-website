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


test('member role controls use canonical delegation while membership editing stays available', async () => {
  const html = await read('members.html');
  const source = html.slice(html.indexOf('    function adminMayManageRole('), html.indexOf('    function adminHasUnsaved('));
  const context = { window: {}, userRoles: [] };
  vm.runInNewContext(await read('assets/js/site-auth.js'), context);
  vm.runInNewContext(source, context);
  for (const [roles, target, expected] of [
    [['membership_editor'], 'events_editor', false],
    [['membership_editor'], 'membership_editor', false],
    [['membership_admin'], 'membership_editor', true],
    [['membership_admin'], 'games_admin', true],
    [['membership_admin'], 'membership_admin', false],
    [['membership_admin'], 'club_admin', false],
    [['club_admin'], 'membership_admin', true],
    [['club_admin'], 'club_admin', true],
    [['club_admin'], 'website_volunteer', false],
    [['club_admin'], 'unknown_role', false]
  ]) {
    context.userRoles = roles;
    assert.equal(context.adminMayManageRole(target), expected);
  }
  assert.match(html, /if \(adminMayRemoveRole\(row, slug\)\)/);
  assert.match(html, /return adminMayManageRole\(slug\) && !\(row.role_slugs/);
  assert.match(html, /if \(select.options.length === 1\) grant.hidden = true/);
  assert.match(html, /!adminMayManageRole\(select.value\)/);
  assert.match(html, /setMemberMembership\(row.member_id/);
  assert.match(html, /data-rbac-roles="membership_editor,membership_admin,club_admin"/);
});

test('administrator removal uses member identity regardless of email', async () => {
  const html = await read('members.html');
  const source = html.slice(html.indexOf('    function adminMayManageRole('), html.indexOf('    function adminHasUnsaved('));
  const loadSource = html.slice(html.indexOf('    onMemberAdminPanelShown = async function'), html.indexOf('    memberAdminRefresh.addEventListener'));
  const context = {
    window: { SNHMemberPortal: {
      async fetchProfile(userId) {
        assert.equal(userId, 'auth-user');
        return { id: 'signed-in-member', user_id: userId, email: 'old@example.com' };
      },
      async fetchMemberAdminStats() {
        assert.equal(context.currentAdminMemberId, 'signed-in-member', 'resolve member identity before loading the directory');
        return null;
      },
      async listMembersForAdmin() { return []; }
    } },
    userRoles: ['club_admin'], currentAdminMemberId: null, memberAdminStatus: {},
    session: { user: { id: 'auth-user', email: 'current@example.com' } }
  };
  vm.runInNewContext(await read('assets/js/site-auth.js'), context);
  vm.runInNewContext(source + '\n' + loadSource, context);
  await context.onMemberAdminPanelShown();
  const self = { member_id: 'signed-in-member', email: 'old@example.com' };
  const other = { member_id: 'other-member', email: 'current@example.com' };
  assert.equal(context.adminMayRemoveRole(self, 'club_admin'), false, 'mismatched email must not expose self-removal');
  assert.equal(context.adminMayRemoveRole(other, 'club_admin'), true, 'matching email must not hide another administrator');
  assert.equal(context.adminMayRemoveRole(self, 'membership_editor'), true);
  context.currentAdminMemberId = null;
  assert.equal(context.adminMayRemoveRole(self, 'club_admin'), false, 'unresolved identity must not expose self-removal');
  assert.equal(context.adminMayRemoveRole(other, 'membership_editor'), true);
  context.currentAdminMemberId = 'signed-in-member';
  context.userRoles = ['membership_admin'];
  assert.equal(context.adminMayRemoveRole(other, 'club_admin'), false);
  context.userRoles = ['membership_editor'];
  assert.equal(context.adminMayRemoveRole(other, 'membership_editor'), false);
});
