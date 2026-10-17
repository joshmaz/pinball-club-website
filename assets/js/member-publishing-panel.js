(function () {
  'use strict';
  var root, selected=null, rows=[], busy=false, dirty=false, admin=false;
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
    busy=true; status('Loading announcements…');
    try {var result=await window.snhSupabase.rpc('snh_publishing_list');if(result.error)throw result.error; rows=result.data||[];dirty=false;selected=null;renderList();status('');}
    catch(e){status(e.message||'Could not load announcements.');} finally{busy=false;}
  }
  async function write(action) {
    if(busy)return;
    if(action!=='save'&&dirty){status('Save your draft or reload before changing publication.');return;}
    var args={p_action:action,p_id:selected?selected.id:null,p_version:selected?selected.version:null};
    try {
      if(action==='save') {
        args.p_title=document.getElementById('publishing-title').value.trim();args.p_body=document.getElementById('publishing-body').value.trim();
        args.p_url=document.getElementById('publishing-url').value.trim();args.p_starts_at=dateValue('publishing-start');args.p_ends_at=dateValue('publishing-end');
        if(!args.p_title||!args.p_body)throw new Error('Enter a title and announcement text.');
        if(args.p_url&&!window.SNHPublishing.safeUrl(args.p_url))throw new Error('Use a valid HTTP or HTTPS web link without login details.');
      }
      busy=true;root.querySelectorAll('button,input,textarea').forEach(function(b){b.disabled=true;});
      var result=await window.snhSupabase.rpc('snh_publishing_write',args);if(result.error)throw result.error;
      dirty=false; if(action==='delete'){busy=false;await load();} else edit(result.data);
      status(action==='save'?'Draft saved. The public version is unchanged.':'Announcement updated.');
    } catch(e){status(e.message||'Could not save. Reload before trying again.');}
    finally{busy=false;root.querySelectorAll('button,input,textarea').forEach(function(b){b.disabled=false;});}
  }
  window.addEventListener('beforeunload',function(e){if(dirty){e.preventDefault();e.returnValue='';}});
  window.SNHMemberPublishingPanel={load:load,canLeave:canLeave};
})();
