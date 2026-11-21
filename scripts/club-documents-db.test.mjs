import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const { PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite');

test('club documents enforce roster, profile and link permissions at the database boundary', async () => {
  const db = new PGlite();
  const admin = '00000000-0000-0000-0000-000000000001';
  const board = '00000000-0000-0000-0000-000000000002';
  const staff = '00000000-0000-0000-0000-000000000003';
  const basic = '00000000-0000-0000-0000-000000000004';
  const unverified = '00000000-0000-0000-0000-000000000005';
  const url = 'https://drive.google.com/file/d/abc_DEF-123/view?usp=sharing';
  const actingAs = (id) => db.query("select set_config('test.user_id', $1, false)", [id]);
  const assign = (id, designation, title) => db.query('select snh_set_club_designation($1, $2, $3)', [id, designation, title]);
  const save = (id, link, pinned = false) => db.query(
    'select snh_save_club_document($1, $2, $3, $4, $5)', [id, 'Accepted minutes', link, '2026-11-19', pinned]
  );
  const load = async () => (await db.query('select snh_club_documents() as data')).rows[0].data;
  const denied = (error) => error.code === '42501';

  try {
    await db.exec(`create role anon; create role authenticated; create role service_role; create schema auth; create schema private;
      create table auth.users(id uuid primary key, email text, email_confirmed_at timestamptz,
        created_at timestamptz, last_sign_in_at timestamptz);
      create table members(id uuid primary key, user_id uuid, email text, first_name text, last_name text,
        display_name text, created_at timestamptz default now(), updated_at timestamptz default now());
      create table external_accounts(member_id uuid, provider_slug text, account_handle text);
      create table member_roles(member_id uuid, role_slug text);
      create table memberships(id int, member_id uuid, status text, tier text, end_date date, created_at timestamptz);
      create function auth.uid() returns uuid language sql as $$ select nullif(current_setting('test.user_id', true), '')::uuid $$;
      create function snh_account_exists() returns boolean language sql as $$ select exists(select from auth.users where id = auth.uid()) $$;
      create function snh_member_has_effective_role(role text) returns boolean language sql as $$
        select role = 'membership_admin' and auth.uid() = '${admin}'::uuid $$;
      create function snh_member_can_manage_roles() returns boolean language sql as $$
        select snh_member_has_effective_role('membership_admin') $$;
      grant select, insert, update on members to authenticated;
      insert into auth.users(id,email,email_confirmed_at) values
        ('${admin}','admin@example.com',now()), ('${board}','board@example.com',now()),
        ('${staff}','staff@example.com',now()), ('${basic}','basic@example.com',now()),
        ('${unverified}','unverified@example.com',null);
      insert into members(id,user_id,display_name) select id,id,split_part(email,'@',1) from auth.users;
    `);
    await db.exec(`create function private.snh_canonical_member_identity() returns trigger
      language plpgsql security definer set search_path = '' as $$
      declare v_existing public.members; v_email text;
      begin
        if current_setting('role', true) in ('anon', 'authenticated') then
          if auth.uid() is null or new.user_id is distinct from auth.uid() then
            raise exception 'Profile must belong to the signed-in account' using errcode='42501';
          end if;
          if tg_op = 'UPDATE' and (new.id is distinct from old.id or new.user_id is distinct from old.user_id
             or new.created_at is distinct from old.created_at) then
            raise exception 'Account identity fields cannot be changed' using errcode='42501';
          end if;
          new.updated_at := now();
        end if;
        if new.user_id is not null then select u.email into v_email from auth.users u where u.id=new.user_id; new.email := v_email; end if;
        return new;
      end $$;
      create trigger snh_members_canonical_identity before insert or update on members
        for each row execute function private.snh_canonical_member_identity();`);
    await db.exec(await readFile(new URL('../supabase/migrations/20261120210000_club_documents.sql', import.meta.url), 'utf8'));
    await db.exec(await readFile(new URL('../supabase/migrations/20261121150000_club_designation_admin_update.sql', import.meta.url), 'utf8'));
    await db.exec(await readFile(new URL('../supabase/migrations/20261121180000_club_roster_private_names.sql', import.meta.url), 'utf8'));

    await db.exec('set role anon');
    await assert.rejects(load(), denied);
    await db.exec('set role authenticated');
    await actingAs(basic);
    await assert.rejects(assign(basic, 'staff', 'Staff'), denied);
    await assert.rejects(db.query("update members set club_designation = 'staff' where id = $1", [basic]), denied);
    await assert.rejects(db.query("insert into members(id, club_designation) values (gen_random_uuid(), 'staff')"), denied);
    await db.query("update members set display_name = 'Updated name' where id = $1", [basic]);
    await assert.rejects(save(null, url), denied);

    await actingAs(admin);
    await assign(board, 'board', ' President ');
    await assign(staff, 'staff', null);
    await assert.rejects(db.query("update members set display_name = 'Admin edit' where id = $1", [board]), denied);
    await assert.rejects(assign(unverified, 'staff', null), /verified email/);
    const adminRows = (await db.query('select snh_list_members_for_admin() as rows')).rows[0].rows;
    assert.equal(adminRows.find(row => row.member_id === board).club_title, 'President');
    await assert.rejects(save(null, url), denied);

    await actingAs(board);
    await assert.rejects(save(null, 'https://drive.google.com.example.com/file/d/abc'), { code: '23514' });
    await save(null, url);
    await db.query("select snh_set_club_document_folder('https://drive.google.com/drive/folders/example_folder')");
    await db.query("select snh_set_club_document_folder('https://drive.google.com/drive/folders/replacement')");

    const boardData = await load();
    assert.match(boardData.board_folder_url, /^https:\/\/drive\.google\.com\/drive\/folders\//);
    assert.match(boardData.board_folder_url, /replacement$/);
    assert.equal(boardData.links.length, 1);
    const [link] = boardData.links;

    await actingAs(staff);
    await db.query("update members set display_name = 'staff@example.com' where id = $1", [staff]);
    await save(link.id, url, true);
    await actingAs(basic);
    const basicData = await load();
    assert.equal(basicData.board_folder_url, null);
    assert.equal(basicData.can_edit, false);
    await assert.rejects(db.query('select snh_set_club_document_folder(null)'), denied);
    assert.equal(basicData.links[0].pinned, true);
    assert.deepEqual(basicData.roster, [
      { name: 'board', designation: 'board', title: 'President' },
      { name: 'Club volunteer', designation: 'staff', title: null }
    ]);
    await assert.rejects(db.query('select snh_remove_club_document($1)', [link.id]), denied);

    await actingAs(admin);
    await assign(board, null, 'Ignored');
    await actingAs(board);
    assert.equal((await load()).board_folder_url, null);
    await assert.rejects(save(link.id, url), denied);
    await actingAs(staff);
    await db.query('select snh_remove_club_document($1)', [link.id]);
    assert.deepEqual((await load()).links, []);
    await assert.rejects(save(link.id, url), /already been removed/);

    await actingAs('00000000-0000-0000-0000-000000000099');
    await assert.rejects(load(), denied);
  } finally {
    await db.close();
  }
});
