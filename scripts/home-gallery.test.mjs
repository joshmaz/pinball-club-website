import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const source = await readFile(new URL('../assets/js/home-gallery.js', import.meta.url), 'utf8');
async function setup({reduced = false, count = 5} = {}) {
  let loaded = 0, observer, clock = 0; const animations = [];
  const timers = new Map();
  class Element {
    constructor() { this.children=[]; this.listeners={}; this.style={}; this.attributes={}; this.clientWidth=500; this.hidden=true; this.textContent=''; const classes=new Set(); this.classList={add:x=>classes.add(x),remove:x=>classes.delete(x),toggle:(x,v)=>v?classes.add(x):classes.delete(x),contains:x=>classes.has(x)}; }
    animate(frames, options) { const animation={frames,options,playState:'running',play(){this.playState='running';},pause(){this.playState='paused';},cancel(){this.playState='idle';}};animations.push(animation);return animation; }
    contains(element) { return Object.values(ids).includes(element); }
    addEventListener(name, fn) { this.listeners[name]=fn; }
    setAttribute(k,v) { this.attributes[k]=v; }
    append(child) { child.remove(); this.children.push(child); child.parent=this; }
    remove() { if(this.parent) this.parent.children=this.parent.children.filter(c=>c!==this); }
    set src(value) { this.url=value; loaded++; }
  }
  const ids=Object.fromEntries(['gallery','gallery-track','gallery-caption','gallery-status','gallery-pause','gallery-previous','gallery-next'].map(id=>[id,new Element()]));
  const document={hidden:false,listeners:{},getElementById:id=>ids[id],createElement:()=>new Element(),addEventListener(name,fn){this.listeners[name]=fn;}};
  const motion={matches:reduced,addEventListener(){}};
  const games=Array.from({length:count},(_,i)=>({title:`Game ${i}`,primaryImage:{url:`https://example.test/${i}-large`,variants:[{url:`https://example.test/${i}-small`,width:320},{url:`https://example.test/${i}-medium`,width:640}]}}));
  const math=Object.create(Math);math.random=()=>.37;
  vm.runInNewContext(source,{document,Math:math,window:{matchMedia:()=>motion,SNHPublicData:{loadGames:async()=>({data:games})},SNHGameImages:{variants:i=>i.variants}},console,
    IntersectionObserver:class {constructor(fn){observer=fn;} observe(){}},ResizeObserver:class {observe(){}},
    setTimeout(fn,delay){const id=++clock;timers.set(id,{fn,delay});return id;},clearTimeout:id=>timers.delete(id)});
  await Promise.resolve(); await Promise.resolve();
  return {ids,document,animations,finish(){const a=animations.findLast(a=>a.onfinish&&a.playState==='running');assert.ok(a);a.playState='finished';a.onfinish();},loaded:()=>loaded,timers,view(value){observer([{isIntersecting:value}]);},click(id){ids[id].listeners.click();},tick(delay){const row=[...timers].find(([,t])=>t.delay===delay);assert.ok(row,`Expected ${delay}ms timer`);timers.delete(row[0]);row[1].fn();}};
}
test('starts only in view, keeps three neighbors, and advances on a three-second glide',async()=>{
  const h=await setup();assert.equal(h.loaded(),0);h.view(true);assert.equal(h.loaded(),3);
  assert.equal(h.animations[1].options.duration,3000);assert.equal(h.animations[1].frames[1].offset,.8);
  const before=h.ids['gallery-caption'].textContent;h.finish();assert.notEqual(h.ids['gallery-caption'].textContent,before);assert.equal(h.loaded(),4);
  assert.equal(h.ids['gallery-track'].children.length,3);assert.ok(h.ids['gallery-track'].children.every(s=>s.children[0].sizes==='350px'));
});
test('tab return resumes despite stale keyboard focus; offscreen neither advances nor preloads',async()=>{
  const h=await setup();h.view(true);h.ids.gallery.listeners.focusin({target:{matches:()=>true}});
  assert.equal(h.animations[1].playState,'paused');h.document.hidden=true;h.document.listeners.visibilitychange();
  h.document.hidden=false;h.document.listeners.visibilitychange();assert.equal(h.animations[1].playState,'running');
  h.view(false);assert.equal(h.animations[1].playState,'paused');assert.equal(h.loaded(),3);
  h.view(true);assert.equal(h.animations[1].playState,'running');h.finish();assert.equal(h.loaded(),4);
});
test('hover and manual navigation pause until leaving; touch resumes after inactivity',async()=>{
  const h=await setup();h.view(true);h.ids.gallery.listeners.pointerenter({pointerType:'mouse'});
  assert.equal(h.animations[1].playState,'paused');h.click('gallery-next');assert.equal(h.animations.at(-2).playState,'paused');
  h.ids.gallery.listeners.pointerleave();assert.equal(h.animations.at(-2).playState,'running');
  const before=h.ids['gallery-caption'].textContent;h.click('gallery-previous');assert.notEqual(h.ids['gallery-caption'].textContent,before);h.tick(3000);assert.equal(h.animations.at(-2).playState,'running');
});
test('reduced motion is stationary but manually navigable; single image loads once',async()=>{
  const h=await setup({reduced:true});h.view(true);assert.equal(h.animations.length,0);const before=h.ids['gallery-caption'].textContent;h.click('gallery-next');assert.notEqual(h.ids['gallery-caption'].textContent,before);assert.equal(h.animations.length,0);
  const one=await setup({count:1});one.view(true);assert.equal(one.loaded(),1);assert.equal(one.animations.length,0);assert.equal(one.ids['gallery-next'].hidden,true);
});
