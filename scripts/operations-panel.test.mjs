import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const source=await readFile(new URL('../assets/js/member-operations-panel.js',import.meta.url),'utf8');
function fixture(pinballmap=null) {
 function el(tag='div') {return {tag,children:[],dataset:{},attrs:{},listeners:{},textContent:'',
 appendChild(n){this.children.push(n);},replaceChildren(){this.children=[];},setAttribute(k,v){this.attrs[k]=v;},
 addEventListener(k,v){this.listeners[k]=v;},reportValidity(){return true;},checkValidity(){return true;},
 querySelectorAll(selector){return this.children.flatMap(c=>[...(selector.split(',').map(s=>s.trim()).includes(c.tag)?[c]:[]),...c.querySelectorAll(selector)]);}};}
 const nodes=new Map(['member-panel-operations','operations-content','operations-status','operations-sections','operations-refresh','operations-audit'].map(id=>[id,el()]));
 const root=nodes.get('member-panel-operations'); for(const [id,n] of nodes) if(id!=='member-panel-operations') root.appendChild(n);
 const calls=[]; let confirmation=true;
 const data={integrations:[],messages:{failed:2},cache:{total:3,expired:1,cleanup_eligible:0},jobs:[],policies:[
 {provider:'matchplay',policy:'event',default_seconds:7200,seconds:7200,overridden:true}]};
 const window={SNHMemberAuditPanel:{load:async()=>{calls.push({name:'audit'});}},confirm:()=>confirmation,snhSupabase:{rpc:async(name,args)=>{
 calls.push({name,args}); return {data:name==='snh_operations_snapshot'?data:name==='snh_operations_pinballmap'?pinballmap:name==='snh_operations_messages'?[
 {id:'id',kind:'signup',recipient_email:'<img src=x onerror=evil()>',subject:'Subject',status:'failed',attempts:3,can_retry:true}]:null};
 },functions:{invoke:async(name)=>{calls.push({name});return {data:name==='pinballmap-ingest'?{ok:true}:{providers:[],dispatcher:{configured:true,mode:'preview'}}};}}}};
 vm.runInNewContext(source,{window,document:{createElement:el,getElementById:id=>nodes.get(id)}});
 return {panel:window.SNHMemberOperationsPanel,nodes,calls,confirm:v=>{confirmation=v;},buttons:()=>root.querySelectorAll('button'),
 click:async text=>{const b=root.querySelectorAll('button').find(n=>n.textContent===text);assert.ok(b,text);await b.listeners.click();await new Promise(r=>setImmediate(r));}};
}
test('non-admin never loads Operations data',async()=>{const f=fixture();f.panel.init(['membership_admin']);await f.panel.load();assert.equal(f.calls.length,0);});
test('sections render, policy save/reset and retry require correct actions and confirmations',async()=>{
 const f=fixture();f.panel.init(['club_admin']);await f.panel.load();
 assert.equal(f.buttons().length,11);
 await f.click('Cache');
 assert.equal(f.buttons().find(b=>b.textContent==='Save').disabled,true);
 const input=f.nodes.get('operations-content').querySelectorAll('input')[0]; input.value='3600'; input.listeners.input();
 assert.equal(f.buttons().find(b=>b.textContent==='Save').disabled,false);
 await f.click('Save'); assert.equal(f.calls.find(c=>c.name==='snh_operations_policy').args.p_seconds,3600);
 f.confirm(false); const before=f.calls.length; await f.click('Reset to Default');assert.equal(f.calls.length,before);
 f.confirm(true);await f.click('Reset to Default');assert.equal(f.calls.filter(c=>c.name==='snh_operations_policy').at(-1).args.p_seconds,null);
 await f.click('Messaging');await f.click('Retry');assert.equal(f.calls.find(c=>c.name==='snh_operations_retry').args.p_id,'id');
 assert.ok(f.buttons().every(b=>!b.disabled));
});

test('Pinball Map shows overdue, latest meaningful changes, manual attribution and existing Run Now',async()=>{
 const run={id:'run',status:'failed',started_at:'2026-10-10T12:00:00Z',finished_at:'2026-10-10T12:00:05Z',actor:'Josh',error:'Condition import failed',
  result:{trigger:'manual',change_count:1,counts:{games:1},changes:[{title:'Rush <unsafe>',game_id:'game-id',kind:'games',action:'changed',fields:['map_at_club']}]}};
 const info={schedule:{enabled:true,cron:'0 */6 * * *',cadence:'Every six hours (UTC)'},observed_at:'2026-10-10T13:00:00Z',runs:[run],
  last_manual:run,last_change:run,last_success:{...run,status:'succeeded',finished_at:'2026-10-09T23:00:00Z'}};
 const f=fixture(info);f.panel.init(['club_admin']);await f.panel.load();await f.click('Integrations');
 const texts=node=>[node.textContent,...node.children.flatMap(texts)].join(' ');
 assert.match(texts(f.nodes.get('operations-content')),/Import may be overdue/);
 assert.match(texts(f.nodes.get('operations-content')),/Last manual invocation:.*Josh/);
 assert.match(texts(f.nodes.get('operations-content')),/Most recent changes/);
 assert.match(texts(f.nodes.get('operations-content')),/Rush <unsafe>/);
 const link=f.nodes.get('operations-content').querySelectorAll('a')[0];assert.equal(link.href,'members.html?panel=games&game=game-id');
 await f.click('View import runs');assert.match(texts(f.nodes.get('operations-content')),/Some changes committed before failure/);
 const runNow=f.buttons().filter(b=>b.textContent==='Run Now').at(-1);
 f.confirm(false);await runNow.listeners.click();assert.ok(!f.calls.some(c=>c.name==='pinballmap-ingest'));
 f.confirm(true);await runNow.listeners.click();await new Promise(r=>setImmediate(r));assert.ok(f.calls.some(c=>c.name==='pinballmap-ingest'));
 assert.ok(f.buttons().every(b=>!b.disabled));
 info.schedule.enabled=false;await f.click('Refresh');assert.doesNotMatch(texts(f.nodes.get('operations-content')),/may be overdue/);
});

test('overview failure link filters messages and Audit loads existing history',async()=>{
 const f=fixture();f.panel.init(['club_admin']);await f.panel.load();
 await f.click('2 failed messages');assert.equal(f.calls.find(c=>c.name==='snh_operations_messages').args.p_status,'failed');
 await f.click('Audit');assert.equal(f.nodes.get('operations-audit').hidden,false);
 assert.ok(f.calls.some(c=>c.name==='audit'));
 await f.click('Overview');assert.equal(f.nodes.get('operations-audit').hidden,true);
});
