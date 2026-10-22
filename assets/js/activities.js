(function () {
 'use strict';
 function node(tag,text,parent){var n=document.createElement(tag);if(text)n.textContent=text;if(parent)parent.appendChild(n);return n;}
 function safeUrl(value){return window.SNHPublishing.safeUrl(value);}
 function permalink(id){return id?'activities.html?id='+encodeURIComponent(id):'#activity-draft-detail';}
 function imageUrl(id){if(!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(id||''))return '';return window.snhSupabase.storage.from('publishing-public').getPublicUrl(id+'/web.webp').data.publicUrl;}
 function links(entry){return (Array.isArray(entry.links)?entry.links:[]).filter(function(l){return safeUrl(l.url);});}
 function destination(entry){var all=links(entry),chosen=all.find(function(l){return l.url===entry.destination_url;});if(entry.destination==='external'&&chosen)return chosen;return {url:permalink(entry.id),label:'View activity'};}
 function anchor(parent,label,url,newTab){var a=node('a',label,parent);a.href=url;a.rel='noopener noreferrer';if(newTab){a.target='_blank';a.setAttribute('aria-label',label+' (opens in a new tab)');}return a;}
 function render(parent,entry,preview){
  var card=node('article','',parent);card.className='activity-card';var source=preview||imageUrl(entry.image_id),dest=destination(entry),newTab=entry.destination==='external'&&dest.url===entry.destination_url;
  if(source){var imageLink=anchor(card,'',dest.url,newTab);imageLink.setAttribute('aria-label','View '+entry.title+(newTab?' (opens in a new tab)':''));imageLink.className='activity-image-link';var image=node('img','',imageLink);image.src=source;image.alt=entry.image_alt||'';image.loading='lazy';image.className='activity-image';image.style.objectFit=entry.fit==='contain'?'contain':'cover';image.style.objectPosition=(entry.focus_x??50)+'% '+(entry.focus_y??50)+'%';}
  else{var fallback=node('div','Meet at the club',card);fallback.className='activity-image activity-fallback';fallback.setAttribute('aria-hidden','true');}
  var content=node('div','',card);content.className='activity-copy';var heading=node('h3','',content);
  anchor(heading,entry.title,dest.url,newTab);var body=node('p',entry.body,content);body.className='publishing-text';
  var actions=node('div','',content);actions.className='activity-actions';anchor(actions,(dest.label||'Find out more')+(entry.destination==='external'?' ↗':''),dest.url,newTab);
  if(entry.destination==='external'&&(entry.details||links(entry).length>1))anchor(actions,'Details',permalink(entry.id));
 }
 function details(parent,text){
  String(text||'').split(/\n\s*\n/).filter(Boolean).forEach(function(block){
   var lines=block.split('\n');if(lines.every(function(line){return /^\s*[-*] /.test(line);})){var list=node('ul','',parent);lines.forEach(function(line){node('li',line.replace(/^\s*[-*] /,''),list);});}
   else{var p=node('p',block,parent);p.className='activity-paragraph';}
  });
 }
 function renderDetail(parent,entry,preview){
  parent.replaceChildren();var article=node('article','',parent);article.className='activity-detail';
  if(entry.ended){var badge=node('p','Ended — this Activity has finished. Links and information may be out of date.',article);badge.className='activity-ended';}
  node('h1',entry.title,article);node('p',entry.body,article).className='club-lead';
  var source=preview||imageUrl(entry.image_id);if(source){var image=node('img','',article);image.src=source;image.alt=entry.image_alt||'';image.className='activity-flyer';anchor(article,'View full image ↗',source);}
  details(article,entry.details);var all=links(entry);if(all.length){node('h2','Useful links',article);var list=node('ul','',article);all.forEach(function(l){anchor(node('li','',list),l.label||'Activity link',safeUrl(l.url),true);});}
  if(entry.id){var actions=node('div','',article);actions.className='announcement-actions';var copy=node('button','',actions);copy.type='button';copy.className='announcement-copy-link';copy.setAttribute('aria-label','Copy Activity link');copy.title='Copy Activity link';var icon=document.createElementNS('http://www.w3.org/2000/svg','svg');icon.setAttribute('viewBox','0 0 24 24');icon.setAttribute('width','18');icon.setAttribute('height','18');icon.setAttribute('aria-hidden','true');var path=document.createElementNS('http://www.w3.org/2000/svg','path');path.setAttribute('d','M5 5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16l-7-3.5L5 21V5z');path.setAttribute('fill','none');path.setAttribute('stroke','currentColor');path.setAttribute('stroke-width','2');path.setAttribute('stroke-linejoin','round');icon.appendChild(path);copy.appendChild(icon);var feedback=node('span','',actions);feedback.className='announcement-copy-feedback';feedback.setAttribute('role','status');copy.addEventListener('click',async function(){try{await navigator.clipboard.writeText(new URL(permalink(entry.id),window.location.href).href);feedback.textContent='Activity link copied.';}catch(_){feedback.textContent='Copy the address from your browser to share this Activity.';}});}
 }
 window.SNHActivities={render:render,renderDetail:renderDetail,imageUrl:imageUrl,permalink:permalink,destination:destination};
 async function load(){
  var section=document.getElementById('home-activities'),root=document.getElementById('public-activities');if(!root)return;
  var detail=root.dataset?.detail==='true',status=document.getElementById('activities-status'),retry=document.getElementById('activities-retry');
  if(retry){retry.hidden=true;retry.onclick=load;}
  try{
   if(detail){var id=new URLSearchParams(window.location.search).get('id');if(!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(id||'')){status.textContent='Choose an Activity from the club homepage.';return;}
    var result=await window.snhSupabase.rpc('snh_public_activity',{p_id:id});if(result.error)throw result.error;
    if(!result.data){root.replaceChildren();status.textContent='This Activity is unavailable.';return;}
    renderDetail(root,result.data);status.textContent='';document.title=result.data.title+' | SNHPC Activities';
   }else{var feed=await window.snhSupabase.rpc('snh_public_activities');if(feed.error)throw feed.error;root.replaceChildren();(feed.data||[]).forEach(function(entry){render(root,entry);});section.hidden=!feed.data?.length;}
  }catch(_){if(detail){status.textContent='Activities could not be loaded. Please try again.';if(retry)retry.hidden=false;}else section.hidden=true;}
 }
 if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',load);else void load();
})();
