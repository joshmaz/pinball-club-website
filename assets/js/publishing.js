(function () {
  'use strict';
  function safeUrl(value) {
    try { var url = new URL(value); return /^https?:$/.test(url.protocol) && !url.username && !url.password ? url.href : ''; }
    catch (_) { return ''; }
  }
  function render(parent, entry) {
    parent.replaceChildren();
    var title = document.createElement('h3'); title.textContent = entry.title; parent.appendChild(title);
    var date = document.createElement('time'); date.dateTime = entry.starts_at;
    date.textContent = new Date(entry.starts_at).toLocaleDateString(undefined, {year:'numeric',month:'long',day:'numeric'});
    parent.appendChild(date);
    var body = document.createElement('p'); body.className = 'publishing-text'; body.textContent = entry.body; parent.appendChild(body);
    var url = safeUrl(entry.url);
    if (url) { var link = document.createElement('a'); link.href = url; link.textContent = 'Read more ↗'; link.rel = 'noopener noreferrer'; parent.appendChild(link); }
  }
  window.SNHPublishing = {safeUrl:safeUrl, render:render};
  async function publicPage() {
    var root = document.getElementById('public-announcements'); if (!root) return;
    var history = root.dataset.history === 'true', cursor = null;
    var status = document.getElementById('announcements-status'), more = document.getElementById('announcements-more');
    async function load() {
      if (more) more.disabled = true;
      try {
        var args = {p_history:history,p_limit:history ? 20 : 1};
        if (cursor) { args.p_before_start=cursor.starts_at; args.p_before_id=cursor.id; }
        var result = await window.snhSupabase.rpc('snh_public_announcements',args);
        if (result.error) throw result.error;
        var entries=result.data || [];
        entries.forEach(function(entry) { var article=document.createElement('article'); render(article,entry); root.appendChild(article); });
        if (status) status.textContent = root.children.length ? '' : 'No announcements to show. Check the Events page for upcoming club activities.';
        if (more) { more.hidden=entries.length<20; more.disabled=false; }
        cursor=entries[entries.length-1] || cursor;
      } catch (_) { if (status) status.textContent='Club updates are unavailable right now. Check the Events page or try again later.'; if(more) more.hidden=true; }
    }
    if(more) more.addEventListener('click',load);
    await load();
  }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',publicPage); else void publicPage();
})();
