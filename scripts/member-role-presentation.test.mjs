import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const read = path => readFile(new URL('../' + path, import.meta.url), 'utf8');
const authSource = await read('assets/js/site-auth.js');
const presentationSource = await read('assets/js/member-role-presentation.js');
const html = await read('members.html');

class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.attributes = {}; this.listeners = {}; this.value = ''; }
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return (this.text || '') + this.children.map(child => child.textContent).join(' '); }
  append(...children) { this.children.push(...children); }
  appendChild(child) { this.append(child); return child; }
  replaceChildren(...children) { this.text = ''; this.children = children; }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  addEventListener(event, listener) { this.listeners[event] = listener; }
  get options() { return this.children; }
}
function all(root, predicate) {
  return [root, ...root.children.flatMap(child => all(child, () => true))].filter(predicate);
}
function setup(client = null) {
  const document = { createElement: tag => new Element(tag), createElementNS: (_, tag) => new Element(tag) };
  const context = { window: { snhSupabase: client }, document };
  vm.createContext(context);
  vm.runInContext(authSource, context);
  const auth = context.window.SNHSiteAuth;
  context.window.SNHMemberPortal = {
    ASSIGNABLE_MEMBER_ROLES: Object.keys(auth.ROLE_CATALOG).filter(slug => auth.ROLE_CATALOG[slug].assignable),
    formatDate: () => 'Today', getFriendlyAuthErrorMessage: error => error.message
  };
  vm.runInContext(presentationSource, context);
  return { context, auth, ui: context.window.SNHMemberRolePresentation };
}

test('assignment badges retain actual assignments, never expand inheritance or derived Volunteer', () => {
  const { ui } = setup();
  for (const [roles, names, kinds] of [
    [['games_editor'], ['Games Editor'], ['editor']],
    [['photos_admin'], ['Photos Admin'], ['admin']],
    [['club_admin'], ['Website Administrator'], ['website']],
    [['events_editor', 'games_admin'], ['Events Editor', 'Games Admin'], ['editor', 'admin']],
    [['games_admin', 'games_editor'], ['Games Admin', 'Games Editor'], ['admin', 'editor']],
    [['website_volunteer'], [], []]
  ]) {
    const root = new Element('div');
    ui.renderAssignments(root, roles);
    const badges = all(root, el => (el.className || '').startsWith('member-role-badge '));
    assert.deepEqual(badges.map(el => el.textContent.trim()), names);
    assert.deepEqual(badges.map(el => el.className.split('--')[1]), kinds);
    for (const icon of all(root, el => el.tag === 'svg')) assert.equal(icon.attributes['aria-hidden'], 'true');
  }
});

test('effective access is explanatory text with canonical inherited names', () => {
  const { ui } = setup();
  const root = new Element('div');
  ui.renderAccess(root, ['club_admin']);
  for (const text of ['Included through Website Administrator', 'Membership Admin', 'Events Admin', 'Photos Admin', 'Games Admin', 'Editor access', 'Website Volunteer']) assert.ok(root.textContent.includes(text));
  assert.equal(all(root, el => (el.className || '').includes('member-role-badge')).length, 0);
  assert.doesNotMatch(root.textContent, /club_admin|membership_admin/);
  ui.renderAccess(root, ['games_admin']);
  assert.match(root.textContent, /Included through Games Admin: Games Editor/);
});

test('delegation copy and targets follow the existing helper', () => {
  const { ui, auth, context } = setup();
  for (const roles of [['membership_editor'], ['membership_admin'], ['club_admin'], ['unknown']]) {
    assert.deepEqual(Array.from(ui.assignable(roles)), context.window.SNHMemberPortal.ASSIGNABLE_MEMBER_ROLES.filter(slug => auth.canAssignMemberRole(roles, slug)));
  }
  assert.doesNotMatch(ui.intro(['membership_editor']), /assign|remove|grant|revoke|hand off/i);
  assert.match(ui.intro(['membership_admin']), /Assign or remove.*role selector/);
  assert.doesNotMatch(ui.intro(['membership_admin']), /Website Administrator|Membership Admin/);
  assert.match(ui.intro(['club_admin']), /including administrator roles/);
});

test('removal explains access that remains through another assignment', () => {
  const { ui } = setup();
  assert.match(ui.removalMessage(['games_editor', 'games_admin'], 'games_editor', 'Alex'), /Games Editor access will remain through Games Admin/);
  assert.match(ui.removalMessage(['club_admin', 'photos_admin'], 'photos_admin', 'Alex'), /Photos Admin access will remain through Website Administrator/);
  assert.doesNotMatch(ui.removalMessage(['games_admin'], 'games_admin', 'Alex'), /will remain|games_admin/);
  assert.equal(ui.errorMessage(new Error('Cannot remove the last Club Admin')), 'Cannot remove the last Website Administrator');
  assert.equal(ui.errorMessage(new Error('games_admin required')), 'Games Admin required');
});

