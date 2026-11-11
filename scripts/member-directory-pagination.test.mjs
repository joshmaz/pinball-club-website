import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const html = await readFile(new URL('../members.html', import.meta.url), 'utf8');
function setup(count) {
  class Element {
    children=[]; listeners={}; attributes={}; value='';
    append(...children) {this.children.push(...children);}
    appendChild(child) {this.append(child);return child;}
    replaceChildren() {this.children=[];}
    contains(el) {return this===el || this.children.some(c=>c.contains(el));}
    setAttribute(k,v) {this.attributes[k]=v;}
    getAttribute(k) {return this.attributes[k];}
    addEventListener(k,fn) {this.listeners[k]=fn;}
    querySelectorAll() {return [];}
    focus() {ctx.document.activeElement=this;}
  }
  const ctx={adminRows:Array.from({length:count},(_,i)=>({member_id:String(i),display_name:`Member ${i}`,email_verified:true})),adminPage:1,adminPageSize:20,adminExpandedId:null,adminDraft:null,allowDiscard:true,
    memberAdminTableBody:new Element(),memberAdminPagination:new Element(),memberAdminSearch:{value:''},memberAdminDirectoryFilter:{value:'all'},memberAdminDirectorySort:{value:'default'},
    window:{SNHMemberPortal:{formatDate:value=>value.slice(0,10)}},
    adminMemberName:r=>r.display_name,adminConfirmDiscard:()=>ctx.allowDiscard,adminRenderEditor(){},rolePresentation:{renderAssignments(){}},document:{activeElement:null,createElement:()=>new Element(),getElementById(id){function find(e){return e.id===id?e:e.children.map(find).find(Boolean);}return find(ctx.memberAdminPagination);}}};
  vm.createContext(ctx);
  vm.runInContext(html.slice(html.indexOf('    function adminCell('),html.indexOf('    function adminRenderEditor(')),ctx);
  ctx.adminRender();return ctx;
}
test('page sizes reset, bound refreshed results, and preserve unsaved edits and keyboard focus',()=>{
  const c=setup(53), control=id=>c.document.getElementById(id);
  assert.equal(c.memberAdminTableBody.children.length,20);
  control('member-admin-next-page').focus();control('member-admin-next-page').listeners.click();
  assert.equal(c.adminPage,2);assert.equal(c.document.activeElement.id,'member-admin-next-page');
  const select=control('member-admin-page-size');select.value='50';c.allowDiscard=false;select.listeners.change();
  assert.equal(c.adminPageSize,20);assert.equal(select.value,'20');assert.equal(c.adminPage,2);
  c.allowDiscard=true;select.value='50';select.focus();select.listeners.change();
  assert.equal(c.adminPage,1);assert.equal(c.memberAdminTableBody.children.length,50);assert.equal(c.document.activeElement.id,'member-admin-page-size');
  control('member-admin-next-page').listeners.click();assert.equal(c.memberAdminTableBody.children.length,3);assert.equal(control('member-admin-next-page').disabled,true);
  c.adminRows=[];c.adminRender();assert.equal(c.adminPage,1);assert.equal(control('member-admin-prev-page').disabled,true);assert.equal(control('member-admin-next-page').disabled,true);
  assert.match(c.memberAdminPagination.children[2].textContent,/0 of 0 members/);
  c.adminPage=-2;c.adminRender();assert.equal(c.adminPage,1);
});

test('last sign-in sorting applies to all filtered members before pagination',()=>{
  const c=setup(53);
  const visibleIds=()=>c.memberAdminTableBody.children.map(row=>row.children[0].children[0].getAttribute('data-member-focus'));
  Object.assign(c.adminRows[40],{last_sign_in_at:'2026-11-10T18:00:00Z',membership_status:'active'});
  Object.assign(c.adminRows[41],{last_sign_in_at:null,membership_status:'active'});
  Object.assign(c.adminRows[42],{last_sign_in_at:'2026-10-01T18:00:00Z',membership_status:'active'});
  Object.assign(c.adminRows[43],{last_sign_in_at:'2026-11-11T18:00:00Z'});
  c.memberAdminDirectorySort.value='recent';
  c.adminRender();
  assert.deepEqual(visibleIds().slice(0,4),['43','40','42','41']);
  c.memberAdminDirectorySort.value='oldest';
  c.memberAdminDirectoryFilter.value='active';
  c.adminRender();
  assert.deepEqual(visibleIds(),['41','42','40']);
  assert.deepEqual(c.memberAdminTableBody.children.map(row=>row.children[3].textContent),
    ['Never signed in','2026-10-01','2026-11-10']);
  c.memberAdminDirectorySort.value='default';
  c.adminRender();
  assert.deepEqual(visibleIds(),['40','41','42']);
});
