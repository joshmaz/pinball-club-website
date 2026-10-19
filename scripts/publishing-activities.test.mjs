import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../assets/js/activities.js',import.meta.url),'utf8');
class Element{constructor(tag){this.tag=tag;this.children=[];this.style={};}appendChild(n){this.children.push(n);return n;}setAttribute(k,v){this[k]=v;}replaceChildren(){this.children=[];}}
function setup(){const context={document:{readyState:'loading',addEventListener(){},createElement:t=>new Element(t)},window:{SNHPublishing:{safeUrl:v=>v?.startsWith('https://')?v:''},snhSupabase:{storage:{from:()=>({getPublicUrl:key=>({data:{publicUrl:'https://stage.example/'+key}})})}}}};vm.runInNewContext(source,context);return context.window.SNHActivities;}
test('activity card preserves plain text, poster fit and photo focal point without an executable link',()=>{
 const api=setup(),root=new Element('div');api.render(root,{title:'<script>plain</script>',body:'<img plain>',image_id:'00000000-0000-4000-8000-000000000001',image_alt:'A tournament poster',fit:'contain',focus_x:20,focus_y:80,url:'javascript:bad'});
 const card=root.children[0],image=card.children[0],copy=card.children[1];assert.equal(image.alt,'A tournament poster');assert.equal(image.style.objectFit,'contain');assert.equal(image.style.objectPosition,'20% 80%');assert.equal(copy.children[0].textContent,'<script>plain</script>');assert.equal(copy.children.length,2);
});
test('imageless activities get an intentional decorative fallback',()=>{const root=new Element('div');setup().render(root,{title:'Club night',body:'Play together'});assert.equal(root.children[0].children[0]['aria-hidden'],'true');});
