import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
const read = name => readFile(new URL('../supabase/migrations/' + name, import.meta.url), 'utf8');
const migration = await read('20261026151512_game_card_profiles.sql');
const uid = n => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;

test('gallery and public issues expose approved curated data; existing member/helper permissions remain', async () => {
  const db = new PGlite();
  const value = async (sql, args = []) => (await db.query(sql, args)).rows[0]?.value;
  const as = async (n, role='authenticated') => db.exec(`reset role; set role ${role}; set request.jwt.claim.sub='${n ? uid(n) : ''}'`);
  const upsert = (id, fields) => value('select snh_club_issues_upsert($1,$2) value',[id,JSON.stringify(fields)]);
  const publicIssues = id => value('select snh_public_game_issues($1) value',[id]);
  const images = id => value('select snh_public_game_images($1) value',[id]);
  try {
    await db.exec(`create role anon; create role authenticated; create schema auth; create schema private;
      create function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      create table auth.users(id uuid primary key);
      create function public.snh_account_exists() returns boolean language sql stable security definer set search_path='' as $$select auth.uid() is not null and exists(select 1 from auth.users where id=auth.uid())$$;
      create table games(id uuid primary key, title text, slug text, deleted_at timestamptz, opdb_id text, display_type text);
      create table members(id uuid primary key, user_id uuid, display_name text, first_name text, last_name text);
      create table member_roles(member_id uuid, role_slug text);
      create table club_issues(id uuid primary key default gen_random_uuid(),game_id uuid,title text,body text,
        status text check(status in ('open','in_progress','resolved')),created_by uuid,submission_origin text,
        submitted_at timestamptz default now(),created_at timestamptz default now(),updated_at timestamptz default now());
      create table game_images(id uuid primary key,game_id uuid,location_type text,location_value text,source_type text,
        image_type text,alt_text text,source_url text,attribution_text text,attribution_url text,license_name text,
        license_url text,metadata jsonb default '{}',is_primary boolean default false,usage_status text,created_at timestamptz default now());
      create table audit_log(action text,entity_type text,entity_id text,old_data jsonb,new_data jsonb,metadata jsonb);
      create function private.snh_audit_game(text,text,text,jsonb,jsonb,jsonb) returns void language sql as
        $$insert into audit_log values($1,$2,$3,$4,$5,$6)$$;
      insert into games(id,title,slug) values('${uid(1)}','Machine','machine'),('${uid(2)}','Other','other');
      insert into auth.users values('${uid(10)}');
      insert into members values('${uid(10)}','${uid(10)}','PRIVATE REPORTER','Private','Name');
    `);
    const helper=await read('20260510120000_club_issues_any_named_role.sql');
    await db.exec(helper.slice(helper.indexOf('create or replace function'),helper.indexOf('create or replace function public.snh_club_issues_upsert')));
    const old=await read('20260507143000_extended_game_data.sql');
    const start=old.indexOf('create or replace function private.snh_require_game_editable');
    await db.exec(old.slice(start,old.indexOf('-- -----',start)));
    // Exact identity/display guards must preserve independent editor changes.
    await db.exec(`insert into games(id,opdb_id,display_type) values
      ('692669b7-984a-4c4d-ac9f-ee232c875737','G2Lkd-M0ope-A97xV',null),
      ('8483f5b4-8434-4ede-9443-8ae0d78c9883','G2Lkd-M0ope-A9dNy','editor-choice'),
      ('9b288f52-126e-4cfb-aa2c-3c658961116f','changed-opdb-id',null)`);
    await db.exec(migration);
    assert.equal(await value("select display_type value from games where id='692669b7-984a-4c4d-ac9f-ee232c875737'"),'lcd');
    assert.equal(await value("select display_type value from games where id='8483f5b4-8434-4ede-9443-8ae0d78c9883'"),'editor-choice');
    assert.equal(await value("select display_type value from games where id='9b288f52-126e-4cfb-aa2c-3c658961116f'"),null);
    await as(99);
    await assert.rejects(value('select snh_club_issues_list() value'),/not authorized/);
    await assert.rejects(upsert(null,{gameId:uid(1),title:'Deleted account token'}),/not authorized/);
    await as(10);
    await upsert(null,{gameId:uid(1),title:'PRIVATE TITLE',body:'PRIVATE EMAIL AND BODY',status:'resolved'});
    let reports=await value('select snh_club_issues_list() value');
    assert.equal(reports[0].status,'open','ordinary member is always Incoming');
    assert.equal(reports[0].publicSummary,null);
    const id=reports[0].id;
    await assert.rejects(upsert(id,{title:'Changed'}),/not authorized/);
    await assert.rejects(upsert(null,{gameId:uid(1),title:'Publish',publicSummary:'Not allowed'}),/not authorized/);
    await as(0,'anon');
    assert.deepEqual(await publicIssues(uid(1)),[]);
    await assert.rejects(value('select snh_club_issues_list() value'),/permission denied/);
    await assert.rejects(upsert(null,{gameId:uid(1),title:'Anonymous'}),/permission denied/);
    await assert.rejects(value('select * from club_issues'),/permission denied/);
    // Every existing helper family retains publication and resolution access.
    for (const role of ['events_editor','photos_editor','membership_editor','games_editor','games_admin','club_admin']) {
      await db.exec(`reset role; delete from member_roles; insert into member_roles values('${uid(10)}','${role}')`);
      await as(10);
      await upsert(id,{title:'PRIVATE TITLE',status:'in_progress',publicSummary:'Left flipper is weak.'});
      const pub=await publicIssues(uid(1));
      assert.deepEqual(pub,[{summary:'Left flipper is weak.',status:'in_progress'}]);
      assert.ok(!JSON.stringify(pub).includes('PRIVATE'));
    }
    await assert.rejects(upsert(id,{title:'PRIVATE TITLE',publicSummary:'a'.repeat(281)}),/280 characters/);
    await upsert(id,{title:'PRIVATE TITLE',status:'resolved'});
    assert.deepEqual(await publicIssues(uid(1)),[],'resolved reports disappear');
    await upsert(id,{title:'PRIVATE TITLE',status:'open',publicSummary:' '});
    assert.deepEqual(await publicIssues(uid(1)),[],'blank summary opts out');
    await upsert(id,{title:'PRIVATE TITLE',publicSummary:'Weak flipper'});
    await db.exec(`reset role;
      insert into game_images(id,game_id,location_type,location_value,source_type,is_primary,usage_status,metadata) values
      ('${uid(20)}','${uid(1)}','remote_url','https://example.com/primary.webp','external',true,'approved','{"deliveryVariants":[{"url":"https://example.com/small.webp","width":320}],"private":"secret"}'),
      ('${uid(21)}','${uid(1)}','remote_url','https://example.com/club.webp','club',false,'approved','{}'),
      ('${uid(22)}','${uid(1)}','remote_url','https://example.com/hidden.webp','opdb',false,'reference_only','{}'),
      ('${uid(23)}','${uid(2)}','remote_url','https://example.com/other.webp','club',true,'approved','{}');`);
    for (const [n,role] of [[0,'anon'],[10,'authenticated']]) {
      await as(n,role);
      const gallery=await images(uid(1));
      assert.deepEqual(gallery.map(i=>i.id),[uid(20),uid(21)]);
      assert.equal(gallery[0].variants[0].width,320);
      assert.ok(!JSON.stringify(gallery).includes('secret'));
      assert.deepEqual(await images(uid(99)),[]);
      assert.deepEqual(await publicIssues(uid(2)),[]);
    }
    await db.exec(`reset role; update games set deleted_at=now() where id='${uid(1)}'`);
    await as(0,'anon');
    assert.deepEqual(await images(uid(1)),[]);
    assert.deepEqual(await publicIssues(uid(1)),[]);
    await as(10);
    await assert.rejects(upsert(null,{gameId:uid(1),title:'Deleted'}),/deleted/);
    await db.exec('reset role');
    assert.ok((await value('select count(*)::int value from audit_log'))>0);
  } finally {await db.close();}
});
