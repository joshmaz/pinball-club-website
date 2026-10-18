(function () {
  'use strict';
  var root, selected=null, rows=[], busy=false, dirty=false, admin=false, deliveries={};
  function node(tag,text,parent) {var n=document.createElement(tag); if(text)n.textContent=text; if(parent)parent.appendChild(n); return n;}
  function status(text) {document.getElementById('publishing-status').textContent=text;}
  function localDate(value) {if(!value)return ''; var d=new Date(value); return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,16);}
  function dateValue(id) {var value=document.getElementById(id).value; return value ? new Date(value).toISOString() : null;}
  function input(label,id,type,max) {
    var wrap=node('label',label,root), field=node(type==='textarea'?'textarea':'input','',wrap);
    field.id=id; if(type!=='textarea')field.type=type; if(max)field.maxLength=max;
    field.addEventListener('input',function(){dirty=true;}); return field;
  }
  function button(text,handler,parent) {var b=node('button',text,parent||root);b.type='button';b.addEventListener('click',handler);return b;}
  function canLeave(){return !dirty || window.confirm('Discard unsaved announcement changes?');}
  function edit(entry) {
    selected=entry; dirty=false; root.replaceChildren();
    var heading=node('h3',entry?'Edit announcement':'New announcement',root); heading.tabIndex=-1;
    node('p','Plain text only. Saving a draft leaves the published version unchanged. Dates use your local timezone.',root);
    input('Title','publishing-title','text',120).value=entry?entry.draft.title:'';
    input('Text','publishing-body','textarea',2000).value=entry?entry.draft.body:'';
    input('Optional web link','publishing-url','url',2000).value=entry?(entry.draft.url||''):'';
    input('Publish from (blank means now when published)','publishing-start','datetime-local').value=entry?localDate(entry.draft.starts_at):'';
    input('Remove from homepage after (optional)','publishing-end','datetime-local').value=entry?localDate(entry.draft.ends_at):'';
    input('Also share to Discord when published','publishing-share-discord','checkbox').checked=!!(entry&&entry.draft_discord);
    node('p','Discord sharing starts at publication time. Saving this choice alone does not send a message.',root);
    if(entry){var discordState=node('section','',root);discordState.id='publishing-discord-state';renderDelivery(entry);}
    var preview=node('section','',root);preview.className='publishing-preview';preview.setAttribute('aria-label','Announcement preview');
    button('Preview draft',function(){window.SNHPublishing.render(preview,{title:document.getElementById('publishing-title').value,body:document.getElementById('publishing-body').value,url:document.getElementById('publishing-url').value,starts_at:dateValue('publishing-start')||new Date().toISOString()});});
    button('Save draft',function(){void write('save');});
    if(entry) {
      node('p',entry.archived?'Archived. Retained in history if previously published.':entry.published?'Published version retained. Use Publish saved draft to replace it.':'Private draft. Not visible to visitors.',root);
      if(!entry.archived)button('Publish saved draft',function(){if(dirty){status('Save your draft before publishing.');return;} if(window.confirm('Publish this saved draft with its selected dates?'))void write('publish');});
      if(entry.published)button('Withdraw from public view',function(){if(window.confirm('Remove this announcement from the homepage and public history?'))void write('withdraw');});
      button(entry.archived?'Restore':'Archive',function(){void write(entry.archived?'restore':'archive');});
      if(admin&&entry.archived&&!entry.published)button('Permanently delete',function(){if(window.confirm('Permanently delete this announcement? Its audit history will be retained.'))void write('delete');});
    }
    button('Back to announcements',function(){if(canLeave()){selected=null;dirty=false;void load();}});
  }
  function renderList() {
    root.replaceChildren();button('Refresh announcements',function(){void load();});button('New announcement',function(){edit(null);});
    var list=node('ul','',root);
    rows.forEach(function(entry){var item=node('li','',list);button(entry.draft.title,function(){edit(entry);},item);
      var state=entry.archived?'Archived':!entry.published?'Draft':new Date(entry.published.starts_at)>new Date()?'Scheduled':entry.published.ends_at&&new Date(entry.published.ends_at)<=new Date()?'Expired':'Published';
      node('span',' — '+state,item);
    });
    if(!rows.length)node('p','No announcements yet.',root);
  }
  async function load(userRoles) {
    if(userRoles) admin=window.SNHSiteAuth.can(userRoles,'publishing.delete');
    if(busy)return; if(!canLeave())return;
    root=document.getElementById('member-publishing-app'); if(!root)return;
    busy=true;root.querySelectorAll('button,input,textarea').forEach(function(b){b.disabled=true;});status('Loading announcements…');
    try {var result=await window.snhSupabase.rpc('snh_publishing_list');if(result.error)throw result.error; rows=result.data||[];await refreshDeliveries();dirty=false;selected=null;renderList();status('');}
    catch(e){status(e.message||'Could not load announcements.');} finally{busy=false;root.querySelectorAll('button,input,textarea').forEach(function(b){b.disabled=false;});}
  }
  async function write(action) {
    if(busy)return;
    if(action!=='save'&&dirty){status('Save your draft or reload before changing publication.');return;}
    var args={p_action:action,p_id:selected?selected.id:null,p_version:selected?selected.version:null};
    try {
      if(action==='save') {
        args.p_share_discord=document.getElementById('publishing-share-discord').checked;
        args.p_title=document.getElementById('publishing-title').value.trim();args.p_body=document.getElementById('publishing-body').value.trim();
        args.p_url=document.getElementById('publishing-url').value.trim();args.p_starts_at=dateValue('publishing-start');args.p_ends_at=dateValue('publishing-end');
        if(!args.p_title||!args.p_body)throw new Error('Enter a title and announcement text.');
        if(args.p_url&&!window.SNHPublishing.safeUrl(args.p_url))throw new Error('Use a valid HTTP or HTTPS web link without login details.');
      }
      busy=true;root.querySelectorAll('button,input,textarea').forEach(function(b){b.disabled=true;});
      var result=await window.snhSupabase.rpc('snh_publishing_write',args);if(result.error)throw result.error;
      dirty=false; if(action==='delete'){busy=false;await load();} else edit(result.data);
      if(['publish','withdraw','delete'].indexOf(action)!==-1&&(result.data.discord_requested||deliveries[args.p_id]))void dispatch();
      status(action==='save'?'Draft saved. The public version is unchanged.':'Announcement updated.');
    } catch(e){status(e.message||'Could not save. Reload before trying again.');}
    finally{busy=false;root.querySelectorAll('button,input,textarea').forEach(function(b){b.disabled=false;});}
  }
  async function refreshDeliveries(){
    var result=await window.snhSupabase.rpc('snh_publishing_discord_status');if(result.error)throw result.error;
    deliveries={};(result.data||[]).forEach(function(item){deliveries[item.entry_id]=item;});
  }
  async function dispatch(){
    try{
      if(!window.snhSupabase.functions)throw new Error('Delivery worker is not available.');
      var result=await window.snhSupabase.functions.invoke('publishing-discord-dispatch',{body:{}});
      if(result.error)throw result.error;
      await refreshDeliveries();
      if(selected)renderDelivery(selected);
      if(result.data&&result.data.configured===false)status('Website saved. Discord delivery is waiting for server setup.');
    }catch(_){status('Website saved. Discord delivery is pending; use Check delivery to retry the worker.');}
  }
  function renderDelivery(entry){
    var parent=document.getElementById('publishing-discord-state');if(!parent)return;parent.replaceChildren();
    var delivery=deliveries[entry.id],labels={pending:'Pending (scheduled items wait for their publication time)',sending:'Sending',shared:'Shared',failed:'Failed',uncertain:'Needs a channel check',not_shared:'Not shared',skipped:'Expired before delivery'};
    node('h4','Discord',parent);node('p',delivery?(labels[delivery.status]||delivery.status):entry.draft_discord?'Will be queued when published.':'Sharing is off for this draft.',parent);
    if(delivery&&delivery.last_error)node('p',delivery.last_error,parent);
    if(delivery&&delivery.guild_id&&delivery.message_id){var a=node('a','Open Discord message ↗',parent);a.href='https://discord.com/channels/'+[delivery.guild_id,delivery.channel_id,delivery.message_id].map(encodeURIComponent).join('/');}
    if(delivery||entry.draft_discord)button('Check delivery',function(){void dispatch();},parent);
    if(delivery&&delivery.status==='failed')button('Retry delivery',async function(){
      try{var r=await window.snhSupabase.rpc('snh_retry_publishing_discord',{p_id:entry.id});if(r.error)throw r.error;await dispatch();}catch(e){status(e.message||'Could not retry delivery.');}
    },parent);
    if(admin&&delivery&&['uncertain','sending'].indexOf(delivery.status)!==-1){
      node('p','Check the configured Discord channel before retrying an interrupted first post.',parent);
      var label=node('label','Existing Discord message link (if found)',parent),field=node('input','',label);field.type='url';
      button('Use existing Discord message',function(){
        var match=field.value.match(/^https:\/\/discord.com\/channels\/([0-9]+)\/([0-9]+)\/([0-9]+)$/);
        if(!match){status('Paste a Discord message link.');return;}
        void reconcile(entry.id,match[3],match[2]);
      },parent);
      button('No message was posted — retry',function(){if(window.confirm('Have you checked the Discord channel and confirmed there is no post? Retrying could duplicate a message if one exists.'))void reconcile(entry.id,null,null);},parent);
    }
  }
  async function reconcile(id,message,channel){
    try{var r=await window.snhSupabase.rpc('snh_reconcile_publishing_discord',{p_id:id,p_message_id:message,p_channel_id:channel});if(r.error)throw r.error;
      if(!r.data){status('Delivery is still in progress. Wait five minutes before reconciling.');return;}await dispatch();
    }catch(e){status(e.message||'Could not reconcile delivery.');}
  }
  window.addEventListener('beforeunload',function(e){if(dirty){e.preventDefault();e.returnValue='';}});
  window.SNHMemberPublishingPanel={load:load,canLeave:canLeave};
})();
