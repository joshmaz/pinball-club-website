// Use @electric-sql/pglite or set PGLITE_MODULE to its entrypoint.
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
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
  console.log('PASS: real Auth trigger path without JWT, audit coexistence, recipient filtering, deduplication, profile edits, imports, no backfill, signed-in fallback, and helper permissions.');
} finally { await db.close(); }
