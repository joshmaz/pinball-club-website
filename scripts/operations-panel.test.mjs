import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const source=await readFile(new URL('../assets/js/member-operations-panel.js',import.meta.url),'utf8');
function fixture() {
 function el(tag='div') {return {tag,children:[],dataset:{},attrs:{},listeners:{},textContent:'',
 appendChild(n){this.children.push(n);},replaceChildren(){this.children=[];},setAttribute(k,v){this.attrs[k]=v;},
 addEventListener(k,v){this.listeners[k]=v;},reportValidity(){return true;},
 querySelectorAll(selector){return this.children.flatMap(c=>[...(selector.split(',').map(s=>s.trim()).includes(c.tag)?[c]:[]),...c.querySelectorAll(selector)]);}};}
 const nodes=new Map(['member-panel-operations','operations-content','operations-status','operations-sections','operations-refresh'].map(id=>[id,el()]));
 const root=nodes.get('member-panel-operations'); for(const [id,n] of nodes) if(id!=='member-panel-operations') root.appendChild(n);
 const calls=[]; let confirmation=true;
 const data={integrations:[],messages:{failed:2},cache:{total:3,expired:1,cleanup_eligible:0},jobs:[],policies:[
 {provider:'matchplay',policy:'event',default_seconds:7200,seconds:7200,overridden:false}]};
 const window={confirm:()=>confirmation,snhSupabase:{rpc:async(name,args)=>{
 calls.push({name,args}); return {data:name==='snh_operations_snapshot'?data:name==='snh_operations_messages'?[
 {id:'id',kind:'signup',recipient_email:'<img src=x onerror=evil()>',subject:'Subject',status:'failed',attempts:3,can_retry:true}]:null};
 },functions:{invoke:async()=>({data:{providers:[],dispatcher:{configured:true,mode:'preview'}}})}}};
 vm.runInNewContext(source,{window,document:{createElement:el,getElementById:id=>nodes.get(id)}});
 return {panel:window.SNHMemberOperationsPanel,nodes,calls,confirm:v=>{confirmation=v;},buttons:()=>root.querySelectorAll('button'),
 click:async text=>{const b=root.querySelectorAll('button').find(n=>n.textContent===text);assert.ok(b,text);await b.listeners.click();await new Promise(r=>setImmediate(r));}};
}
test('non-admin never loads Operations data',async()=>{const f=fixture();f.panel.init(['membership_admin']);await f.panel.load();assert.equal(f.calls.length,0);});
test('sections render, policy save/reset and retry require correct actions and confirmations',async()=>{
 const f=fixture();f.panel.init(['club_admin']);await f.panel.load();
 assert.equal(f.buttons().length,6);
 await f.click('Cache');
 await f.click('Save'); assert.equal(f.calls.find(c=>c.name==='snh_operations_policy').args.p_seconds,7200);
 f.confirm(false); const before=f.calls.length; await f.click('Reset to Default');assert.equal(f.calls.length,before);
 f.confirm(true);await f.click('Reset to Default');assert.equal(f.calls.filter(c=>c.name==='snh_operations_policy').at(-1).args.p_seconds,null);
 await f.click('Messaging');await f.click('Retry');assert.equal(f.calls.find(c=>c.name==='snh_operations_retry').args.p_id,'id');
 assert.ok(f.buttons().every(b=>!b.disabled));
});