test('unknown identifiers stay neutral and fail closed; empty and failed states differ', () => {
  const { ui, auth } = setup();
  const root = new Element('div');
  ui.renderProfile(root, ['unknown_secret_slug'], false);
  assert.match(root.textContent, /Unrecognized role/);
  assert.doesNotMatch(root.textContent, /unknown_secret_slug|Website Volunteer/);
  assert.deepEqual(Array.from(auth.getEffectiveRoles(['unknown_secret_slug'])), []);
  assert.equal(auth.canAssignMemberRole(['unknown_secret_slug'], 'games_editor'), false);
  ui.renderProfile(root, [], false);
  assert.match(root.textContent, /No website roles are assigned.*separate from membership status/);
  ui.renderProfile(root, [], true);
  assert.match(root.textContent, /Couldn’t load/);
  assert.doesNotMatch(root.textContent, /No website roles|None/);
});

test('strict presentation loader propagates member and assignment query failures', async () => {
  for (const failAt of [null, 'members', 'member_roles']) {
    const error = new Error('query unavailable');
    const client = { from(table) { return {
      select() { return this; },
      eq() { return table === 'members' ? this : Promise.resolve({ data: [], error: failAt === table ? error : null }); },
      async maybeSingle() { return { data: { id: 'member' }, error: failAt === table ? error : null }; }
    }; } };
    const { auth } = setup(client);
    if (failAt) await assert.rejects(auth.loadMemberRoles('user'), err => err === error);
    else assert.deepEqual(Array.from(await auth.loadMemberRoles('user')), []);
  }
  await assert.rejects(setup().auth.loadMemberRoles('user'), /unavailable/);
});

test('real expanded row uses canonical names, assigned-only removal and delegation controls', () => {
  for (const actor of ['membership_editor', 'membership_admin', 'club_admin']) {
    const { context, ui, auth } = setup();
    const root = new Element('tbody');
    Object.assign(context, {
      rolePresentation: ui, memberAdminTableBody: root, adminDraft: null, adminSaving: false,
      adminMemberName: () => 'Alex', adminHasUnsaved: () => false,
      adminMayManageRole: slug => auth.canAssignMemberRole([actor], slug),
      adminMayRemoveRole: (_, slug) => auth.canAssignMemberRole([actor], slug), userRoles: [actor]
    });
    vm.runInContext(html.slice(html.indexOf('    function adminRenderEditor(row)'), html.indexOf('    onMemberAdminPanelShown = async')), context);
    context.adminRenderEditor({ member_id: 'target', role_slugs: ['games_admin'], membership_status: 'active' });
    assert.match(root.textContent, /Games Admin/);
    assert.doesNotMatch(root.textContent, /games_admin/);
    const buttons = all(root, el => el.tag === 'button');
    assert.equal(buttons.some(el => el.textContent === 'Remove'), actor !== 'membership_editor');
    assert.equal(buttons.filter(el => el.textContent === 'Remove').length, actor === 'membership_editor' ? 0 : 1);
    assert.equal(buttons.some(el => el.textContent === 'Assign role'), actor !== 'membership_editor');
    const options = all(root, el => el.tag === 'option' && el.value && auth.ROLE_CATALOG[el.value]);
    for (const option of options) {
      assert.equal(option.textContent, auth.ROLE_CATALOG[option.value].displayName);
      assert.equal(auth.canAssignMemberRole([actor], option.value), true);
    }
  }
});

test('existing directory filtering keeps membership and name/email matching independent of badges', () => {
  const context = { adminMemberName: row => row.first_name };
  vm.createContext(context);
  vm.runInContext(html.slice(html.indexOf('    function memberMatchesDirectoryFilter('), html.indexOf('    function adminRender()')), context);
  const row = { first_name: 'Alex', email: 'alex@example.com', membership_status: 'active', role_slugs: ['games_editor'] };
  const match = context.memberMatchesDirectoryFilter;
  assert.equal(match(row, 'with-roles', 'alex'), true);
  assert.equal(match(row, 'all', 'example.com'), true);
  assert.equal(match(row, 'inactive', ''), false);
  assert.equal(match(row, 'active', 'unmatched'), false);
  assert.equal(match({ ...row, role_slugs: [] }, 'with-roles', ''), false);
});

test('directory wiring retains search, pagination, expansion, focus and unsaved safeguards', () => {
  assert.match(html, /rolePresentation\.renderAssignments\(adminCell\(tr, ""\), row\.role_slugs/);
  assert.match(html, /<th scope="col">Assigned roles<\/th>/);
  assert.match(html, /\["Role assignments", stats.member_roles_count\]/);
  for (const text of ['memberMatchesDirectoryFilter(row, mode, query)', 'filtered.slice((adminPage - 1) * 25, adminPage * 25)',
    'aria-expanded', 'aria-controls', 'restore.focus()', 'if (!adminConfirmDiscard()) return;', 'beforeunload']) assert.ok(html.includes(text), text);
  assert.doesNotMatch(html, /slug\.replace\(/);
  assert.match(html, /rolePresentation\.name\(granted\) \+ " assigned to "/);
});
