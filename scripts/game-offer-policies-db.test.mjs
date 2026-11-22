// Exercise the forward migration against the deployed authorization chain.
// All accounts are disposable; no network or hosted database is used.
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const { PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite');
const db = new PGlite();
const uid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const query = async (sql, params = []) => (await db.query(sql, params)).rows;
const migration = async name => db.exec(await readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8'));
const oldRoles = ['club_admin', 'membership_editor', 'membership_admin', 'events_editor',
  'events_admin', 'photos_editor', 'photos_admin', 'games_editor', 'games_admin'];
const actor = async n => {
  await db.exec('reset role; set role authenticated');
  await query("select set_config('request.jwt.claim.sub',$1,false)", [uid(100 + n)]);
};
const grant = (n, role) => query('select public.snh_grant_member_role($1,$2)', [uid(n), role]);
const revoke = (n, role) => query('select public.snh_revoke_member_role($1,$2)', [uid(n), role]);
const denied = error => error.code === '42501';
try {
  await db.exec(`create role anon; create role authenticated; create role service_role;
    create schema auth; create schema private;
    create table auth.users(id uuid primary key,email_confirmed_at timestamptz,
      deleted_at timestamptz, banned_until timestamptz, is_anonymous boolean not null default false);
    create function auth.uid() returns uuid language sql as $$
      select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    create function auth.role() returns text language sql as $$ select current_user::text $$;
    create table public.members(id uuid primary key,user_id uuid,email text,display_name text,
      first_name text,last_name text,stern_insider_username text,club_designation text);
    create table public.memberships(id uuid primary key default gen_random_uuid(),member_id uuid,
      status text,tier text,end_date date,created_at timestamptz default now());
    create table public.external_accounts(member_id uuid,provider_slug text,account_handle text);
    create table public.audit_log(id uuid primary key default gen_random_uuid(),module text,action text,
      actor_user_id uuid,entity_type text,entity_id text,old_data jsonb,new_data jsonb,metadata jsonb);
    create schema cron;
    create table cron.jobs (command text);
    create function cron.schedule(text,text,text) returns bigint language sql as $$
      insert into cron.jobs values ($3) returning 1::bigint $$;
    alter table public.audit_log add foreign key(actor_user_id) references auth.users(id);
    create table public.games(id uuid primary key, deleted_at timestamptz, deleted_by uuid references auth.users(id));
    create table public.game_high_scores(created_by uuid references auth.users(id));
    create table public.game_custom_mods(created_by uuid references auth.users(id));
    create table public.club_issues(created_by uuid references auth.users(id));
    create table public.notification_outbox(kind text, event_key text, body text, status text,
      lease_id uuid, locked_until timestamptz);
    create table public.owner_parties(id uuid primary key);
    grant usage on schema auth to authenticated;
    grant select on public.members to authenticated;
    alter table public.members enable row level security;
    create policy own_member on public.members for select to authenticated using(user_id=auth.uid());`);
  for (const name of [
  '20260423190000_create_member_roles.sql',
  '20260423203000_member_admin_rpcs.sql',
  '20260427201536_member_role_slug_allowlist.sql',
  '20260427202201_membership_role_manager_access.sql',
  '20260508153118_manual_membership_admin_rpcs.sql',
  '20260921140000_member_role_scope.sql',
  '20260921150000_membership_door_access.sql',
  '20260928200000_membership_role_delegation.sql',
  '20260928220000_canonical_persisted_member_roles.sql',
  '20260928230000_canonical_effective_role_core.sql',
  '20260928235000_domain_helpers_use_effective_roles.sql',
  '20260928235800_notification_enqueue_authorization.sql',
  '20260921121000_audit_member_admin_changes.sql',
  '20261014180000_account_deletion.sql',
  '20261016120000_require_verified_access_grants.sql',
  '20261017180000_publishing_role_domain.sql',
  '20261122225245_game_rotation_cabinets_and_loans.sql',
  '20261122225737_game_offer_policies.sql',
  '20261122233621_game_rotation_plans.sql',
  '20261122235352_game_rotation_confirm_moves.sql'
]) await migration(name);
  for (let n = 1; n <= 14; n++) {
    await query('insert into auth.users (id,email_confirmed_at) values ($1,$2)', [uid(100+n), n === 14 ? null : new Date()]);
    await query('insert into public.members(id,user_id) values ($1,$2)', [uid(n),uid(100+n)]);
  }
  for (const [index, role] of oldRoles.entries()) {
    await query('insert into public.member_roles(member_id,role_slug) values ($1,$2)', [uid(index+1), role]);
  }
  await query("update public.members set club_designation = 'board' where id = $1", [uid(11)]);
  await query("update auth.users set banned_until = now() + interval '1 day' where id = $1", [uid(113)]);
  const save = (id = null) => query('select public.snh_save_game_offer($1,null,$2,$3,null,null,null) id',
    [id, 'Example', 'Private condition']);
  const review = id => query("select public.snh_review_game_offer($1,'publish','Approved title','Summary','Private note')", [id]);
  const published = () => query('select * from public.snh_published_game_offers()');

  await actor(1);
  await grant(10, 'game_coordinator');
  await revoke(10, 'game_coordinator');
  await actor(3);
  await grant(10, 'game_coordinator');
  await assert.rejects(grant(14, 'game_coordinator'), denied);
  await actor(11);
  await assert.rejects(grant(12, 'game_coordinator'), denied);
  await assert.rejects(revoke(10, 'game_coordinator'), denied);
  await actor(10);
  assert.deepEqual(await query(`select public.snh_member_has_effective_role('game_coordinator') as coordinator,
    public.snh_member_has_effective_role('games_editor') as editor`), [{ coordinator: true, editor: false }]);
  for (const n of [13, 14, 99]) {
    await actor(n);
    await assert.rejects(save(), denied);
  }

  await db.exec('reset role');
  await query('alter table public.games add column title text');
  await query("insert into public.games (id,title) values ($1,'Example')", [uid(200)]);
  const register = label => query('select public.snh_register_game_cabinet($1,$2) id', [uid(200), label]);
  const savePlan = (id, incoming, outgoing, note) => query(
    'select public.snh_save_rotation_plan($1,$2,$3,null,null,$4) id', [id,incoming,outgoing,note]);
  const workspace = () => query('select public.snh_rotation_workspace() workspace');
  const cancel = id => query('select public.snh_cancel_rotation_plan($1)', [id]);
  await actor(12);
  await assert.rejects(workspace(), denied);
  await actor(10);
  const [{id: incoming}] = await register('First cabinet');
  const [{id: outgoing}] = await register('Second cabinet');
  assert.notEqual(incoming, outgoing);
  assert.deepEqual(await register(' first cabinet '), [{id:incoming}]);
  await assert.rejects(savePlan(null,incoming,incoming,null), {code:'23514'});
  const [{id: plan}] = await savePlan(null,incoming,outgoing,'Private planning note');
  await assert.rejects(savePlan(null,incoming,null,null), {code:'23505'});
  await savePlan(plan,incoming,outgoing,'Edited private note');
  await actor(11);
  assert.equal((await workspace())[0].workspace.plans[0].note,'Edited private note');
  await assert.rejects(register('Unauthorized'), denied);
  await assert.rejects(savePlan(plan,incoming,outgoing,null), denied);
  await assert.rejects(cancel(plan), denied);
  await actor(1);
  await cancel(plan);
  await cancel(plan);
  const [{id: replacement}] = await savePlan(null,incoming,null,null);
  const [{workspace: rotation}] = await workspace();
  assert.equal(rotation.plans[0].id,replacement);
  assert.equal(rotation.plans[0].arrival_on,null);
  assert.ok(rotation.plans[1].canceled_at);
  await db.exec('reset role');
  const confirm = (planId, direction, cabinet, placement = null) => query(
    "select public.snh_confirm_rotation_move($1,$2,null,$3,$4,$5) id",
    [planId,direction,direction === 'arrival' ? 'Club floor' : null,cabinet,placement]);
  const history = () => query('select * from public.snh_cabinet_placement_history()');
  const correct = (placement, reason) => query(
    'select public.snh_correct_cabinet_placement($1,$2,$3,null,$4)',
    [placement,'Back room','2026-11-01',reason]);
  await actor(11);
  await assert.rejects(confirm(replacement,'arrival',incoming), denied);
  await actor(10);
  await assert.rejects(confirm(replacement,'arrival',outgoing), {code:'22023'});
  const [{id:placement}] = await confirm(replacement,'arrival',incoming);
  assert.deepEqual(await confirm(replacement,'arrival',incoming), [{id:placement}]);
  await assert.rejects(savePlan(replacement,outgoing,null,null), {code:'22023'});
  await assert.rejects(cancel(replacement), {code:'22023'});
  await assert.rejects(correct(placement,'Correction'), denied);
  assert.equal((await history())[0].arrived_on,null);

  const [{id: swap}] = await savePlan(null,outgoing,incoming,'Swap');
  await assert.rejects(confirm(swap,'departure',incoming,uid(999)), {code:'22023'});
  await actor(1);
  await confirm(swap,'departure',incoming,placement);
  await cancel(swap);
  assert.deepEqual(await confirm(swap,'departure',incoming,placement), [{id:placement}]);
  await assert.rejects(confirm(swap,'arrival',outgoing), {code:'22023'});
  await actor(11);
  assert.ok((await history())[0].departure_confirmed_at);
  assert.equal((await history())[0].departed_on,null);
  await assert.rejects(correct(placement,'Correction'), denied);
  await actor(8);
  await assert.rejects(history(), denied);
  await assert.rejects(correct(placement,'Correction'), denied);
  await actor(9);
  await assert.rejects(workspace(), denied);
  await assert.rejects(correct(placement,''), {code:'22023'});
  await correct(placement,'Verified against floor log');
  assert.equal((await history())[0].location,'Back room');
  assert.ok((await history())[0].departure_confirmed_at);

  await db.exec('reset role');
  assert.deepEqual(await query("select action from public.audit_log where entity_type='game_cabinet_placement' and entity_id=$1 order by action", [placement]),
    [{action:'confirm_arrival'},{action:'confirm_departure'},{action:'correct'}]);
  assert.deepEqual(await query('select * from private.game_loans'), []);
  assert.deepEqual(await query("select action from public.audit_log where entity_type='game_rotation_plan' and entity_id=$1 and action='cancel'", [plan]), [{action:'cancel'}]);

  await actor(12);
  const [{id}] = await save();
  assert.equal((await query('select * from public.snh_my_game_offers()')).length, 1);
  assert.deepEqual(await published(), []);
  await actor(8);
  assert.deepEqual(await query('select * from public.snh_rotation_game_offers()'), []);
  await assert.rejects(save(id), denied);
  await assert.rejects(review(id), denied);
  await actor(11);
  assert.equal((await query('select * from public.snh_rotation_game_offers()')).length, 1);
  await assert.rejects(review(id), denied);
  await actor(10);
  await review(id);
  await actor(12);
  await save(id);
  assert.deepEqual(await published(), []);
  await actor(10);
  await review(id);
  await actor(12);
  assert.deepEqual(await published(), [{id, title: 'Approved title', summary: 'Summary', interested: false}]);
  await query('select public.snh_set_game_offer_interest($1,true)', [id]);
  await query('select public.snh_set_game_offer_interest($1,true)', [id]);
  assert.equal((await published())[0].interested, true);

  await db.exec('reset role');
  await query('insert into public.games (id) values ($1)', [uid(201)]);
  await query('insert into public.owner_parties values ($1)', [uid(202)]);
  await query("insert into private.game_cabinets (id,game_id,label) values ($1,$2,'Cabinet')", [uid(203), uid(201)]);
  await query(`insert into private.game_loans (cabinet_id,lender_party_id,lender_user_id,terms)
    values ($1,$2,$3,'Private terms')`, [uid(203), uid(202), uid(112)]);
  const remove = () => query('delete from auth.users where id = $1', [uid(112)]);
  await assert.rejects(remove(), denied);
  assert.equal((await query('select published_title from private.game_offers where id=$1',[id]))[0].published_title,
    'Approved title');
  const [{receipt}] = await query("select public.snh_prepare_account_deletion($1,null,'Self-service deletion') receipt", [uid(112)]);
  await query('select public.snh_activate_account_deletion($1,$2)', [receipt, uid(112)]);
  await remove();
  assert.deepEqual(await query('select submitter_user_id,published_title,close_reason from private.game_offers where id=$1',[id]),
    [{submitter_user_id:null,published_title:null,close_reason:'account_deleted'}]);
  assert.deepEqual(await query('select user_id from private.game_offer_interest'), []);
  assert.deepEqual(await query(`select lender_user_id,return_follow_up,closed_at,terms,cabinet_id,lender_party_id
    from private.game_loans`), [{lender_user_id:null,return_follow_up:true,closed_at:null,terms:null,
    cabinet_id:uid(203),lender_party_id:uid(202)}]);
  await actor(12);
  await assert.rejects(save(), denied);

  await db.exec('reset role');
  assert.deepEqual(await query('select condition,coordinator_note from private.game_offers where id=$1',[id]),
    [{condition:null,coordinator_note:null}]);
  await query(`insert into private.game_offers (title,closed_at,close_reason,preservation_required) values
    ('Expired',now()-interval '12 months','withdrawn',false),
    ('Preserved',now()-interval '12 months','declined',true),
    ('Recent',now()-interval '1 month','declined',false)`);
  const [{command}] = await query("select command from cron.jobs where command like '%private.game_offers%'");
  await db.exec(command);
  assert.deepEqual(await query('select title from private.game_offers order by title'),
    [{title:'Offer from deleted account'},{title:'Preserved'},{title:'Recent'}]);
} finally {
  await db.close();
}
