(function(){
 'use strict';
 function imageUrl(id){if(!/^[0-9a-f-]{36}$/i.test(id||''))return '';return window.snhSupabase.storage.from('publishing-public').getPublicUrl(id+'/web.webp').data.publicUrl;}
 function render(parent,entry,preview){
  var card=document.createElement('article');card.className='activity-card';
  var source=preview||imageUrl(entry.image_id);
  if(source){var image=document.createElement('img');image.src=source;image.alt=entry.image_alt||'';image.loading='lazy';image.className='activity-image';image.style.objectFit=entry.fit==='contain'?'contain':'cover';image.style.objectPosition=(entry.focus_x??50)+'% '+(entry.focus_y??50)+'%';card.appendChild(image);}
  else{var fallback=document.createElement('div');fallback.className='activity-image activity-fallback';fallback.setAttribute('aria-hidden','true');fallback.textContent='Meet at the club';card.appendChild(fallback);}
  var content=document.createElement('div');content.className='activity-copy';card.appendChild(content);
  var title=document.createElement('h3');title.textContent=entry.title;content.appendChild(title);
  var body=document.createElement('p');body.textContent=entry.body;body.className='publishing-text';content.appendChild(body);
  var url=window.SNHPublishing.safeUrl(entry.url);if(url){var link=document.createElement('a');link.href=url;link.textContent='Find out more \u2197';link.rel='noopener noreferrer';content.appendChild(link);}parent.appendChild(card);
 }
 window.SNHActivities={render:render,imageUrl:imageUrl};
 async function load(){var section=document.getElementById('home-activities'),root=document.getElementById('public-activities');if(!root)return;
  try{var result=await window.snhSupabase.rpc('snh_public_activities');if(result.error)throw result.error;root.replaceChildren();(result.data||[]).forEach(function(entry){render(root,entry);});section.hidden=!result.data?.length;}
  catch(_){section.hidden=true;}
 }
 if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',load);else void load();
})();
