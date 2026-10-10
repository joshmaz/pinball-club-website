(function () {
  var allowed = false, initialized = false, busy = false, snapshot, configuration, current = 'overview';
  var pinballmap = null, pinballmapError = '';
  var root, content, status, tabs, messages = [], cursor = null, filter = '';
  var names = { matchplay: 'Match Play', ifpa: 'IFPA', pinballmap: 'Pinball Map', pintips: 'PinTips' };
  function el(tag, text, parent) {
    var node = document.createElement(tag);
    if (text != null) node.textContent = String(text);
    if (parent) parent.appendChild(node);
    return node;
  }
  function duration(seconds) {
    for (var unit of [[86400, 'day'], [3600, 'hour'], [60, 'minute']]) {
      if (seconds >= unit[0] && seconds % unit[0] === 0) return seconds / unit[0] + ' ' + unit[1] + (seconds === unit[0] ? '' : 's');
    }
    return seconds + ' seconds';
  }
  function route() {
    if (!window.location) return;
    var params = new URLSearchParams(window.location.search);
    params.set('panel', 'operations'); params.set('section', current);
    if (current === 'messaging' && filter) params.set('messageStatus', filter); else params.delete('messageStatus');
    params.delete('game'); params.delete('event');
    window.history.replaceState(null, '', window.location.pathname + '?' + params.toString());
  }
  async function selectSection(section, messageStatus) {
    if (busy) return;
    current = section;
    if (messageStatus !== undefined) filter = messageStatus;
    route();
    if (current === 'audit') { render(); await window.SNHMemberAuditPanel.load(false); }
    else if (current === 'messaging') await loadMessages(false);
    else if (!snapshot) await load();
    else render();
  }
  async function cleanup() {
    var count = await rpc('snh_operations_cleanup');
    return { message: count < 0 ? 'Cache cleanup failed. No entries were removed. See Jobs for the recorded error.' : 'Removed ' + count + ' expired search cache entries.' };
  }
  function date(value) { return value ? new Date(value).toLocaleString() : 'Not recorded'; }
  function button(text, parent, action) {
    var b = el('button', text, parent); b.type = 'button'; b.className = 'btn btn-secondary';
    b.disabled = busy; b.addEventListener('click', action); return b;
  }
  async function rpc(name, args) {
    var result = await window.snhSupabase.rpc(name, args || {});
    if (result.error) throw new Error(result.error.message || 'Request failed');
    return result.data;
  }
  async function edge(action) {
    var result = await window.snhSupabase.functions.invoke('operations', { body: { action: action } });
    if (result.error || result.data.error) throw new Error('Operations service unavailable. Check deployment and your session.');
    return result.data;
  }
  async function mutate(action, confirmation) {
    if (busy || !allowed || (confirmation && !window.confirm(confirmation))) return;
    busy = true; setBusy(); status.textContent = 'Working...';
    try {
      var result = await action();
      await refresh();
      status.textContent = result && result.message || 'Saved. Information refreshed.';
    } catch (error) { status.textContent = error.message; }
    finally { busy = false; setBusy(); }
  }
  function setBusy() {
    [content, tabs, document.getElementById('operations-refresh')].forEach(function (area) {
      area.querySelectorAll('button, input, select').forEach(function (n) { n.disabled = busy || (n.unavailable ? n.unavailable() : false); });
    });
  }
  function health(rows) {
    if (!rows.length) return 'Not observed';
    if (rows.some(function (r) { return r.last_error_at && (!r.last_success_at || r.last_error_at >= r.last_success_at); })) return 'Needs attention';
    return rows.some(function (r) { return r.last_success_at; }) ? 'Last request succeeded' : 'Awaiting result';
  }
  function table(headers, parent) {
    var wrap = el('div', null, parent || content); wrap.className = 'operations-table-wrap';
    var t = el('table', null, wrap), head = el('tr', null, el('thead', null, t));
    headers.forEach(function (h) { var th = el('th', h, head); th.scope = 'col'; });
    return el('tbody', null, t);
  }
  function cell(row, text) { return el('td', text, row); }
  function providerRows(provider) { return snapshot.integrations.filter(function (r) { return r.provider === provider; }); }
  function runOutcome(run) {
    if (!run) return 'Not recorded';
    if (run.status === 'running') return Date.now() - new Date(run.started_at).getTime() > 600000 ? 'Completion unknown' : 'Running';
    return run.status === 'succeeded' && run.result.warning ? 'Succeeded with warning' : run.status === 'succeeded' ? 'Succeeded' : 'Failed';
  }
  function changeSummary(run) {
    if (!run || !run.result) return 'Changes not recorded';
    var count = run.result.change_count || 0, c = run.result.counts || {};
    if (!count) return run.status === 'succeeded' ? 'No changes' : 'No committed changes recorded';
    return (c.games || 0) + ' game records, ' + (c.locations || 0) + ' location records, ' + (c.conditions || 0) + ' condition reports, ' + (c.images || 0) + ' image records added or changed';
  }
  function changes(run, parent) {
    el('p', changeSummary(run), parent);
    var rows = run && run.result.changes || [];
    if (!rows.length) return;
    var details = el('details', null, parent); el('summary', 'Game names and changed fields', details);
    var labels = {map_at_club:'At club',joined_club_date:'Arrival date',left_club_date:'Departure date',
      opdb_id:'OPDB ID',ipdb_url:'IPDB link',location_value:'Image URL',metadata:'Image metadata'};
    var list = el('ul', null, details);
    rows.forEach(function (change) {
      var item = el('li', null, list);
      if (change.game_id) {
        var link = el('a',change.title,item); link.href = 'members.html?panel=games&game=' + encodeURIComponent(change.game_id);
      } else el('span',change.title || 'Unmatched game',item);
      el('span', ': ' + change.kind + ' ' + change.action + ' (' + (change.fields || []).map(function (f) { return labels[f] || f.replace(/_/g,' '); }).join(', ') + ')', item);
    });
    if (run.result.change_count > rows.length) el('p','Showing the first ' + rows.length + ' changed records.',details);
  }
  function pinballmapSummary(parent) {
    if (!pinballmap) { el('p',pinballmapError || 'Import information unavailable.',parent); return; }
    var latest = pinballmap.runs[0], manual = pinballmap.last_manual, schedule = pinballmap.schedule;
    el('p','Last attempt: ' + (latest ? date(latest.started_at) + ' | ' + runOutcome(latest) : 'Not recorded'),parent);
    el('p','Last successful completion: ' + date(pinballmap.last_success && pinballmap.last_success.finished_at),parent);
    el('p','Last manual invocation: ' + (manual ? date(manual.started_at) + ' | ' + manual.actor + ' | ' + runOutcome(manual) : 'Not recorded'),parent);
    el('p','Schedule: ' + (schedule ? (schedule.enabled ? 'Enabled' : 'Disabled') + ' | ' + schedule.cadence : 'Not available'),parent);
    if (schedule && schedule.enabled && schedule.cron === '0 */6 * * *') {
      var observed = new Date(pinballmap.observed_at), next = new Date(observed);
      next.setUTCMinutes(0,0,0); next.setUTCHours(Math.floor(observed.getUTCHours()/6)*6+6);
      el('p','Next scheduled invocation: ' + date(next.toISOString()),parent);
      if (pinballmap.last_success && observed - new Date(pinballmap.last_success.finished_at) > 7*3600000) {
        el('p','Import may be overdue. No successful completion in more than seven hours.',parent);
      } else if (!pinballmap.last_success) el('p','No successful completion recorded yet.',parent);
    }
    if (latest && latest.error) el('p',latest.error,parent);
    if (latest && latest.result.warning) el('p',latest.result.warning,parent);
    if (latest && latest.status === 'failed' && latest.result.change_count) el('p','Some changes were committed before this import failed.',parent);
  }
  function pinballmapJobs(parent) {
    pinballmapSummary(parent);
    button('Run Now',parent,function () { mutate(async function () {
      var result = await window.snhSupabase.functions.invoke('pinballmap-ingest',{body:{}});
      if (result.error || !result.data || !result.data.ok) return {message:'Import did not report success. Refresh Jobs and check its outcome before retrying.'};
      return {message:result.data.imageSyncWarning ? 'Import completed with an image warning. See Jobs.' : 'Import completed. Information refreshed.'};
    },'Import the latest Pinball Map activity and machine details now?'); });
    if (!pinballmap) return;
    el('p','Latest ten runs. Older audit entries are not reconstructed. Times use your local timezone.',parent);
    var body = table(['Started / duration','Trigger','Outcome','Changes / details'],parent);
    pinballmap.runs.forEach(function (run) {
      var row = el('tr',null,body), c = cell(row,date(run.started_at));
      if (run.finished_at) el('p',Math.max(0,Math.round((new Date(run.finished_at)-new Date(run.started_at))/1000)) + ' seconds',c);
      cell(row,run.result.trigger === 'manual' ? 'Manual: ' + run.actor : 'Scheduled');
      c=cell(row,runOutcome(run));
      if (run.error) el('p',run.error,c);
      if (run.result.warning) el('p',run.result.warning,c);
      if (run.status==='failed' && run.result.change_count) el('p','Some changes committed before failure.',c);
      changes(run,cell(row));
    });
    if (!pinballmap.runs.length) el('p','No recorded import runs.',parent);
  }
  function render() {
    content.replaceChildren();
    tabs.querySelectorAll('button').forEach(function (b) { b.setAttribute('aria-pressed', b.dataset.section === current ? 'true' : 'false'); });
    document.getElementById('operations-audit').hidden = current !== 'audit';
    content.hidden = current === 'audit';
    if (current === 'audit') return;
    if (!snapshot) return;
    el('h3', current.charAt(0).toUpperCase() + current.slice(1), content);
    if (current === 'overview') {
      var cards = el('div', null, content); cards.className = 'operations-cards';
      var card = el('section', null, cards); el('h4', 'Integrations', card);
      Object.keys(names).forEach(function (p) { el('p', names[p] + ': ' + health(providerRows(p)), card); });
      card = el('section', null, cards); el('h4', 'Messaging', card);
      el('p', (snapshot.messages.pending || 0) + ' queued | ' + (snapshot.messages.sending || 0) + ' sending | ' + (snapshot.messages.failed || 0) + ' failed', card);
      card = el('section', null, cards); el('h4', 'Cache', card);
      el('p', snapshot.cache.total + ' resources | ' + snapshot.cache.expired + ' expired | ' + snapshot.cache.cleanup_eligible + ' eligible for cleanup', card);
      el('p', snapshot.integrations.filter(function (r) { return r.resource_type !== 'connection_test' && r.last_error_at && (!r.last_success_at || r.last_error_at >= r.last_success_at); }).length + ' resources with an unresolved request error', card);
      card = el('section', null, cards); el('h4', 'Jobs', card);
      ['notification_dispatch', 'cache_cleanup', 'pinballmap_ingest'].forEach(function (key) {
        var run = snapshot.jobs.find(function (j) { return j.job === key; });
        el('p', key.replace(/_/g, ' ') + ': ' + (run ? run.status + ' | ' + date(run.started_at) : 'No recorded run'), card);
      });
      button('View integrations', cards.children[0], function () { selectSection('integrations'); });
      button((snapshot.messages.failed || 0) + ' failed messages', cards.children[1], function () { selectSection('messaging', 'failed'); });
      button('View cache', cards.children[2], function () { selectSection('cache'); });
      button('View jobs', cards.children[3], function () { selectSection('jobs'); });
      el('p', 'Health reflects the latest recorded requests, not continuous monitoring.', content);
    }
    if (current === 'integrations') {
      if (!configuration) el('p', 'Configuration status unavailable. Deploy the Operations service and refresh.', content);
      Object.keys(names).forEach(function (p) {
        var section = el('section', null, content); section.className = 'operations-provider';
        el('h4', names[p], section);
        var config = configuration && configuration.providers.find(function (x) { return x.provider === p; });
        el('p', 'Configuration: ' + (!config || config.configured === null ? 'Unknown / not connected' : config.configured ? 'Configured' : 'Not configured') + ' | ' + health(providerRows(p)), section);
        if (config && config.note) el('p', config.note, section);
        if (p === 'pinballmap') {
          if (config) el('p','Worker scheduler credential: ' + (config.scheduler_configured ? 'Present' : 'Missing'),section);
          pinballmapSummary(section);
          if (pinballmap && pinballmap.last_change) {
            el('h5','Most recent changes: ' + date(pinballmap.last_change.started_at),section);
            if (pinballmap.last_change.status==='failed') el('p','These changes were retained from a failed import.',section);
            changes(pinballmap.last_change,section);
          } else el('p','No data changes recorded yet.',section);
          button('View import runs',section,function () { selectSection('jobs'); });
        }
        if (config && config.test_supported) button('Test Connection', section, function () { mutate(function () { return edge('test_matchplay'); }); });
        providerRows(p).forEach(function (r) {
          var details = el('dl', null, section);
          [['Resource',r.resource_type],['Last attempt',date(r.last_attempt_at)],['Last success',date(r.last_success_at)],
            ['Last error',date(r.last_error_at)],['Error summary',r.last_error || 'None'],['Latency',r.latency_ms == null ? 'Not recorded' : r.latency_ms + ' ms']]
            .forEach(function (pair) { el('dt',pair[0],details); el('dd',pair[1],details); });
        });
      });
    }
    if (current === 'cache') {
      el('p', 'Durations are in seconds (60 = 1 minute, 3600 = 1 hour). Changes apply to subsequent fetches; existing expiry times stay as recorded. Policies for future adapters are reserved until those adapters are connected.', content);
      el('p', 'The forced-refresh minimum prevents repeated refreshes after a recent successful fetch. Its default is 30 seconds.', content);
      var tbody = table(['Provider / resource', 'Default', 'Effective policy', 'Actions']);
      snapshot.policies.forEach(function (policy) {
        var row = el('tr', null, tbody);
        cell(row, (names[policy.provider] || policy.provider) + ' / ' + policy.policy.replace(/_/g,' '));
        if (policy.provider !== 'matchplay' || policy.policy === 'standings') el('small', 'Not used yet', row.children[0]);
        if (policy.policy === 'force_refresh_minimum' && policy.provider === 'matchplay') el('small', 'Used by forced refreshes; no refresh button is connected yet', row.children[0]);
        cell(row, duration(policy.default_seconds) + ' (' + policy.default_seconds + ' seconds)');
        var c = cell(row), input = el('input', null, c);
        input.type = 'number'; input.required = true; input.min = '1'; input.max = '604800'; input.step = '1'; input.value = policy.seconds;
        input.setAttribute('aria-label', policy.provider + ' ' + policy.policy + ' seconds');
        var readable = el('small', duration(policy.seconds), c);
        el('small', policy.overridden ? 'Database override' : 'Code default', c);
        var actions = cell(row);
        var save = button('Save', actions, function () {
          if (!input.reportValidity()) return;
          mutate(function () { return rpc('snh_operations_policy', { p_provider: policy.provider, p_policy: policy.policy, p_seconds: Number(input.value) }); });
        });
        var reset = button('Reset to Default', actions, function () {
          mutate(function () { return rpc('snh_operations_policy', { p_provider: policy.provider, p_policy: policy.policy, p_seconds: null }); }, 'Reset this policy to its code default?');
        });
        save.unavailable = function () { return Number(input.value) === policy.seconds || !input.checkValidity(); };
        reset.unavailable = function () { return !policy.overridden; };
        input.addEventListener('input', function () { readable.textContent = input.checkValidity() ? duration(Number(input.value)) : 'Enter a whole number from 1 to 604800'; setBusy(); });
      });
      el('p', snapshot.cache.cleanup_eligible + ' search resources expired more than seven days ago can be cleared. Event and result data is retained.', content);
      button('Clear expired search cache', content, function () {
        mutate(cleanup, 'Clear search cache that expired more than seven days ago?');
      });
    }
    if (current === 'messaging') {
      var label = el('label', 'Status ', content), select = el('select', null, label);
      ['', 'pending','sending','sent','failed','canceled'].forEach(function (s) { var option = el('option', s || 'All statuses', select); option.value = s; });
      select.value = filter; select.addEventListener('change', async function () {
        filter = select.value; cursor = null; route(); await loadMessages(false);
      });
      el('p', 'Retries keep the original recipient, content, message ID, and delivery deadline. Messages older than 23 hours or with a recorded delivery cannot be retried.', content);
      var body = table(['Recipient / message', 'Status / attempts', 'Timestamps', 'Error / action']);
      messages.forEach(function (m) {
        var row = el('tr', null, body); var c = cell(row,m.recipient_email); el('p',m.kind + ': ' + m.subject,c);
        cell(row,m.status + ' / ' + m.attempts);
        c = cell(row,'Created: ' + date(m.created_at)); el('p','Available: ' + date(m.available_at),c); el('p','Sent: ' + date(m.sent_at),c);
        c = cell(row,m.last_error || 'None');
        if (m.can_retry) button('Retry',c,function () { mutate(async function () { await rpc('snh_operations_retry',{p_id:m.id}); return {message:'Message queued for retry.'}; },'Queue this failed message for another delivery attempt?'); });
      });
      if (!messages.length) el('p','No messages match this status.',content);
      if (cursor) button('Load older messages',content,function () { loadMessages(true); });
    }
    if (current === 'jobs') {
      el('p','Schedules are managed by the existing scheduler. Import history starts when tracking was enabled.',content);
      var jobs = [{key:'notification_dispatch',name:'Notification dispatcher'},{key:'cache_cleanup',name:'Cache cleanup'},{key:'pintips_import',name:'PinTips import'},{key:'pinballmap_ingest',name:'Pinball Map ingest'}];
      snapshot.jobs.forEach(function (r) { if (!jobs.some(function (j) { return j.key === r.job; })) jobs.push({key:r.job,name:r.job}); });
      jobs.forEach(function (job) {
        var section = el('section',null,content); section.className='operations-provider'; el('h4',job.name,section);
        if (job.key==='pinballmap_ingest') { pinballmapJobs(section); return; }
        var run = snapshot.jobs.find(function (j) { return j.job === job.key; });
        el('p',run ? run.status + ' | Started ' + date(run.started_at) + ' | Finished ' + date(run.finished_at) : 'No recorded run',section);
        if (run) {
          if (job.key === 'cache_cleanup') el('p', run.status === 'succeeded' ? 'Removed ' + (run.result.removed || 0) + ' cache entries.' : 'No completed cleanup.', section);
          else if (job.key === 'notification_dispatch') {
            var result = run.result;
            el('p', result.mode === 'preview' ? 'Preview only. No messages sent.' : result.mode === 'test' ? 'Test mode. ' + (result.sent ? 'Sent to the configured test inbox.' : 'No test message sent.') : result.mode === 'live' ? (result.sent || 0) + ' sent, ' + (result.failed || 0) + ' failed, ' + (result.canceled || 0) + ' canceled.' : 'No delivery result recorded.', section);
          } else if (job.key === 'pintips_import' && run.status === 'succeeded') {
            var counts = run.result;
            el('p', counts.tips + ' tips; ' + counts.added + ' added, ' + counts.changed + ' changed, ' + counts.removed + ' removed.', section);
            el('p', counts.matched_games + ' games matched; ' + counts.missing_opdb_games + ' missing OPDB IDs; ' + counts.invalid_opdb_games + ' invalid IDs; ' + counts.games_without_tips + ' games without tips; ' + counts.unmatched_tip_groups + ' tip groups outside the catalog.', section);
          } if (run.error) el('p',run.error,section);
          if (run.status==='running') el('p','Completion has not been recorded. The worker may still be running or may have stopped.',section); }
        if (job.key==='cache_cleanup') button('Run Now',section,function () { mutate(cleanup,'Run cache cleanup for search resources expired more than seven days ago?'); });
        if (job.key==='notification_dispatch') {
          var dispatcher = configuration && configuration.dispatcher;
          el('p','Delivery mode: ' + (dispatcher ? dispatcher.mode : 'Unknown'),section);
          if (dispatcher && dispatcher.configured) button('Run Now',section,function () {
            mutate(function () { return edge('dispatch'); },'Run the notification dispatcher in ' + dispatcher.mode + ' mode? Live mode sends queued messages; test mode sends to the configured test inbox.');
          });
          else el('p','Manual dispatch is unavailable until the Operations service and dispatcher are configured.',section);
        }
      });
    }
    setBusy();
  }
  async function fetchMessages(append) {
    var rows = await rpc('snh_operations_messages',{p_status:filter || null,p_before:append && cursor ? cursor.created_at : null,p_before_id:append && cursor ? cursor.id : null});
    messages = append ? messages.concat(rows) : rows;
    cursor = rows.length === 50 ? rows[rows.length-1] : null;
  }
  async function loadMessages(append) {
    if (busy) return; busy=true; setBusy();
    try { await fetchMessages(append); render(); status.textContent='Messages refreshed.'; }
    catch (error) { status.textContent=error.message; }
    finally { busy=false; setBusy(); }
  }
  async function refresh() {
    if (current === 'audit') { render(); await window.SNHMemberAuditPanel.load(false); return; }
    snapshot = await rpc('snh_operations_snapshot');
    try { pinballmap = await rpc('snh_operations_pinballmap'); pinballmapError=''; }
    catch { pinballmap=null; pinballmapError='Pinball Map import information could not load. Check access and deployment, then refresh.'; }
    try { configuration = await edge('configuration'); } catch { configuration=null; }
    if (current==='messaging') await fetchMessages(false);
    render();
  }
  async function load() {
    if (!allowed || busy) return; route(); busy=true; setBusy(); status.textContent='Loading Operations...';
    try { await refresh(); status.textContent='Updated ' + new Date().toLocaleTimeString() + (configuration ? '' : '. Configuration service unavailable.'); }
    catch (error) { snapshot=null; content.replaceChildren(); status.textContent='Operations could not load: ' + (error.message || 'Check your administrator access and deployment.'); }
    finally { busy=false; setBusy(); }
  }
  function init(roles) {
    allowed=roles.indexOf('club_admin')!==-1;
    if (initialized || !allowed) return;
    root=document.getElementById('member-panel-operations'); if (!root) return;
    if (window.SNHMemberRoutes) current = window.SNHMemberRoutes.read().operationsSection || 'overview';
    if (window.location) { var candidate = new URLSearchParams(window.location.search).get('messageStatus'); if (['pending','sending','sent','failed','canceled'].indexOf(candidate) !== -1) filter=candidate; }
    initialized=true; content=document.getElementById('operations-content'); status=document.getElementById('operations-status');
    tabs=document.getElementById('operations-sections');
    ['overview','integrations','cache','messaging','jobs','audit'].forEach(function (section) {
      var b=button(section.charAt(0).toUpperCase()+section.slice(1),tabs,async function () {
        await selectSection(section);
      }); b.dataset.section=section; b.setAttribute('aria-controls','operations-content');
    });
    button('Refresh',document.getElementById('operations-refresh'),load);
  }
  window.SNHMemberOperationsPanel={init:init,load:load};
})();
