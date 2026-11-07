(function(){
'use strict';
const $=id=>document.getElementById(id);
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const params=new URLSearchParams(location.search);
const duration=Math.min(30,Math.max(3,Number(params.get('dur'))||5));
const settingsUrl='/slideshow';
function parseIds(value){return new Set((value||'').split(',').filter(v=>UUID.test(v)));}
function selected(albums){const mode=params.has('include')?'include':params.has('exclude')?'exclude':'all';const ids=parseIds(params.get(mode));return albums.filter(a=>mode==='all'||(mode==='include'?ids.has(a.id):!ids.has(a.id)));}
function activitySelection(all){const mode=params.get('activities');const ids=parseIds(params.get('activity_ids'));const excluded=parseIds(params.get('activity_exclude'));return mode==='all'?all:mode==='include'?all.filter(a=>ids.has(a.id)):mode==='exclude'?all.filter(a=>!excluded.has(a.id)):[];}
async function activityCatalog(){if(!window.snhSupabase)throw Error('Activity service unavailable');const result=await window.snhSupabase.rpc('snh_slideshow_activities');if(result.error)throw result.error;const data=typeof result.data==='string'?JSON.parse(result.data):result.data;return Array.isArray(data)?data:[];}
function activityImage(a){const base=String((window.SNH_CONFIG||{}).supabaseUrl||'').replace(/\/+$/,'');return base&&UUID.test(a.image_id||'')?base+'/storage/v1/object/public/publishing-public/'+a.image_id+'/web.webp':'';}
function variant(asset,name){return (asset.variants||[]).find(v=>v.variant===name&&v.bucket==='photos-public'&&v.objectKey);}
function imageUrl(v){const base=String((window.SNH_CONFIG||{}).supabaseUrl||'').replace(/\/+$/,'');return base&&v?base+'/storage/v1/object/public/photos-public/'+v.objectKey.split('/').map(encodeURIComponent).join('/'):'';}
async function catalog(){if(!window.snhSupabase)throw Error('Photo service unavailable');const result=await window.snhSupabase.rpc('snh_public_photo_albums');if(result.error)throw result.error;const data=typeof result.data==='string'?JSON.parse(result.data):result.data;return Array.isArray(data)?data:[];}
function linkFor(all,chosen,dur,cap,fit,photosOn,activityMode,activities,chosenActivities){
const picked=new Set(chosen),excluded=all.filter(a=>!picked.has(a.id)).map(a=>a.id),included=all.filter(a=>picked.has(a.id)).map(a=>a.id);
const q=new URLSearchParams();
if(!photosOn)q.set('photos','0');else if(!excluded.length)q.set('albums','all');else if(included.length<=excluded.length)q.set('include',included.join(','));else q.set('exclude',excluded.join(','));
if(activityMode==='all')q.set('activities','all');else if(activityMode==='specific'){const chosenSet=new Set(chosenActivities),yes=activities.filter(a=>chosenSet.has(a.id)).map(a=>a.id),no=activities.filter(a=>!chosenSet.has(a.id)).map(a=>a.id);if(yes.length<=no.length){q.set('activities','include');q.set('activity_ids',yes.join(','));}else{q.set('activities','exclude');q.set('activity_exclude',no.join(','));}}
q.set('dur',String(dur));q.set('cap',cap?'1':'0');if(fit==='fill')q.set('fit','fill');
return '/slideshow/play?'+q.toString();
}
if($('slide-form')){
const form=$('slide-form'),status=$('slide-status'),albumsBox=$('slide-albums'),dur=$('slide-duration'),captions=$('slide-captions'),fitOptions=[...document.querySelectorAll('input[name="slide-fit"]')];
dur.value=duration;$('slide-duration-value').textContent=duration;dur.oninput=()=>{$('slide-duration-value').textContent=dur.value;};
captions.checked=params.get('cap')==='1';fitOptions.forEach(input=>{input.checked=input.value===(params.get('fit')==='fill'?'fill':'fit');});
let albums=[],activities=[];
const photosOn=$('slide-photos'),activitiesOn=$('slide-activities'),activityOptions=$('slide-activity-options'),activityList=$('slide-activity-list'),modes=[...document.querySelectorAll('input[name="slide-activity-mode"]')];
photosOn.checked=params.get('photos')!=='0';activitiesOn.checked=params.has('activities');$('slide-photo-options').hidden=!photosOn.checked;activityOptions.hidden=!activitiesOn.checked;
photosOn.onchange=()=>{$('slide-photo-options').hidden=!photosOn.checked;};activitiesOn.onchange=()=>{activityOptions.hidden=!activitiesOn.checked;};
function mode(){return (modes.find(x=>x.checked)||modes[0]).value;}
function activityChecked(){return [...activityList.querySelectorAll('input:checked')].map(x=>x.value);}
function updateMode(){activityList.hidden=mode()!=='specific';}
modes.forEach(x=>{x.checked=x.value===(['include','exclude'].includes(params.get('activities'))?'specific':'all');x.onchange=updateMode;});updateMode();
function drawActivities(){activityList.replaceChildren();const ids=new Set(activitySelection(activities).map(a=>a.id));activities.forEach(a=>{const label=document.createElement('label'),input=document.createElement('input');input.type='checkbox';input.value=a.id;input.checked=!params.has('activities')||ids.has(a.id);label.append(input,document.createTextNode(' '+a.title));activityList.append(label);});$('slide-activity-status').textContent=activities.length?activities.length+' current activities available.':'No current activities available.';}
function checked(){return [...albumsBox.querySelectorAll('input:checked')].map(x=>x.value);}
function url(){return linkFor(albums,checked(),dur.value,captions.checked,(fitOptions.find(input=>input.checked)||fitOptions[0]).value,photosOn.checked,activitiesOn.checked?mode():'off',activities,activityChecked());}
function draw(){albumsBox.replaceChildren();const ids=new Set(selected(albums).map(a=>a.id));albums.forEach(a=>{const label=document.createElement('label'),input=document.createElement('input');input.type='checkbox';input.value=a.id;input.checked=ids.has(a.id);label.append(input,document.createTextNode(' '+a.title));albumsBox.append(label);});status.textContent=albums.length?albums.length+' published albums available.':'No published albums available.';}
$('slide-all').onclick=()=>albumsBox.querySelectorAll('input').forEach(x=>x.checked=true);
$('slide-none').onclick=()=>albumsBox.querySelectorAll('input').forEach(x=>x.checked=false);
$('slide-copy').onclick=async()=>{try{await navigator.clipboard.writeText(new URL(url(),location.origin).href);status.textContent='Slideshow link copied.';}catch(_){status.textContent='Could not copy link. Please copy it from the address bar after starting.';}};
form.onsubmit=e=>{e.preventDefault();if(!(photosOn.checked&&checked().length)&&!(activitiesOn.checked&&activities.length&&(mode()==='all'||activityChecked().length))){status.textContent='Select at least one available album or activity.';return;}location.href=url();};
Promise.allSettled([catalog(),activityCatalog()]).then(([p,a])=>{if(p.status==='fulfilled'){albums=p.value.filter(x=>(x.assets||[]).some(y=>!y.excludeFromSlideshow&&variant(y,'web')));draw();}else status.textContent='Could not load albums.';if(a.status==='fulfilled'){activities=a.value;drawActivities();}else $('slide-activity-status').textContent='Could not load activities. Refresh to retry.';});
return;
}
if(!$('slide-stage'))return;
const stage=$('slide-stage'),frames=[$('slide-frame-a'),$('slide-frame-b')],holding=$('slide-holding'),shade=$('slide-shade'),caption=$('slide-caption'),controls=$('slide-controls');
const fit=params.get('fit')==='fill'?'fill':'fit',cap=params.get('cap')==='1';
let items=[],order=[],cursor=-1,active=0,timer=null,paused=false,busy=false,hideTimer=null,retryTimer=null,last=-1,currentDuration=duration;
function shuffle(){const arr=items.map((_,i)=>i);for(let i=arr.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[arr[i],arr[j]]=[arr[j],arr[i]];}if(arr.length>1&&arr[0]===last)[arr[0],arr[1]]=[arr[1],arr[0]];return arr;}
function nextIndex(){if(cursor+1>=order.length){order=makeOrder();cursor=-1;}return order[++cursor];}
function shuffled(arr){const out=arr.slice();for(let i=out.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[out[i],out[j]]=[out[j],out[i]];}return out;}
function makeOrder(){const photos=shuffled(items.map((x,i)=>x.kind==='activity'?-1:i).filter(i=>i>=0)),activities=shuffled(items.map((x,i)=>x.kind==='activity'?i:-1).filter(i=>i>=0));const out=[];let p=0,a=0;while(p<photos.length||a<activities.length){out.push(...photos.slice(p,p+5));p+=5;if(a<activities.length)out.push(activities[a++]);if(p>=photos.length&&a<activities.length){out.push(...activities.slice(a));a=activities.length;}}if(out.length>1&&out[0]===last)[out[0],out[1]]=[out[1],out[0]];return out;}
function preload(src){return new Promise((resolve,reject)=>{const im=new Image();im.onload=()=>resolve(im);im.onerror=reject;im.src=src;});}
function setHolding(message){holding.textContent=message;holding.hidden=false;}
function schedule(){clearTimeout(timer);if(!paused&&items.length)timer=setTimeout(()=>void advance(1),currentDuration*1000);}
function showControls(){controls.classList.remove('hidden');clearTimeout(hideTimer);if(!paused)hideTimer=setTimeout(()=>controls.classList.add('hidden'),3000);}
async function showItem(i){if(busy||!items[i])return false;busy=true;try{const item=items[i],next=1-active,frame=frames[next];let content;
if(item.kind==='activity'){content=document.createElement('article');content.className='slide-activity-card';const kicker=document.createElement('p');kicker.className='slide-activity-kicker';kicker.textContent="WHAT'S HAPPENING AT SNH PINBALL CLUB";const title=document.createElement('h1');title.textContent=item.title||'Club activity';const body=document.createElement('p');body.className='slide-activity-body';body.textContent=item.body||'';content.append(kicker,title,body);if(item.src){try{const img=await preload(item.src);img.alt='';img.className='slide-activity-image';content.prepend(img);}catch(_){/* text fallback */}}}else content=await preload(item.src);
frame.replaceChildren(content);frame.className='slide-frame'+(item.kind==='activity'?' activity':fit==='fill'?' fill':'');currentDuration=item.kind==='activity'?Math.max(10,duration):duration;frame.style.setProperty('--slide-time',currentDuration+'s');void frame.offsetWidth;frame.classList.add('moving');frame.classList.add('active');frames[active].classList.remove('active');active=next;last=i;caption.textContent=item.kind==='activity'?'':cap?(item.caption||item.albumTitle||'').slice(0,240):'';shade.hidden=!caption.textContent;holding.hidden=true;return true;}catch(_){return false;}finally{busy=false;}}
async function advance(step){clearTimeout(timer);if(!items.length)return;if(busy)return;let attempts=0;while(attempts<items.length){let i;if(step<0&&cursor>0){i=order[--cursor];}else{i=nextIndex();}if(await showItem(i)){schedule();return;}attempts++;}setHolding('Photos are temporarily unavailable. Retrying shortly…');clearTimeout(retryTimer);retryTimer=setTimeout(()=>void advance(1),15000);}
function togglePause(force){paused=typeof force==='boolean'?force:!paused;$('slide-pause').textContent=paused?'Play':'Pause';$('slide-pause').setAttribute('aria-label',paused?'Resume slideshow':'Pause slideshow');if(paused)clearTimeout(timer);else schedule();showControls();}
$('slide-prev').onclick=()=>void advance(-1);$('slide-next').onclick=()=>void advance(1);$('slide-pause').onclick=()=>togglePause();$('slide-settings').onclick=()=>{location.href=settingsUrl+location.search;};
$('slide-fullscreen').onclick=()=>{if(document.fullscreenElement)document.exitFullscreen().catch(()=>{});else stage.requestFullscreen?.().catch(()=>{});};
document.addEventListener('fullscreenchange',()=>{if(!document.fullscreenElement)togglePause(true);});
document.addEventListener('keydown',e=>{if(e.target instanceof HTMLElement&&['INPUT','SELECT','TEXTAREA'].includes(e.target.tagName))return;if(e.code==='Space'){e.preventDefault();togglePause();}else if(e.key==='ArrowRight'){e.preventDefault();void advance(1);}else if(e.key==='ArrowLeft'){e.preventDefault();void advance(-1);}else if(e.key==='Escape'&&!document.fullscreenElement)togglePause(true);});
stage.addEventListener('pointermove',showControls);stage.addEventListener('pointerdown',showControls);
document.addEventListener('visibilitychange',()=>{if(document.hidden)togglePause(true);});
Promise.all([params.get('photos')==='0'?Promise.resolve([]):catalog(),params.has('activities')?activityCatalog():Promise.resolve([])]).then(([albums,activities])=>{const photos=selected(albums).flatMap(a=>(a.assets||[]).filter(x=>x.excludeFromSlideshow!==true).map(x=>({kind:'photo',src:imageUrl(variant(x,'web')),caption:x.caption,albumTitle:a.title})).filter(x=>x.src));const cards=activitySelection(activities).map(a=>({kind:'activity',title:a.title,body:a.body,src:activityImage(a)}));items=photos.concat(cards);if(!items.length){setHolding('No slideshow content is available. Choose Settings to adjust your selections.');return;}order=makeOrder();void advance(1);}).catch(()=>{setHolding('Unable to load club content. Retrying…');retryTimer=setTimeout(()=>location.reload(),15000);});
showControls();
})();