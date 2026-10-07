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
  assert.equal(await count(), 0, 'No historical backfill');
  await db.exec(`insert into auth.users (id, email, raw_user_meta_data) values ('${uid(11)}', 'after@example.com', '{"display_name":"Test New Member"}')`);
  assert.equal(await count(), 1, 'One recipient after email and role deduplication');
  let row = (await db.query('select * from notification_outbox')).rows[0];
  assert.equal(row.recipient_email, 'admin@example.com');
  assert.equal(row.status, 'pending');
  assert.ok(row.body.includes('Test New Member'));
  assert.ok(row.body.includes('after@example.com'));
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

  // Load the current production claim function without unrelated Operations schema.
  await db.exec('alter table notification_outbox add column manual_retry_allowance boolean not null default false');
  const operations = await readFile(new URL('../supabase/migrations/20260928160000_operations.sql', import.meta.url), 'utf8');
  await db.exec(operations.match(/create or replace function public\.snh_claim_notification\(\)[\s\S]*?end; \$\$;/)[0]);
  const source = await readFile(new URL('../supabase/functions/notification-dispatch/index.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /membership_editor|membership_admin|club_admin|member_roles/);
  const js = ts.transpileModule(source.replace(/^import .*;\n/gm, ''), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  }).outputText;
  const delivered = [], logs = [];
  let handler, clients = 0, failProvider = false, claimError = false, finishError = false;
  const env = { SUPABASE_URL: 'https://test.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'service-key',
    NOTIFICATION_DISPATCH_SECRET: 'dispatch-secret', NOTIFICATION_DELIVERY_MODE: 'live',
    RESEND_API_KEY: 'provider-key', NOTIFICATION_FROM: 'club@example.com' };
  const transport = async (input, init = {}) => {
    const url = new URL(input);
    if (url.hostname === 'api.resend.com') {
      delivered.push({ body: JSON.parse(init.body), key: init.headers['Idempotency-Key'] });
      return failProvider ? Response.json({}, { status: 503 }) : Response.json({ id: 'provider-id' });
    }
    if (url.pathname === '/rest/v1/operations_job_runs') {
      logs.push(JSON.parse(init.body));
      return init.method === 'POST' ? Response.json({ id: uid(500) }) : new Response(null, { status: 204 });
    }
    assert.equal(init.headers.get('Authorization'), 'Bearer service-key');
    if (url.pathname === '/rest/v1/rpc/snh_claim_notification') {
      if (claimError) return Response.json({ message: 'claim failed' }, { status: 500 });
      return Response.json((await db.query('select * from public.snh_claim_notification()')).rows);
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
  const dispatch = (secret = 'dispatch-secret', method = 'POST') => handler(new Request('https://function.test', {
    method, headers: { 'x-notification-secret': secret },
  }));
  assert.equal((await dispatch('wrong')).status, 401);
  assert.equal((await dispatch('', 'GET')).status, 405);
  assert.equal(clients, 0, 'Service credentials stay behind dispatcher authentication');
  const result = await dispatch();
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), { mode: 'live', sent: 3, canceled: 0, failed: 0 });
  assert.deepEqual(delivered.map(d => d.body.to[0]).sort(), queued.map(q => q.recipient_email).sort());
  for (const message of queued) {
    const delivery = delivered.find(d => d.key === message.id);
    assert.equal(delivery.body.subject, message.subject);
    assert.equal(delivery.body.text, message.body);
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
  // Delivery failure still uses the production retry state transition.
  await db.query("update notification_outbox set status='pending',attempts=0 where id=$1", [queued[0].id]);
  failProvider = true;
  assert.deepEqual(await (await dispatch()).json(), { mode: 'live', sent: 0, canceled: 0, failed: 1 });
  const retry = (await db.query('select * from notification_outbox where id=$1', [queued[0].id])).rows[0];
  assert.equal(retry.status, 'pending');
  assert.equal(retry.last_error, 'Resend HTTP 503');
  assert.equal(retry.lease_id, null);
  failProvider = false;
  await db.query('update notification_outbox set available_at=now() where id=$1', [queued[0].id]);
  finishError = true;
  assert.equal((await dispatch()).status, 500, 'A lost lease/completion failure is not reported as success');
  assert.equal((await db.query('select status from notification_outbox where id=$1', [queued[0].id])).rows[0].status, 'sending');
  console.log('PASS: real Auth trigger path without JWT, audit coexistence, recipient filtering, deduplication, profile edits, imports, no backfill, signed-in fallback, helper permissions, enqueue-only authorization, post-revocation delivery, and dispatch retry boundaries.');
} finally { await db.close(); }
