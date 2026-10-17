import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../assets/js/publishing.js',import.meta.url),'utf8');
class Element {
 constructor(tag){this.tag=tag;this.children=[];this.dataset={};this.listeners={};}
 set textContent(value){this.text=String(value);this.children=[];}
 get textContent(){return (this.text||'')+this.children.map(x=>x.textContent).join(' ');}
 appendChild(x){this.children.push(x);return x;}
 replaceChildren(){this.children=[];this.text='';}
 addEventListener(type,fn){this.listeners[type]=fn;}
}
function setup(result,history=false){
 const root=new Element('div'),status=new Element('p'),more=new Element('button'); root.dataset.history=String(history);
 const calls=[];let ready;
 const document={readyState:'loading',addEventListener(_,fn){ready=fn;},createElement:tag=>new Element(tag),getElementById:id=>({'public-announcements':root,'announcements-status':status,'announcements-more':more}[id])};
 const context={URL,Date,document,window:{snhSupabase:{rpc:async(name,args)=>{calls.push({name,args});return typeof result==='function'?result(calls.length):result;}}}};
 vm.runInNewContext(source,context);return {root,status,more,calls,ready,ui:context.window.SNHPublishing};
}
const entry={id:'id1',title:'<script>alert(1)</script>',body:'<img src=x onerror=alert(1)>\nSecond line',url:'javascript:alert(1)',starts_at:'2026-10-17T12:00:00Z'};
test('public rendering preserves plain text and rejects executable and credential-bearing links',async()=>{
 const f=setup({data:[entry]});await f.ready();
 assert.equal(f.root.children[0].children[0].textContent,entry.title);
 assert.equal(f.root.children[0].children.filter(x=>x.tag==='a').length,0);
 assert.equal(f.ui.safeUrl('https://user:password@example.com'),'');
 assert.equal(f.ui.safeUrl('https://example.com/news'),'https://example.com/news');
 assert.equal(f.calls[0].args.p_limit,1);assert.equal(f.status.textContent,'');
});
test('history follows a server cursor and shows a retryable failure without fallback stale text',async()=>{
 const data=Array.from({length:20},(_,i)=>({...entry,id:String(i)}));
 const f=setup(n=>n===1?{data}:{error:{message:'offline'}},true);await f.ready();assert.equal(f.more.hidden,false);
 await f.more.listeners.click();assert.equal(f.calls[1].args.p_before_id,'19');assert.match(f.status.textContent,/unavailable/);
 assert.equal(f.root.children.length,20);assert.equal(f.more.hidden,true);
});
test('empty homepage explains where visitors can find activities',async()=>{const f=setup({data:[]});await f.ready();assert.match(f.status.textContent,/Events/);});

test('editor keeps unsaved revisions private and exposes deletion only to admins',async()=>{
 const editor=await readFile(new URL('../assets/js/member-publishing-panel.js',import.meta.url),'utf8');
 function all(root){return [root,...root.children.flatMap(all)];}
 Element.prototype.setAttribute=function(k,v){this[k]=v;};
 Element.prototype.querySelectorAll=function(selector){return all(this).filter(x=>selector.split(',').includes(x.tag));};
 for(const admin of [false,true]){
  const root=new Element('div'),status=new Element('p'),calls=[];
  const row={id:'entry',version:3,draft:{title:'Existing',body:'Text'},published:null,archived:true};
  let rejectSave=false;
  const document={createElement:tag=>new Element(tag),getElementById:id=>id==='member-publishing-app'?root:id==='publishing-status'?status:all(root).find(x=>x.id===id)};
  const context={Date,document,window:{addEventListener(){},confirm:()=>true,SNHSiteAuth:{can:()=>admin},SNHPublishing:{render(){}},snhSupabase:{rpc:async(name,args)=>{calls.push({name,args});return name==='snh_publishing_list'?{data:[row]}:rejectSave?{error:{message:'Changed. Reload before saving.'}}:{data:{...row,version:4}};}}}};
  vm.runInNewContext(editor,context);await context.window.SNHMemberPublishingPanel.load(['publishing_editor']);
  const button=text=>all(root).find(x=>x.tag==='button'&&x.textContent===text);
  button('Existing').listeners.click();
  assert.equal(!!button('Permanently delete'),admin);
  document.getElementById('publishing-title').value='Unsaved';document.getElementById('publishing-title').listeners.input();
  button('Restore').listeners.click();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(calls.length,1,'unsaved content blocks publication-state changes');
  rejectSave=true;button('Save draft').listeners.click();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(calls[1].args.p_version,3);assert.match(status.textContent,/Reload/);
  assert.equal(document.getElementById('publishing-title').value,'Unsaved','failed save keeps text for recovery');
  assert.equal(button('Save draft').disabled,false);
 }
});
