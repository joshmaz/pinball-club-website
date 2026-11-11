(function () {
  'use strict';
  var root, selected=null, rows=[], busy=false, dirty=false, admin=false, deliveries={};
  var deliveryLabels={pending:'Pending',sending:'Sending',shared:'Shared',failed:'Failed',uncertain:'Needs a channel check',not_shared:'Not shared',skipped:'Expired before delivery'};
  var dateFormat=new Intl.DateTimeFormat('en-US',{dateStyle:'medium',timeStyle:'short'});
  function node(tag,text,parent) {var n=document.createElement(tag); if(text)n.textContent=text; if(parent)parent.appendChild(n); return n;}
  function status(text) {document.getElementById('publishing-status').textContent=text;}
  function localDate(value) {if(!value)return ''; var d=new Date(value); return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,16);}
  function dateValue(id) {var value=document.getElementById(id).value; return value ? new Date(value).toISOString() : null;}
  function input(label,id,type,max,parent) {
    var wrap=node('label',label,parent||root), field=node(type==='textarea'?'textarea':'input','',wrap);
    field.id=id; if(type==='checkbox')field.setAttribute('style','width:auto;justify-self:start'); if(type!=='textarea')field.type=type; if(max)field.maxLength=max;
    field.addEventListener('input',function(){
      dirty=true;
      var preview=document.getElementById('publishing-announcement-preview');
      if(preview)preview.hidden=true;
    });
    return field;
  }
  function button(text,handler,parent) {var b=node('button',text,parent||root);b.type='button';b.addEventListener('click',handler);return b;}
  function canLeave(){return !dirty || window.confirm('Discard unsaved announcement changes?');}
  function closeEditor(){if(busy||!canLeave())return;selected=null;dirty=false;renderList();status('');}
  function websiteState(entry) {
    if (entry.archived) return 'Archived';
    if (!entry.published) return 'Private draft';
    var now=Date.now();
    if (Date.parse(entry.published.starts_at)>now) return 'Scheduled';
    if (Date.parse(entry.published.ends_at)<=now) return 'Display period ended';
    return 'Published';
  }
  function addDate(parent,label,value) {
    var timestamp=Date.parse(value);
    if (!Number.isFinite(timestamp)) return;
    var line=node('span',label+' ',parent);
    node('time',dateFormat.format(timestamp),line).dateTime=value;
  }
  function websiteDates(entry,parent) {
    if (entry.published) {
      addDate(parent,'Last published',entry.published_at);
      addDate(parent,'Display starts',entry.published.starts_at);
      addDate(parent,'Display ends',entry.published.ends_at);
    } else {
      addDate(parent,'Last updated',entry.updated_at);
    }
  }
  function edit(entry) {
    selected=entry; dirty=false; root.replaceChildren();
    button('← Back to announcements',closeEditor);
    var heading=node('h3',entry?'Edit announcement':'New announcement',root); heading.tabIndex=-1;
    if (entry) {
      var website=node('div','',root); website.className='announcement-record-meta';
      node('strong','Website: '+websiteState(entry),website);
      websiteDates(entry,website);
    }
    var content=node('fieldset','',root);
    node('legend','Announcement content',content);
    input('Title','publishing-title','text',120,content).value=entry?entry.draft.title:'';
    input('Text','publishing-body','textarea',2000,content).value=entry?entry.draft.body:'';
    input('Optional web link','publishing-url','url',2000,content).value=entry?(entry.draft.url||''):'';
    var schedule=node('fieldset','',root);
    node('legend','Homepage and slideshow schedule',schedule);
    node('p','Dates use your local timezone. Leave the start blank to go live when you publish.',schedule);
    input('Show from','publishing-start','datetime-local',0,schedule).value=entry?localDate(entry.draft.starts_at):'';
    input('Stop showing after (optional)','publishing-end','datetime-local',0,schedule).value=entry?localDate(entry.draft.ends_at):'';
    node('p','During these dates, the announcement can appear on the homepage and in slideshows that include announcements. It stays in All Announcements after the end date or after archiving. Withdraw it to remove it from public view.',schedule);
    node('p','The slideshow shows the title and up to 420 characters of text. Readers can find the full announcement and any link on All Announcements.',schedule);
    var discord=node('fieldset','',root);
    node('legend','Discord',discord);
    var share=input('Also share to Discord when published','publishing-share-discord','checkbox',0,discord);
    share.checked=!!(entry&&entry.draft_discord);
    node('p','Discord sharing begins when the announcement goes live.',discord);
    if(entry){var discordState=node('div','',discord);discordState.id='publishing-discord-state';renderDelivery(entry);}

    var preview=node('section','',root);preview.id='publishing-announcement-preview';preview.className='publishing-preview';preview.hidden=true;
    preview.setAttribute('aria-label','Announcement preview');
    var actions=node('div','',root);actions.className='announcement-editor-actions';
    button('Preview draft',function(){
      preview.hidden=false;
      window.SNHPublishing.render(preview,{title:document.getElementById('publishing-title').value,body:document.getElementById('publishing-body').value,url:document.getElementById('publishing-url').value,starts_at:dateValue('publishing-start')||new Date().toISOString()});
      preview.focus();
    },actions);
    preview.tabIndex=-1;
    var save=button('Save draft',function(){void write('save');},actions);
    if(!entry||entry.archived)save.className='announcement-primary-action';
    if(entry&&!entry.archived)button('Publish saved draft',function(){
      if(dirty){status('Save your draft before publishing.');return;}
      if(window.confirm('Publish this saved draft with its selected dates?'))void write('publish');
    },actions).className='announcement-primary-action';
    node('p','Save draft keeps your edits private. Publish saved draft applies them to the website and queues Discord sharing if selected.',root);
    if(entry) {
      var management=node('details','',root);management.className='announcement-management';
      node('summary','Manage announcement',management);
      if(entry.published)button('Withdraw from public view',function(){if(window.confirm('Remove this announcement from the homepage and public history?'))void write('withdraw');},management);
      button(entry.archived?'Restore':'Archive',function(){void write(entry.archived?'restore':'archive');},management);
      if(admin&&entry.archived&&!entry.published)button('Permanently delete',function(){if(window.confirm('Permanently delete this announcement? Its audit history will be retained.'))void write('delete');},management);
    }
  }
  function renderList() {
    root.replaceChildren();
    button('New announcement',function(){edit(null);}).className='announcement-new-button';
    var list=node('ul','',root);list.className='announcement-management-list';
    rows.forEach(function(entry){
      var item=node('li','',list);
      button(entry.draft.title,function(){edit(entry);},item).className='announcement-title-button';
      var meta=node('div','',item);meta.className='announcement-record-meta';
      node('strong','Website: '+websiteState(entry),meta);
      var delivery=deliveries[entry.id];
      if(delivery)node('span','Discord: '+(deliveryLabels[delivery.status]||delivery.status),meta);
      else if(entry.draft_discord)node('span','Discord selected in draft',meta);
      websiteDates(entry,meta);
    });
    if(!rows.length)node('p','No announcements yet.',root);
  }
  async function load(userRoles) {
    if(userRoles) admin=window.SNHSiteAuth.can(userRoles,'publishing.delete');
    if(busy)return; if(!canLeave())return;
    root=document.getElementById('member-publishing-app'); if(!root)return;
    busy=true;root.querySelectorAll('button,input,textarea').forEach(function(b){b.disabled=true;});status('Loading announcements…');
    try {var result=await window.snhSupabase.rpc('snh_publishing_list');if(result.error)throw result.error; rows=result.data||[];await refreshDeliveries();dirty=false;selected=null;renderList();status('');}
    catch(e){
      status((e.message||'Could not load announcements.')+' ');
      button('Try again',function(){void load();},document.getElementById('publishing-status'));
    } finally{busy=false;root.querySelectorAll('button,input,textarea').forEach(function(b){b.disabled=false;});}
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
      dirty=false; if(action!=='delete'){var index=rows.findIndex(function(row){return row.id===result.data.id;});if(index===-1)rows.unshift(result.data);else rows[index]=result.data;} if(action==='delete'){busy=false;await load();} else edit(result.data);
      if(['publish','withdraw','delete'].indexOf(action)!==-1&&((result.data&&result.data.discord_requested)||deliveries[args.p_id]))void dispatch();
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
      if(selected)renderDelivery(selected);else renderList();
      if(result.data&&result.data.configured===false)status('Website saved. Discord delivery is waiting for server setup.');
    }catch(_){status('Website saved. Discord delivery is pending; use Check delivery to retry the worker.');}
  }
  function renderDelivery(entry){
    var parent=document.getElementById('publishing-discord-state');if(!parent)return;parent.replaceChildren();
    var delivery=deliveries[entry.id];
    node('h4','Delivery status',parent);
    node('p',delivery?(deliveryLabels[delivery.status]||delivery.status):'No delivery recorded.',parent);
    if(delivery&&delivery.status==='pending')node('p','Scheduled posts wait until the announcement goes live.',parent);
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
  window.SNHMemberPublishingPanel={load:load,canLeave:canLeave,reset:function(){selected=null;dirty=false;if(root)renderList();}};
})();
