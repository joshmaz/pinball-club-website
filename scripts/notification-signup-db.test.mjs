// Use @electric-sql/pglite or set PGLITE_MODULE to its entrypoint.
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { createClient } from '@supabase/supabase-js';
const { PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite');
const db = new PGlite();
const migration = async name => db.exec(await readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8'));
const uid = n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const count = async () => Number((await db.query('select count(*) as n from notification_outbox')).rows[0].n);
try {
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth; create schema private;
    create function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid$$;
    create function auth.role() returns text language sql as $$select 'anon'::text$$;
    create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb default '{}');
    create table members (id uuid primary key default gen_random_uuid(), user_id uuid unique, email text, display_name text, first_name text, last_name text);
    create table member_roles (member_id uuid references members, role_slug text);
    create table external_accounts (id uuid primary key, member_id uuid, provider_slug text);
    create table audit_log (module text, action text, actor_user_id uuid, entity_type text, entity_id text, metadata jsonb);
    create function public.handle_new_user() returns trigger language plpgsql security definer set search_path = 'public', 'pg_temp' as $$
    begin
      insert into public.members (user_id, email, display_name) values (new.id, new.email, coalesce(new.raw_user_meta_data->>'display_name', new.email));
      return new;
    end; $$;
    create trigger on_auth_user_created after insert on auth.users for each row execute function handle_new_user();
  `);
  await migration('20260921122000_audit_member_profile_changes.sql');
  await migration('20260925010000_fix_member_profile_audit_signup.sql');
  await migration('20260924130000_notification_foundation.sql');
  await db.exec(`
    insert into members (id, user_id, email) values
      ('${uid(1)}', '${uid(101)}', 'admin@example.com'),
      ('${uid(2)}', '${uid(102)}', ' ADMIN@example.com '),
      ('${uid(3)}', '${uid(103)}', 'invalid'),
      ('${uid(4)}', '${uid(104)}', 'ordinary@example.com');
    insert into member_roles values ('${uid(1)}', 'club_admin'), ('${uid(1)}', 'membership_editor'), ('${uid(2)}', 'membership_admin'), ('${uid(3)}', 'membership_admin');
    insert into auth.users (id, email) values ('${uid(10)}', 'before@example.com');
  `);
  assert.equal(await count(), 0);
  console.log('Reproduced successful Auth signup with an empty notification queue.');
  await migration('20260925020000_queue_notifications_from_auth_signup.sql');
  await migration('20260928230000_canonical_effective_role_core.sql');
  await migration('20260928235800_notification_enqueue_authorization.sql');
  await migration('20261117233000_member_signup_email_template.sql');
  assert.equal(await count(), 0, 'No historical backfill');
  await db.exec(`insert into auth.users (id, email, raw_user_meta_data) values ('${uid(11)}', 'after@example.com', '{"display_name":"Test New Member"}')`);
  assert.equal(await count(), 1, 'One recipient after email and role deduplication');
  let row = (await db.query('select * from notification_outbox')).rows[0];
  assert.equal(row.recipient_email, 'admin@example.com');
  assert.equal(row.status, 'pending');
  assert.ok(row.body.includes('Test New Member'));
  assert.ok(row.body.includes('after@example.com'));
  assert.ok(row.body.includes('membership-management access'));
  assert.ok(row.body.includes('No action is needed.'));
  assert.deepEqual(row.template_variables, { NEW_USER_NAME: 'Test New Member', NEW_USER_EMAIL: 'after@example.com' });
  assert.ok(row.body.includes('\n\n'));
  await db.exec(`
    update members set display_name = 'Edited' where user_id = '${uid(11)}';
    insert into members (user_id, email) values ('${uid(12)}', 'import@example.com');
    select private.snh_enqueue_member_signup(m) from members m where user_id = '${uid(11)}';
  `);
  assert.equal(await count(), 1, 'Edits, imports and retries do not add messages');
  await db.exec(`set request.jwt.claim.sub = '${uid(13)}'; insert into members (user_id, email) values ('${uid(13)}', 'self@example.com')`);
  assert.equal(await count(), 2, 'Signed-in first-profile creation remains supported');
  await db.exec(`insert into members (user_id, email) values ('${uid(14)}', 'other@example.com')`);
  assert.equal(await count(), 2, 'Inserting another member does not queue an alert');
  // Both the member trigger and Auth function may run with an existing matching JWT.
  await db.exec(`set request.jwt.claim.sub = '${uid(15)}'; insert into auth.users (id, email) values ('${uid(15)}', 'both@example.com')`);
  assert.equal(await count(), 3, 'Both paths still queue only once');
  await db.exec(`set request.jwt.claim.sub = ''; delete from member_roles; insert into auth.users (id, email) values ('${uid(16)}', 'no-recipient@example.com')`);
  assert.equal(await count(), 3, 'No eligible recipients is harmless');
  const privileges = (await db.query(`select has_function_privilege('anon', 'private.snh_enqueue_member_signup(public.members)', 'EXECUTE') as anon, has_function_privilege('authenticated', 'private.snh_enqueue_member_signup(public.members)', 'EXECUTE') as authenticated`)).rows[0];
  assert.deepEqual(privileges, { anon: false, authenticated: false });

  // Explicit expectations, exercised through the real Auth trigger and canonical SQL.
  // This permissive fixture intentionally admits historical invalid assignments.
  const cases = [
    ['membership_editor', true], ['membership_admin', true], ['club_admin', true],
    ['events_editor', false], ['events_admin', false], ['games_editor', false],
    ['games_admin', false], ['photos_editor', false], ['photos_admin', false],
    ['website_volunteer', false], ['members_manager', false], ['unknown_role', false],
    [null, false],
  ];
  await db.exec('delete from notification_outbox');
  for (const [i, [role]] of cases.entries()) {
    await db.query('insert into members (id,user_id,email) values ($1,$2,$3)',
      [uid(200+i), uid(300+i), `recipient${i}@example.com`]);
    if (role) await db.query('insert into member_roles values ($1,$2)', [uid(200+i), role]);
  }
  // Duplicate qualifying assignments and a mixed invalid/valid assignment.
  await db.query('insert into member_roles values ($1,$2),($1,$3),($1,$4)',
    [uid(200), 'membership_editor', 'membership_editor', 'members_manager']);
  await db.exec(`insert into auth.users (id,email) values ('${uid(400)}','signup400@example.com')`);
  const queued = (await db.query('select * from notification_outbox order by recipient_email')).rows;
  assert.deepEqual(queued.map(r => r.recipient_email).sort(),
    cases.flatMap(([, eligible], i) => eligible ? [`recipient${i}@example.com`] : []).sort());
  assert.equal(queued.length, 3, 'Duplicate assignments do not multiply messages');
  const enqueueDefinition = (await db.query(`select pg_get_functiondef(
    'private.snh_enqueue_member_signup(public.members)'::regprocedure) as definition`)).rows[0].definition;
  assert.match(enqueueDefinition, /private\.snh_member_has_effective_role\(m.id, 'membership_editor'\)/);
  assert.doesNotMatch(enqueueDefinition, /membership_admin|club_admin/);
  for (const role of ['anon','authenticated','service_role']) {
    assert.equal((await db.query(`select has_function_privilege($1,
      'private.snh_member_has_effective_role(uuid,text)', 'EXECUTE') ok`, [role])).rows[0].ok, false);
  }
  await db.exec(`set role authenticated; set request.jwt.claim.sub = '${uid(301)}'`);
  assert.equal((await db.query("select public.snh_member_has_effective_role('membership_editor') ok")).rows[0].ok, true);
  assert.equal((await db.query("select public.snh_member_has_effective_role('games_editor') ok")).rows[0].ok, false);
  await db.exec("reset role; set request.jwt.claim.sub = ''");

  // Remove all qualifying roles AFTER enqueue. A later signup must queue nothing.
  await db.exec('delete from member_roles');
  await db.exec(`insert into auth.users (id,email) values ('${uid(401)}','signup401@example.com')`);
  assert.equal(await count(), 3, 'Role removal before the next event prevents new mail');

  // Use the deployed SQL for queue claims, budget, completion and backlog history.
  await db.exec(`
    alter table auth.users add column email_confirmed_at timestamptz,
      add column last_sign_in_at timestamptz;
    create schema cron;
    create function cron.schedule(text, text, text) returns bigint language sql as $$ select 1::bigint $$;
    -- The signup fixture uses imported recipients without corresponding Auth rows.
    create function private.snh_cancel_mismatched_notification_recipients() returns void
      language plpgsql as $$ begin end; $$;
  `);
  await migration('20260928150000_external_api_cache.sql');
  await migration('20260928160000_operations.sql');
  await migration('20261118000000_member_onboarding_emails.sql');
  await db.query("update notification_outbox set created_at=now()-interval '3 days', available_at=now()-interval '3 days', delivery_deadline_at=now()-interval '2 days' where id=$1", [queued[0].id]);
  await migration('20261127163333_notification_dispatch_readiness.sql');
  await migration('20261127171727_notification_backlog_singleton_updates.sql');
  await migration('20261127194807_notification_expiration_cleanup.sql');
  assert.equal((await db.query("select count(*)::int n from notification_outbox where delivery_deadline_at='infinity'")).rows[0].n, 3, 'Previously queued first attempts adopt the new policy');
  const source = await readFile(new URL('../supabase/functions/notification-dispatch/index.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /membership_editor|membership_admin|club_admin|member_roles/);
  const js = ts.transpileModule(source.replace(/^import .*;\n/gm, ''), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  }).outputText;
  const delivered = [], logs = [], accepted = new Map();
  let handler, clients = 0, failProvider = false, claimError = false, finishError = false;
  const env = { SUPABASE_URL: 'https://test.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'service-key',
    NOTIFICATION_DISPATCH_SECRET: 'dispatch-secret', NOTIFICATION_DELIVERY_MODE: 'live',
    RESEND_API_KEY: 'provider-key', NOTIFICATION_FROM: 'club@example.com' };
  const transport = async (input, init = {}) => {
    const url = new URL(input);
    if (url.hostname === 'api.resend.com') {
      const body = JSON.parse(init.body), key = init.headers['Idempotency-Key'];
      delivered.push({ body, key });
      if (failProvider) return Response.json({}, { status: 503 });
      if (accepted.has(key)) assert.deepEqual(body, accepted.get(key), 'A repeated key uses the same provider payload');
      else accepted.set(key, body);
      return Response.json({ id: 'provider-id' });
    }
    if (url.pathname === '/rest/v1/operations_job_runs') {
      logs.push(JSON.parse(init.body));
      return init.method === 'POST' ? Response.json({ id: uid(500) }) : new Response(null, { status: 204 });
    }
    assert.equal(init.headers.get('Authorization'), 'Bearer service-key');
    if (url.pathname === '/rest/v1/rpc/snh_expire_notification_jobs') {
      await db.exec('select public.snh_expire_notification_jobs()');
      return Response.json(null);
    }
    if (url.pathname === '/rest/v1/rpc/snh_claim_notification') {
      if (claimError) return Response.json({ message: 'claim failed' }, { status: 500 });
      return Response.json((await db.query('select * from public.snh_claim_notification()')).rows);
    }
    if (url.pathname === '/rest/v1/rpc/snh_notification_live_status') {
      return Response.json((await db.query('select public.snh_notification_live_status() status')).rows[0].status);
    }
    if (url.pathname === '/rest/v1/rpc/snh_observe_notification_backlog') {
      await db.exec('select public.snh_observe_notification_backlog()');
      return Response.json(null);
    }
    if (url.pathname === '/rest/v1/rpc/snh_finish_notification') {
      if (finishError) return Response.json(false);
      const p = JSON.parse(init.body);
      return Response.json((await db.query('select public.snh_finish_notification($1,$2,$3,$4,$5) ok',
        [p.p_id,p.p_lease_id,p.p_status,p.p_provider_id,p.p_error])).rows[0].ok);
    }
    throw new Error('Unexpected dispatcher operation: ' + url.pathname);
  };
  new Function('Deno', 'createClient', 'fetch', js)(
    { env: { get: key => env[key] }, serve: fn => { handler = fn; } },
    (url, key, options) => { clients++; return createClient(url, key, {
      ...options, global: { fetch: transport },
    }); }, transport);
  const dispatch = (secret = 'dispatch-secret', method = 'POST', scheduled = false) => handler(new Request('https://function.test', {
    method, headers: { 'x-notification-secret': secret, 'x-notification-scheduled': String(scheduled) },
  }));
  assert.equal((await dispatch('wrong')).status, 401);
  assert.equal((await dispatch('', 'GET')).status, 405);
  assert.equal(clients, 0, 'Service credentials stay behind dispatcher authentication');
  const result = await dispatch();
  assert.equal(result.status, 200);
  const sentResult = await result.json();
  assert.equal(sentResult.mode, 'live');
  assert.equal((await db.query("select count(*)::int n from notification_outbox where delivery_deadline_at between now()+interval '23 hours' and now()+interval '24 hours'")).rows[0].n, 3);
  assert.deepEqual({sent:sentResult.sent,canceled:sentResult.canceled,failed:sentResult.failed,limited:sentResult.limited},
    {sent:3,canceled:0,failed:0,limited:false});
  assert.deepEqual(sentResult.budget,{rolling_limit:100,per_run_limit:10,sent_last_24h:3,in_flight:0,used:3,remaining:97,eligible_pending:0,waiting_pending:0,expired_pending:0,pending_count:0,oldest_pending_age_seconds:null,backlog_status:'clear'});
  assert.deepEqual(delivered.map(d => d.body.to[0]).sort(), queued.map(q => q.recipient_email).sort());
  for (const message of queued) {
    const delivery = delivered.find(d => d.key === message.id);
    assert.equal(delivery.body.template.id, 'snhpc-member-signup-alert-v1');
    assert.equal(delivery.body.template.variables.SUBJECT_PREFIX, '');
    assert.equal(delivery.body.template.variables.PREVIEW_BANNER, '');
    assert.equal(delivery.body.template.variables.NEW_USER_NAME, message.template_variables.NEW_USER_NAME);
    assert.equal(delivery.body.template.variables.NEW_USER_EMAIL, message.template_variables.NEW_USER_EMAIL);
    assert.equal(delivery.body.template.variables.NEW_USER_NAME_HTML, message.template_variables.NEW_USER_NAME);
    assert.equal(delivery.body.template.variables.NEW_USER_EMAIL_HTML, message.template_variables.NEW_USER_EMAIL);
  }
  const finished = (await db.query('select * from notification_outbox')).rows;
  assert.ok(finished.every(r => r.status === 'sent' && r.lease_id === null && r.attempts === 1 && r.provider_id === 'provider-id'));
  assert.equal((await dispatch()).status, 200);
  assert.equal(delivered.length, 3, 'Sent messages are not claimed twice');
  assert.ok(logs.filter(r => r.finished_at).every(r => !JSON.stringify(r).includes('signup400@example.com')));
  claimError = true;
  assert.equal((await dispatch()).status, 500);
  assert.equal(delivered.length, 3, 'Claim errors cannot send mail');
  claimError = false;
  // Switch to the staging transport for retries and the scheduled queue workload.
  env.SUPABASE_URL = 'https://eptbdrwmcwogxcjleudv.supabase.co';
  env.NOTIFICATION_DELIVERY_MODE = 'queue_test';
  env.NOTIFICATION_TEST_EMAIL = '  queue-tests+staging@example.com  ';
  const stagingAttemptStart = delivered.length;
  const testKey = 'staging-queue-test/' + queued[0].id;
  const scheduledDispatch = () => dispatch('dispatch-secret', 'POST', true);
  // Delivery failure still uses the production retry state transition.
  await db.query("update notification_outbox set status='pending',attempts=0,delivery_deadline_at='infinity' where id=$1", [queued[0].id]);
  failProvider = true;
  const failedResult = await (await dispatch()).json();
  assert.equal(failedResult.mode, 'queue_test'); assert.equal(failedResult.sent, 0);
  assert.equal(failedResult.canceled, 0); assert.equal(failedResult.failed, 1);
  const retry = (await db.query('select * from notification_outbox where id=$1', [queued[0].id])).rows[0];
  assert.equal(retry.status, 'pending');
  assert.equal(retry.last_error, 'Resend HTTP 503');
  assert.equal(retry.lease_id, null);
  assert.ok(Date.parse(retry.delivery_deadline_at) > Date.now() + 23*60*60*1000);
  failProvider = false;
  await db.query('update notification_outbox set available_at=now() where id=$1', [queued[0].id]);
  finishError = true;
  assert.equal((await dispatch()).status, 500, 'A lost lease/completion failure is not reported as success');
  const reclaimed = (await db.query('select status,delivery_deadline_at from notification_outbox where id=$1', [queued[0].id])).rows[0];
  assert.equal(reclaimed.status, 'sending');
  assert.deepEqual(reclaimed.delivery_deadline_at, retry.delivery_deadline_at);
  finishError = false;
  await db.query('update notification_outbox set locked_until=now() where id=$1', [queued[0].id]);
  const acceptedBeforeRetry = accepted.size;
  assert.equal((await (await scheduledDispatch()).json()).sent, 1);
  assert.equal(accepted.size, acceptedBeforeRetry, 'A replay after provider acceptance reuses the accepted send');
  assert.deepEqual(delivered.slice(stagingAttemptStart).map(d => d.key), [testKey, testKey, testKey]);
  const recoveredSend = (await db.query('select * from notification_outbox where id=$1', [queued[0].id])).rows[0];
  assert.equal(recoveredSend.status, 'sent');
  assert.equal(recoveredSend.provider_id, 'provider-id');
  assert.equal(recoveredSend.recipient_email, queued[0].recipient_email);
  await db.exec(`delete from notification_outbox;
    insert into notification_outbox (event_key,kind,recipient_member_id,recipient_email,subject,body,status,sent_at)
    select 'sent-'||i,'member_signup','${uid(1)}','admin@example.com','subject','message','sent',now()
    from generate_series(1,89) i;
    insert into notification_outbox (event_key,kind,recipient_member_id,recipient_email,subject,body)
    select 'pending-'||i,'member_signup','${uid(1)}','admin@example.com','subject','message'
    from generate_series(1,13) i;`);
  const health = async () => (await db.query('select public.snh_notification_live_status() health')).rows[0].health;
  const incident = async () => (await db.query('select * from private.notification_backlog_state')).rows[0];
  const priorIncident = await incident();
  assert.equal((await (await scheduledDispatch()).json()).sent, 10);
  assert.equal((await health()).pending_count, 3);
  assert.equal((await health()).backlog_status, 'clear', 'Batch size alone does not create a backlog');
  assert.deepEqual(await incident(), priorIncident);
  assert.equal((await (await dispatch()).json()).sent, 1);
  assert.equal((await health()).backlog_status, 'daily_limit');
  assert.equal((await incident()).peak_depth, 2);
  await db.exec("update notification_outbox set created_at=now()-interval '3 days', available_at=now()-interval '3 days' where status='pending'");
  assert.equal((await (await dispatch()).json()).sent, 0);
  assert.equal((await db.query("select count(*)::int n from notification_outbox where status='pending' and attempts=0 and lease_id is null")).rows[0].n, 2);
  assert.equal((await db.query('select * from public.snh_claim_notification()')).rows.length, 0, 'Database enforces the cap independently');

  await db.exec(`insert into notification_outbox (event_key,kind,recipient_member_id,recipient_email,subject,body)
    values ('extra','member_signup','${uid(1)}','admin@example.com','subject','message');`);
  await dispatch();
  assert.equal((await incident()).peak_depth, 3);
  await db.exec("update notification_outbox set sent_at=now()-interval '24 hours' where event_key in ('sent-1','sent-2','sent-3')");
  assert.equal((await (await dispatch()).json()).sent, 3);
  assert.equal((await health()).pending_count, 0);
  const recovered = await incident();
  assert.equal(recovered.active, false);
  assert.ok(recovered.last_detected_at && recovered.last_cleared_at);
  assert.equal(recovered.peak_depth, 3);

  // The cap includes in-flight reservations, while the displayed send volume does not.
  await db.exec(`update notification_outbox set status='sending',sent_at=null, locked_until=now()+interval '5 minutes',
      lease_id=gen_random_uuid(),delivery_deadline_at=now()-interval '1 minute' where event_key='sent-4';
    insert into notification_outbox (event_key,kind,recipient_member_id,recipient_email,subject,body,available_at,delivery_deadline_at)
    values ('expired','member_signup','${uid(1)}','admin@example.com','subject','message',now()-interval '25 hours',now()-interval '1 minute'),
           ('delayed','member_signup','${uid(1)}','admin@example.com','subject','message',now()-interval '30 minutes',now()+interval '1 hour'),
           ('scheduled','member_signup','${uid(1)}','admin@example.com','subject','message',now()+interval '1 hour',now()+interval '25 hours'),
           ('irrelevant-reminder','member_confirmation_reminder','${uid(1)}','admin@example.com','subject','message',now()-interval '25 hours',now()-interval '1 hour');
    update notification_outbox set attempts=1 where event_key='expired';`);
  assert.equal((await health()).remaining, 0);
  assert.equal((await health()).sent_last_24h, 99);
  assert.equal((await health()).backlog_status, 'delayed');
  const fullRun = await (await scheduledDispatch()).json();
  assert.equal(fullRun.sent, 0);
  assert.equal(fullRun.limited, true);
  assert.equal(fullRun.budget.expired_pending, 1, 'The expired row with an active lease stays untouched');
  assert.deepEqual((await db.query("select event_key,status from notification_outbox where event_key in ('expired','irrelevant-reminder') order by event_key")).rows,
    [{event_key:'expired',status:'failed'},{event_key:'irrelevant-reminder',status:'failed'}]);
  assert.equal((await db.query('select * from public.snh_claim_notification()')).rows.length, 0);
  await db.exec("update notification_outbox set sent_at=now()-interval '25 hours' where event_key='sent-5'");
  assert.equal((await (await dispatch()).json()).sent, 1);
  assert.deepEqual((await db.query("select event_key,status,last_error from notification_outbox where event_key in ('delayed','expired','irrelevant-reminder','scheduled','sent-4') order by event_key")).rows, [
    {event_key:'delayed',status:'sent',last_error:null},
    {event_key:'expired',status:'failed',last_error:'Delivery retry window expired'},
    {event_key:'irrelevant-reminder',status:'failed',last_error:'Notification relevance window expired'},
    {event_key:'scheduled',status:'pending',last_error:null},
    {event_key:'sent-4',status:'sending',last_error:null},
  ]);
  assert.equal((await health()).backlog_status, 'clear');
  assert.ok(delivered.slice(stagingAttemptStart).every(d =>
    d.body.to.length === 1 && d.body.to[0] === 'queue-tests+staging@example.com' && !d.body.cc && !d.body.bcc));
  assert.ok(logs.some(r => r.result?.mode === 'queue_test' && r.result.sent === 10));

  await db.exec(`insert into member_roles values ('${uid(1)}','club_admin');
    insert into operations_job_runs (job,status,started_at,finished_at,result) values
      ('notification_dispatch','succeeded',now()-interval '32 minutes',now()-interval '31 minutes','{"mode":"preview"}'),
      ('notification_dispatch','failed',now()-interval '2 minutes',now()-interval '1 minute','{"mode":"preview"}');
    set role authenticated; set request.jwt.claim.sub='${uid(101)}';`);
  const overview = async () => (await db.query('select public.snh_operations_snapshot() snapshot')).rows[0].snapshot.notification_health;
  assert.equal((await overview()).dispatcher_stale, true, 'A newer failure cannot hide a stopped dispatcher');
  assert.equal((await overview()).last_successful_run_mode, 'preview');
  assert.ok((await overview()).last_backlog_cleared_at);
  await assert.rejects(db.query('select public.snh_observe_notification_backlog()'), /permission denied/);
  await assert.rejects(db.query('select public.snh_expire_notification_jobs()'), /permission denied/);
  await db.exec(`reset role;
    insert into operations_job_runs (job,status,finished_at,result) values ('notification_dispatch','succeeded',now(),'{"mode":"test"}');
    set role authenticated;`);
  assert.equal((await overview()).dispatcher_stale, false);
  assert.equal((await overview()).last_successful_run_mode, 'test');
  await db.exec('reset role');
  console.log('PASS: real Auth trigger path without JWT, audit coexistence, recipient filtering, deduplication, profile edits, imports, no backfill, signed-in fallback, helper permissions, enqueue-only authorization, post-revocation delivery, and dispatch retry boundaries.');
} finally { await db.close(); }
