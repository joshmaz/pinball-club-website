import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const source=await readFile(new URL('../assets/js/site-auth.js',import.meta.url),'utf8');
const context={window:{}};
vm.createContext(context); vm.runInContext(source,context);
const auth=context.window.SNHSiteAuth;

test('Publishing is independent, Admin inherits Editor, and Website Administrator inherits both',()=>{
  const cases=[
    [[],false,false], [['publishing_editor'],true,false], [['publishing_admin'],true,true],
    [['club_admin'],true,true], [['membership_admin'],false,false], [['events_admin'],false,false],
    [['photos_editor','games_admin'],false,false], [['publishing_owner'],false,false]
  ];
  for (const [roles,manage,remove] of cases) {
    assert.equal(auth.can(roles,'publishing.manage'),manage,JSON.stringify(roles));
    assert.equal(auth.can(roles,'publishing.delete'),remove,JSON.stringify(roles));
  }
  for (const role of ['publishing_editor','publishing_admin']) {
    assert.equal(auth.can([role],'website.volunteer'),true);
    for (const capability of ['membership.manage','events.manage','photos.manage','games.manage']) {
      assert.equal(auth.can([role],capability),false);
    }
  }
  assert.deepEqual(Array.from(auth.getEffectiveRoles(['publishing_admin'])),
    ['publishing_admin','publishing_editor','website_volunteer']);
});

test('Publishing roles are assignable only by Membership Admin or Website Administrator',()=>{
  const roles=Object.keys(auth.ROLE_CATALOG).filter(slug=>auth.ROLE_CATALOG[slug].assignable);
  assert.equal(roles.length,11);
  for (const actor of roles) for (const target of ['publishing_editor','publishing_admin']) {
    assert.equal(auth.canAssignMemberRole([actor],target),['club_admin','membership_admin'].includes(actor));
  }
  assert.equal(auth.canAssignMemberRole(['membership_admin'],'club_admin'),false);
  assert.equal(auth.canAssignMemberRole(['membership_admin'],'membership_admin'),false);
  assert.equal(auth.canAssignMemberRole(['club_admin'],'website_volunteer'),false);
});
