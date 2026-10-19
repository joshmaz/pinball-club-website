(function () {
  'use strict';
  function safeUrl(value) {
    try { var url = new URL(value); return /^https?:$/.test(url.protocol) && !url.username && !url.password ? url.href : ''; }
    catch (_) { return ''; }
  }
  function permalink(id) {return 'announcements.html?id='+encodeURIComponent(id);}
  function discordUrl(entry) {
    var ids=[entry.discord_guild_id,entry.discord_channel_id,entry.discord_message_id];
    return ids.every(function(id){return /^[0-9]{15,25}$/.test(id||'');})?'https://discord.com/channels/'+ids.join('/'):'';
  }
  function render(parent, entry, options) {
    options=options||{}; parent.replaceChildren();
    var date=document.createElement('time');date.dateTime=entry.starts_at;
    date.textContent=new Date(entry.starts_at).toLocaleDateString(undefined,{year:'numeric',month:'long',day:'numeric'});parent.appendChild(date);
    var title=document.createElement(options.detail?'h1':options.history?'h2':'h3');title.textContent=entry.title;parent.appendChild(title);
    var body=document.createElement('p');body.className='publishing-text';body.textContent=entry.body;parent.appendChild(body);
    var links=document.createElement('div');links.className='announcement-actions';parent.appendChild(links);
    function link(label,url){var a=document.createElement('a');a.textContent=label;a.href=url;a.rel='noopener noreferrer';links.appendChild(a);}
    var url=safeUrl(entry.url);if(url)link('Read more ↗',url);
    var discussion=discordUrl(entry);if(discussion)link('Discuss on Discord ↗',discussion);
    if(entry.id) {
      if(options.history&&!options.detail)link('Open announcement',permalink(entry.id));
      if(options.history||options.detail) {
        var copy=document.createElement('button');copy.type='button';copy.className='announcement-copy-link';
        copy.setAttribute('aria-label','Copy announcement link');copy.title='Copy announcement link';
        var icon=document.createElementNS('http://www.w3.org/2000/svg','svg');icon.setAttribute('viewBox','0 0 24 24');icon.setAttribute('width','18');icon.setAttribute('height','18');icon.setAttribute('aria-hidden','true');
        var path=document.createElementNS('http://www.w3.org/2000/svg','path');path.setAttribute('d','M5 5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16l-7-3.5L5 21V5z');path.setAttribute('fill','none');path.setAttribute('stroke','currentColor');path.setAttribute('stroke-width','2');path.setAttribute('stroke-linejoin','round');icon.appendChild(path);copy.replaceChildren(icon);
        var feedback=document.createElement('span');feedback.className='announcement-copy-feedback';feedback.setAttribute('role','status');
        copy.addEventListener('click',async function(){
          var value=new URL(permalink(entry.id),window.location.href).href;
          try{await navigator.clipboard.writeText(value);feedback.textContent='Link copied';}
          catch(_){feedback.textContent='Copy the announcement address from your browser';}
        });links.appendChild(copy);links.appendChild(feedback);
      }
    }
  }
  window.SNHPublishing={safeUrl:safeUrl,render:render,permalink:permalink,discordUrl:discordUrl};
  async function publicPage() {
    var root=document.getElementById('public-announcements');if(!root)return;
    var history=root.dataset.history==='true',status=document.getElementById('announcements-status');
    var older=document.getElementById('announcements-more'),newer=document.getElementById('announcements-newer');
    var retry=document.getElementById('announcements-retry'), params=new URLSearchParams(window.location.search);
    function pageLink(prefix,entry){return 'announcements.html?'+prefix+'='+encodeURIComponent(entry.starts_at)+'&'+prefix+'_id='+encodeURIComponent(entry.id);}
    async function load() {
      if(retry)retry.hidden=true;
      try {
        var result,detail=history&&params.has('id');
        if(detail)result=await window.snhSupabase.rpc('snh_public_announcement',{p_id:params.get('id')});
        else if(history){
          var args={};['before','after'].forEach(function(key){if(params.has(key)){args['p_'+key+'_start']=params.get(key);args['p_'+key+'_id']=params.get(key+'_id');}});
          result=await window.snhSupabase.rpc('snh_public_announcement_page',args);
        } else result=await window.snhSupabase.rpc('snh_public_announcements',{p_history:false,p_limit:1});
        if(result.error)throw result.error;
        var data=result.data,entries=detail?(data?[data]:[]):history?(data.entries||[]):(data||[]);
        root.replaceChildren();
        entries.forEach(function(entry){var article=document.createElement('article');article.className='announcement-card';article.id='announcement-'+entry.id;render(article,entry,{history:history,detail:detail});root.appendChild(article);});
        if(status)status.textContent=entries.length?'':detail?'This announcement is unavailable. It may have been withdrawn.':'Nothing on the bulletin board yet. Check Events to find your next club night.';
        if(older){older.hidden=detail||!data.has_older;if(!older.hidden)older.href=pageLink('before',entries[entries.length-1]);}
        if(newer){newer.hidden=detail||!data.has_newer;if(!newer.hidden)newer.href=pageLink('after',entries[0]);}
        var heading=document.getElementById('announcements-heading');if(heading&&detail)heading.hidden=true;
        if(detail&&entries[0])document.title=entries[0].title+' · SNHPC';
      }catch(_){if(status)status.textContent='The bulletin board is taking a breather. Try again, or check Events for your next game.';if(retry)retry.hidden=false;}
    }
    if(retry)retry.addEventListener('click',load);await load();
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',publicPage);else void publicPage();
})();
