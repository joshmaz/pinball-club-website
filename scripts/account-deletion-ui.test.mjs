import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const deletion=await readFile(new URL('../assets/js/member-account-deletion.js',import.meta.url),'utf8');
const trends=await readFile(new URL('../assets/js/member-membership-trends.js',import.meta.url),'utf8');
class Element {
  constructor(tag){this.tag=tag;this.children=[];this.listeners={};this.attributes={};this.value='';this.textContent='';}
  appendChild(el){this.children.push(el);return el;}
  append(...els){this.children.push(...els);}
  setAttribute(key,value){this.attributes[key]=value;}
  addEventListener(key,fn){this.listeners[key]=fn;}
  replaceChildren(){this.children=[];}
  reportValidity(){return true;}
  all(tag){return [this,...this.children.flatMap(c=>c.all(tag))].filter(c=>!tag||c.tag===tag);}
  text(){return this.textContent+this.children.map(c=>c.text()).join(' ');}
}
function setup(source,options={}) {
  const calls=[],store=new Map(options.saved||[]),root=new Element('root');
  const storage={getItem:k=>store.get(k)||null,setItem:(k,v)=>store.set(k,v),removeItem:k=>store.delete(k),key:i=>[...store.keys()][i],get length(){return store.size;}};
  const window={SNH_CONFIG:{supabaseUrl:'https://test.supabase.co',supabaseAnonKey:'public'},SNHSiteAuth:{getSession:async()=>{if(options.noSession)throw Error('Expired');return {access_token:'jwt'};},signOut:async()=>{calls.push('signOut');}},location:{assign:path=>calls.push(path)},snhSupabase:{rpc:async()=>({data:options.rows||[]})}};
  const context={window,sessionStorage:storage,AbortSignal,Intl,Date: options.now ? class extends Date { constructor(...args) { super(...(args.length ? args : [options.now])); } } : Date,document:{createElement:t=>new Element(t),createElementNS:(_ns,t)=>new Element(t)},fetch:async(_url,init)=>{
    const body=JSON.parse(init.body);calls.push(body);
    if(body.action==='prepare')return {ok:true,json:async()=>({receipt:'receipt'})};
    if(body.action==='delete'&&options.timeout)throw Error('Timeout');
    return {ok:true,json:async()=>({completed:body.action==='status'?options.completed!==false:true})};
  }};
  vm.runInNewContext(source,context);return {window,root,calls,store};
}
test('self deletion warns for every status, requires typed confirmation and password, and clears password after a lost response',async()=>{
 const f=setup(deletion,{timeout:true});f.window.SNHAccountDeletion.mount(f.root,{actorId:'self'});
 assert.match(f.root.text(),/does not cancel PayPal/);assert.match(f.root.text(),/Basic or inactive membership/);
 const inputs=f.root.all('input');assert.equal(inputs.find(i=>i.type==='password').autocomplete,'current-password');assert.equal(inputs.find(i=>i.type==='text').pattern,'DELETE');assert.ok(inputs.every(i=>i.required));
 inputs.find(i=>i.type==='password').value='secret';inputs.find(i=>i.type==='checkbox').checked=true;inputs.find(i=>i.type==='text').value='DELETE';
 const form=f.root.all('form')[0];await form.listeners.submit({preventDefault(){}});
 assert.equal(inputs.find(i=>i.type==='password').value,'');assert.equal(form.hidden,true);assert.equal(f.store.size,1);
 assert.equal(f.calls[0].memberId,null);assert.equal(f.calls[0].billingAcknowledged,true);
 const check=f.root.all('button').find(b=>b.textContent==='Check deletion status');await check.listeners.click();
 assert.ok(f.calls.includes('signOut'));assert.ok(f.calls.includes('signin.html?account=deleted'));assert.equal(f.store.size,0);
});
test('Website Administrator self deletion is explained; pending status can be checked without a valid session',async()=>{
 const admin=setup(deletion);admin.window.SNHAccountDeletion.mount(admin.root,{actorId:'self',websiteAdmin:true});assert.equal(admin.root.all('form').length,0);assert.match(admin.root.text(),/Another Website Administrator/);
 const pending=setup(deletion,{noSession:true,saved:[['snh-account-deletion:self','receipt']]});pending.window.SNHAccountDeletion.recoverPending(pending.root);
 await pending.root.all('button')[0].listeners.click();assert.match(pending.root.text(),/deletion completed/);assert.equal(pending.calls[0].action,'status');
});
test('admin deletion names the exact account, requires reason, and refreshes only after confirmed success',async()=>{
 let refreshed=0;const f=setup(deletion);f.window.SNHAccountDeletion.mount(f.root,{memberId:'target',actorId:'actor',name:'Member Name',email:'member@example.test',onDeleted:async()=>refreshed++});
 assert.match(f.root.text(),/Member Name \(member@example.test\)/);const inputs=f.root.all('input');inputs[0].value='Requested';inputs.find(i=>i.type==='password').value='secret';inputs.find(i=>i.type==='checkbox').checked=true;inputs.find(i=>i.pattern==='DELETE').value='DELETE';
 await f.root.all('form')[0].listeners.submit({preventDefault(){}});assert.equal(f.calls[0].reason,'Requested');assert.equal(f.calls[0].memberId,'target');assert.equal(refreshed,1);assert.ok(!f.calls.includes('signOut'));
});
test('weekly graph uses a fixed year with monthly divisions, a counts table and gaps for missing weeks',async()=>{
 const row=(date,n)=>({snapshot_date:date,account_count:n,basic_count:n-1,full_access_count:1,volunteer_count:1,unverified_count:0});
 const f=setup(trends,{now:'2026-10-15T12:00:00Z',rows:[row('2026-09-27',4),row('2026-10-04',5),row('2026-10-15',6)]});await f.window.SNHMembershipTrends.render(f.root);
 assert.match(f.root.text(),/4 a.m. Eastern/);assert.match(f.root.text(),/2026-10-15/);assert.equal(f.root.all('table').length,1);
 assert.match(f.root.all('svg')[0].attributes['aria-label'],/X axis: date with monthly divisions. Y axis: number of accounts/);
 assert.equal(f.root.all('path').length,2);assert.equal(f.root.all('circle').length,3);
 assert.equal(f.root.all('line').length,13);
 assert.match(f.root.text(),/Weekly membership counts/);
 assert.match(f.root.text(),/Nov 25/);assert.match(f.root.text(),/Oct 26/);
 const points=f.root.all('circle').map(c=>Number(c.attributes.cx));
 assert.ok(points[0]>600,'new history stays at the end of the year instead of stretching across it');
 assert.ok(Math.abs((points[1]-points[0])/(points[2]-points[1])-7/11)<0.001,'points use actual dates, not month buckets');
 const empty=setup(trends);await empty.window.SNHMembershipTrends.render(empty.root);assert.equal(empty.root.all('svg').length,0);assert.match(empty.root.text(),/Earlier membership totals are not available/);
});
