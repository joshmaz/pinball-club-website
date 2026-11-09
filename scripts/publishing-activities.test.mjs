import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../assets/js/activities.js',import.meta.url),'utf8');
class Element{constructor(tag){this.tag=tag;this.children=[];this.style={};}appendChild(n){this.children.push(n);return n;}setAttribute(k,v){this[k]=v;}addEventListener(){}replaceChildren(){this.children=[];}}
function setup(){const context={document:{readyState:'loading',addEventListener(){},createElement:t=>new Element(t),createElementNS:(ns,t)=>new Element(t)},window:{SNHPublishing:{safeUrl:v=>v?.startsWith('https://')?v:''},snhSupabase:{storage:{from:()=>({getPublicUrl:key=>({data:{publicUrl:'https://stage.example/'+key}})})}}}};vm.runInNewContext(source,context);return context.window.SNHActivities;}
test('activity card preserves plain text, poster fit and photo focal point without an executable link',()=>{
 const api=setup(),root=new Element('div');api.render(root,{title:'<script>plain</script>',body:'<img plain>',image_id:'00000000-0000-4000-8000-000000000001',image_alt:'A tournament poster',fit:'contain',focus_x:20,focus_y:80,url:'javascript:bad'});
 const card=root.children[0],image=card.children[0].children[0],copy=card.children[1];assert.equal(image.alt,'A tournament poster');assert.equal(image.style.objectFit,'contain');assert.equal(image.style.objectPosition,'20% 80%');assert.equal(copy.children[0].children[0].textContent,'<script>plain</script>');assert.ok(copy.children[2].children.every(a=>!a.href.startsWith('javascript:')));
});
test('imageless activities get an intentional decorative fallback',()=>{const root=new Element('div');setup().render(root,{title:'Club night',body:'Play together'});assert.equal(root.children[0].children[0]['aria-hidden'],'true');});

test('external-first cards keep Details when useful and link title to selected destination',()=>{
 const api=setup(),root=new Element('div');const entry={id:'abc',title:'League',body:'Join us',details:'More',destination:'external',destination_url:'https://example.com/register',links:[{url:'https://example.com/register',label:'Register'}]};
 api.render(root,entry);const copy=root.children[0].children[1];assert.equal(copy.children[0].children[0].href,entry.destination_url);assert.equal(copy.children[2].children[0].textContent,'Register ↗');assert.equal(copy.children[2].children[1].href,'activities.html?id=abc');
 assert.equal(api.destination({...entry,destination:'internal'}).url,'activities.html?id=abc');
 assert.equal(api.destination({...entry,links:[]}).url,'activities.html?id=abc','missing external destinations fall back to permalink');
});
test('detail renders ended notice, whole flyer, plain paragraphs and simple lists',()=>{
 const root=new Element('div');setup().renderDetail(root,{title:'<b>League</b>',body:'Summary',ended:true,details:'<script>plain</script>\n\n- One\n- Two',links:[{url:'javascript:bad'}],image_id:'00000000-0000-4000-8000-000000000001',image_alt:'Full poster'});
 const article=root.children[0];assert.match(article.children[0].textContent,/Ended/);assert.equal(article.children[1].textContent,'<b>League</b>');assert.equal(article.children.find(n=>n.tag==='img').className,'activity-flyer');assert.equal(article.children.find(n=>n.tag==='ul').children.length,2);assert.equal(article.children.find(n=>n.className==='activity-paragraph').textContent,'<script>plain</script>');
});

test('card image, title, and action share the destination and external links open a new tab',()=>{
 const api=setup(),root=new Element('div');const entry={id:'abc',title:'League',body:'Join',image_id:'00000000-0000-4000-8000-000000000001',destination:'external',destination_url:'https://example.com/',links:[{url:'https://example.com/',label:'Register'}]};api.render(root,entry);
 const card=root.children[0],copy=card.children[1];for(const a of [card.children[0],copy.children[0].children[0],copy.children[2].children[0]]){assert.equal(a.href,entry.destination_url);assert.equal(a.target,'_blank');assert.equal(a.rel,'noopener noreferrer');}
 const internal=new Element('div');api.render(internal,{...entry,destination:'internal'});assert.equal(internal.children[0].children[0].href,'activities.html?id=abc');assert.equal(internal.children[0].children[0].target,undefined);
});
test('detail uses the announcement bookmark style and opens useful links in a new tab',()=>{
 const root=new Element('div');setup().renderDetail(root,{id:'abc',title:'League',body:'Join',links:[{url:'https://example.com/',label:'League site'}]});const article=root.children[0];assert.equal(article.children.find(n=>n.tag==='ul').children[0].children[0].target,'_blank');const button=article.children.find(n=>n.className==='announcement-actions').children[0];assert.equal(button.className,'announcement-copy-link');assert.equal(button['aria-label'],'Copy Activity link');assert.equal(button.children[0].tag,'svg');
});

test('activity page lists the uncapped directory, keeps detail links, and leaves the homepage on its own feed', async()=>{
 const id='00000000-0000-4000-8000-000000000001';
 const cards=Array.from({length:8},(_,i)=>({id,title:'Activity '+i,body:'Summary'}));
 async function load(page,search,reply){
  const elements=Object.fromEntries(['public-activities','activities-status','activities-retry','activities-title','activity-back-to-list'].map(key=>[key,new Element('div')]));
  const root=elements['public-activities'],calls=[];
  root.hasAttribute=()=>page;
  root.classList={add(){}};
  let start;
  const document={readyState:'loading',addEventListener(type,fn){start=fn;},getElementById:key=>page||key==='public-activities'?elements[key]:null,createElement:t=>new Element(t),createElementNS:(ns,t)=>new Element(t)};
  const window={location:{search},SNHPublishing:{},snhSupabase:{async rpc(name,args){calls.push([name,args?.p_id]);return reply;}}};
  vm.runInNewContext(source,{document,window,URLSearchParams});
  await start();
  return {root,calls,elements};
 }
 const directory=await load(true,'',{data:cards});
 assert.deepEqual(directory.calls,[['snh_public_activity_directory',undefined]]);
 assert.equal(directory.root.children.length,8);
 assert.equal(directory.root.children[0].children[1].children[0].tag,'h2');
 const detail=await load(true,'?id='+id,{data:cards[0]});
 assert.deepEqual(detail.calls,[['snh_public_activity',id]]);
 assert.equal(detail.elements['activity-back-to-list'].hidden,false);
 assert.equal(detail.root.children[0].className,'activity-detail');
 const home=await load(false,'',{data:cards.slice(0,6)});
 assert.deepEqual(home.calls,[['snh_public_activities',undefined]]);
 assert.equal(home.root.children.length,6);
 const empty=await load(true,'',{data:[]});
 assert.match(empty.elements['activities-status'].textContent,/No activities/);
 const failed=await load(true,'',{error:new Error('offline')});
 assert.equal(failed.elements['activities-retry'].hidden,false);
});
