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
 setAttribute(name,value){this[name]=value;}
}
function setup(result,history=false,search=""){
 const root=new Element('div'),status=new Element('p'),more=new Element('a'),newer=new Element('a'),retry=new Element('button'); root.dataset.history=String(history);
 const calls=[];let ready;
 const document={readyState:'loading',addEventListener(_,fn){ready=fn;},createElement:tag=>new Element(tag),createElementNS:(_,tag)=>new Element(tag),getElementById:id=>({'public-announcements':root,'announcements-status':status,'announcements-more':more,'announcements-newer':newer,'announcements-retry':retry}[id])};
 const context={URL,URLSearchParams,Date,document,window:{location:{search,href:'https://club.example/announcements.html'+search},snhSupabase:{rpc:async(name,args)=>{calls.push({name,args});return typeof result==='function'?result(calls.length):result;}}}};
 vm.runInNewContext(source,context);return {root,status,more,newer,retry,calls,ready,ui:context.window.SNHPublishing};
}
const entry={id:'id1',title:'<script>alert(1)</script>',body:'<img src=x onerror=alert(1)>\nSecond line',url:'javascript:alert(1)',starts_at:'2026-10-17T12:00:00Z'};
test('public rendering preserves plain text and rejects executable and credential-bearing links',async()=>{
 const f=setup({data:[entry]});await f.ready();
 assert.equal(f.root.children[0].children[1].textContent,entry.title);
 assert.equal(f.root.children[0].children.filter(x=>x.tag==='a').length,0);
 assert.equal(f.ui.safeUrl('https://user:password@example.com'),'');
 assert.equal(f.ui.safeUrl('https://example.com/news'),'https://example.com/news');
 assert.equal(f.root.children[0].children.find(x=>x.className==='announcement-actions').children.length,0,'homepage omits redundant open link');
 assert.equal(f.calls[0].args.p_limit,1);assert.equal(f.status.textContent,'');
});
test('history renders ten-item pages with server cursors and retries errors',async()=>{
 const data=Array.from({length:10},(_,i)=>({...entry,id:String(i)}));
 const f=setup(n=>n===1?{data:{entries:data,has_newer:true,has_older:true}}:{error:{message:'offline'}},true,'?before=2026-10-18T00%3A00%3A00Z&before_id=abc');
 await f.ready();assert.equal(f.more.hidden,false);assert.equal(f.newer.hidden,false);
 assert.match(f.more.href,/before_id=9/);assert.match(f.newer.href,/after_id=0/);
 assert.equal(f.calls[0].name,'snh_public_announcement_page');assert.equal(f.calls[0].args.p_before_id,'abc');
 await f.retry.listeners.click();assert.match(f.status.textContent,/breather/);assert.equal(f.retry.hidden,false);assert.equal(f.root.children.length,10);
});
test('permalink requests one eligible announcement and renders Discord discussion',async()=>{
 const f=setup({data:{...entry,discord_guild_id:'1473002560511021298',discord_channel_id:'1561436946780135464',discord_message_id:'1561436651136483001'}},true,'?id=abc');
 await f.ready();assert.equal(f.calls[0].name,'snh_public_announcement');assert.equal(f.calls[0].args.p_id,'abc');assert.equal(f.root.children[0].children[1].tag,'h1');
 const actions=f.root.children[0].children.find(x=>x.className==='announcement-actions');assert.ok(actions.children.some(x=>x.href?.startsWith('https://discord.com/channels/')));
 assert.equal(f.ui.discordUrl({...entry,discord_guild_id:'javascript:bad'}),'');
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
  const document={createElement:tag=>new Element(tag),createElementNS:(_,tag)=>new Element(tag),getElementById:id=>id==='member-publishing-app'?root:id==='publishing-status'?status:all(root).find(x=>x.id===id)};
  const context={Date,document,window:{addEventListener(){},confirm:()=>true,SNHSiteAuth:{can:()=>admin},SNHPublishing:{render(){}},snhSupabase:{rpc:async(name,args)=>{calls.push({name,args});return name==='snh_publishing_discord_status'?{data:[]}:name==='snh_publishing_list'?{data:[row]}:rejectSave?{error:{message:'Changed. Reload before saving.'}}:{data:{...row,version:4}};}}}};
  vm.runInNewContext(editor,context);await context.window.SNHMemberPublishingPanel.load(['publishing_editor']);
  const button=text=>all(root).find(x=>x.tag==='button'&&x.textContent===text);
  button('Existing').listeners.click();
  assert.equal(!!button('Permanently delete'),admin);
  document.getElementById('publishing-title').value='Unsaved';document.getElementById('publishing-title').listeners.input();
  button('Restore').listeners.click();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(calls.filter(x=>x.name==='snh_publishing_write').length,0,'unsaved content blocks publication-state changes');
  rejectSave=true;button('Save draft').listeners.click();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(calls.find(x=>x.name==='snh_publishing_write').args.p_version,3);assert.match(status.textContent,/Reload/);
  assert.equal(document.getElementById('publishing-title').value,'Unsaved','failed save keeps text for recovery');
  assert.equal(button('Save draft').disabled,false);
  const listCalls=calls.filter(x=>x.name==='snh_publishing_list').length;
  button('← Back to announcements').listeners.click();
  assert.ok(button('Existing'),'cancel returns to saved list');
  assert.equal(calls.filter(x=>x.name==='snh_publishing_list').length,listCalls,'cancel does not depend on network');
 }
});
