(function(){
'use strict';
const $=id=>document.getElementById(id);
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const params=new URLSearchParams(location.search);
const duration=Math.min(30,Math.max(3,Number(params.get('dur'))||5));
const settingsUrl='/slideshow';
function parseIds(value){return new Set((value||'').split(',').filter(v=>UUID.test(v)));}
function selected(albums){const mode=params.has('include')?'include':params.has('exclude')?'exclude':'all';const ids=parseIds(params.get(mode));return albums.filter(a=>mode==='all'||(mode==='include'?ids.has(a.id):!ids.has(a.id)));}
function variant(asset,name){return (asset.variants||[]).find(v=>v.variant===name&&v.bucket==='photos-public'&&v.objectKey);}
function imageUrl(v){const base=String((window.SNH_CONFIG||{}).supabaseUrl||'').replace(/\/+$/,'');return base&&v?base+'/storage/v1/object/public/photos-public/'+v.objectKey.split('/').map(encodeURIComponent).join('/'):'';}
async function catalog(){if(!window.snhSupabase)throw Error('Photo service unavailable');const result=await window.snhSupabase.rpc('snh_public_photo_albums');if(result.error)throw result.error;const data=typeof result.data==='string'?JSON.parse(result.data):result.data;return Array.isArray(data)?data:[];}
function linkFor(all,chosen,dur,cap,fit){
const picked=new Set(chosen),excluded=all.filter(a=>!picked.has(a.id)).map(a=>a.id),included=all.filter(a=>picked.has(a.id)).map(a=>a.id);
const q=new URLSearchParams();
if(!excluded.length)q.set('albums','all');else if(included.length<=excluded.length)q.set('include',included.join(','));else q.set('exclude',excluded.join(','));
q.set('dur',String(dur));q.set('cap',cap?'1':'0');if(fit==='fill')q.set('fit','fill');
return '/slideshow/play?'+q.toString();
}
if($('slide-form')){
const form=$('slide-form'),status=$('slide-status'),albumsBox=$('slide-albums'),dur=$('slide-duration'),captions=$('slide-captions'),fit=$('slide-fit');
dur.value=duration;$('slide-duration-value').textContent=duration;dur.oninput=()=>{$('slide-duration-value').textContent=dur.value;};
captions.checked=params.get('cap')!=='0';fit.value=params.get('fit')==='fill'?'fill':'fit';
let albums=[];
function checked(){return [...albumsBox.querySelectorAll('input:checked')].map(x=>x.value);}
function url(){return linkFor(albums,checked(),dur.value,captions.checked,fit.value);}
function draw(){albumsBox.replaceChildren();const ids=new Set(selected(albums).map(a=>a.id));albums.forEach(a=>{const label=document.createElement('label'),input=document.createElement('input');input.type='checkbox';input.value=a.id;input.checked=ids.has(a.id);label.append(input,document.createTextNode(' '+a.title));albumsBox.append(label);});status.textContent=albums.length?albums.length+' published albums available.':'No published albums available.';}
$('slide-all').onclick=()=>albumsBox.querySelectorAll('input').forEach(x=>x.checked=true);
$('slide-none').onclick=()=>albumsBox.querySelectorAll('input').forEach(x=>x.checked=false);
$('slide-copy').onclick=async()=>{try{await navigator.clipboard.writeText(new URL(url(),location.origin).href);status.textContent='Slideshow link copied.';}catch(_){status.textContent='Could not copy link. Please copy it from the address bar after starting.';}};
form.onsubmit=e=>{e.preventDefault();if(!checked().length){status.textContent='Select at least one album.';return;}location.href=url();};
catalog().then(data=>{albums=data.filter(a=>(a.assets||[]).some(x=>!x.excludeFromSlideshow&&variant(x,'web')));draw();}).catch(()=>{status.textContent='Could not load albums. Refresh to retry.';});
return;
}
if(!$('slide-stage'))return;
const stage=$('slide-stage'),frames=[$('slide-frame-a'),$('slide-frame-b')],holding=$('slide-holding'),shade=$('slide-shade'),caption=$('slide-caption'),controls=$('slide-controls');
const fit=params.get('fit')==='fill'?'fill':'fit',cap=params.get('cap')!=='0';
let items=[],order=[],cursor=-1,active=0,timer=null,paused=false,busy=false,hideTimer=null,retryTimer=null,last=-1;
function shuffle(){const arr=items.map((_,i)=>i);for(let i=arr.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[arr[i],arr[j]]=[arr[j],arr[i]];}if(arr.length>1&&arr[0]===last)[arr[0],arr[1]]=[arr[1],arr[0]];return arr;}
function nextIndex(){if(cursor+1>=order.length){order=shuffle();cursor=-1;}return order[++cursor];}
function preload(src){return new Promise((resolve,reject)=>{const im=new Image();im.onload=()=>resolve(im);im.onerror=reject;im.src=src;});}
function setHolding(message){holding.textContent=message;holding.hidden=false;}
function schedule(){clearTimeout(timer);if(!paused&&items.length)timer=setTimeout(()=>void advance(1),duration*1000);}
function showControls(){controls.classList.remove('hidden');clearTimeout(hideTimer);if(!paused)hideTimer=setTimeout(()=>controls.classList.add('hidden'),3000);}
async function showItem(i){if(busy||!items[i])return false;busy=true;try{const item=items[i],im=await preload(item.src),next=1-active,frame=frames[next];frame.replaceChildren(im);frame.className='slide-frame'+(fit==='fill'?' fill':'');frame.style.setProperty('--slide-time',duration+'s');void frame.offsetWidth;frame.classList.add('moving');frame.classList.add('active');frames[active].classList.remove('active');active=next;last=i;caption.textContent=cap?(item.caption||item.albumTitle||'').slice(0,240):'';shade.hidden=!caption.textContent;holding.hidden=true;return true;}catch(_){return false;}finally{busy=false;}}
async function advance(step){clearTimeout(timer);if(!items.length)return;if(busy)return;let attempts=0;while(attempts<items.length){let i;if(step<0&&cursor>0){i=order[--cursor];}else{i=nextIndex();}if(await showItem(i)){schedule();return;}attempts++;}setHolding('Photos are temporarily unavailable. Retrying shortly…');clearTimeout(retryTimer);retryTimer=setTimeout(()=>void advance(1),15000);}
function togglePause(force){paused=typeof force==='boolean'?force:!paused;$('slide-pause').textContent=paused?'Play':'Pause';$('slide-pause').setAttribute('aria-label',paused?'Resume slideshow':'Pause slideshow');if(paused)clearTimeout(timer);else schedule();showControls();}
$('slide-prev').onclick=()=>void advance(-1);$('slide-next').onclick=()=>void advance(1);$('slide-pause').onclick=()=>togglePause();$('slide-settings').onclick=()=>{location.href=settingsUrl+location.search;};
$('slide-fullscreen').onclick=()=>{if(document.fullscreenElement)document.exitFullscreen().catch(()=>{});else stage.requestFullscreen?.().catch(()=>{});};
document.addEventListener('fullscreenchange',()=>{if(!document.fullscreenElement)togglePause(true);});
document.addEventListener('keydown',e=>{if(e.target instanceof HTMLElement&&['INPUT','SELECT','TEXTAREA'].includes(e.target.tagName))return;if(e.code==='Space'){e.preventDefault();togglePause();}else if(e.key==='ArrowRight'){e.preventDefault();void advance(1);}else if(e.key==='ArrowLeft'){e.preventDefault();void advance(-1);}else if(e.key==='Escape'&&!document.fullscreenElement)togglePause(true);});
stage.addEventListener('pointermove',showControls);stage.addEventListener('pointerdown',showControls);
document.addEventListener('visibilitychange',()=>{if(document.hidden)togglePause(true);});
catalog().then(albums=>{items=selected(albums).flatMap(a=>(a.assets||[]).filter(x=>x.excludeFromSlideshow!==true).map(x=>({src:imageUrl(variant(x,'web')),caption:x.caption,albumTitle:a.title})).filter(x=>x.src));if(!items.length){setHolding('No slideshow photos are available for this selection. Choose Settings to adjust your albums.');return;}order=shuffle();void advance(1);}).catch(()=>{setHolding('Unable to load club photos. Retrying…');retryTimer=setTimeout(()=>location.reload(),15000);});
showControls();
})();