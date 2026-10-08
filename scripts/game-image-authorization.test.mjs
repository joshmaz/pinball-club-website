import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { PGlite } from '@electric-sql/pglite';

const read = path => readFile(new URL('../' + path, import.meta.url), 'utf8');
const migration = await read('supabase/migrations/20260928210000_game_image_delete_authorization.sql');
const images = await read('supabase/migrations/20260916100000_game_images.sql');
const catalog = await read('supabase/migrations/20260501103000_games_catalog.sql');
const portal = await read('assets/js/member-portal.js');
const panel = await read('assets/js/member-games-panel.js');
const between = (s, start, end) => s.slice(s.indexOf(start), s.indexOf(end, s.indexOf(start)));
const uid = n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;

test('migration replaces permissive DELETE without changing Editor management policies', () => {
  assert.match(migration, /begin;/);
  assert.match(migration, /commit;/);
  assert.match(migration, /drop policy if exists game_images_storage_editor_delete on storage.objects;/);
  assert.doesNotMatch(migration, /create policy game_images_storage_editor_delete/);
  const policy = between(migration, 'create policy', 'create or replace function');
  assert.match(policy, /for delete\s+to authenticated/);
  assert.match(policy, /bucket_id = 'game-images'/);
  assert.match(policy, /coalesce\(public.snh_member_has_games_admin_access\(\), false\)/);
  assert.doesNotMatch(policy, /\bor\b|owner|metadata|reference_only/i);
  assert.doesNotMatch(migration, /create or replace function public.snh_game_images_(upsert|set_primary)/);
  assert.doesNotMatch(migration, /drop policy.*(?:insert|read)/);
});

test('real image RPCs preserve Editor management and require admin deletion', async () => {
  const db = new PGlite();
  try {
    await db.exec(`create role anon; create role authenticated;
      create schema auth; create schema private;
      create function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      create table members(id uuid primary key,user_id uuid);
      create table member_roles(member_id uuid,role_slug text);
      create table games(id uuid primary key,image_filename text);
      create table audit_log(action text, entity_type text, entity_id text, old_data jsonb, new_data jsonb, metadata jsonb);
      create function private.snh_audit_game(text,text,text,jsonb,jsonb,jsonb) returns void language sql as $$insert into audit_log values($1,$2,$3,$4,$5,$6)$$;
      create function private.snh_require_game_editable(uuid) returns void language plpgsql as $$begin
        if not exists(select 1 from games where id=$1) then raise exception 'game not found'; end if;
      end;$$;
      create function set_games_catalog_updated_at() returns trigger language plpgsql as $$begin new.updated_at=now(); return new; end;$$;
      insert into games values('${uid(10)}',null);
      insert into members values('${uid(1)}','${uid(1)}'),('${uid(2)}','${uid(2)}'),('${uid(3)}','${uid(3)}');
      insert into member_roles values('${uid(1)}','games_editor'),('${uid(2)}','games_admin'),('${uid(3)}','club_admin');`);
    await db.exec(between(catalog, 'create or replace function public.snh_member_has_games_access()', 'create schema if not exists private;'));
    await db.exec(await read('supabase/migrations/20260928230000_canonical_effective_role_core.sql'));
    await db.exec(await read('supabase/migrations/20260928235000_domain_helpers_use_effective_roles.sql'));
    await db.exec(images.slice(0, images.indexOf('-- Preserve every existing')));
    await db.exec(between(images, 'create or replace function public.snh_game_images_upsert(', 'create or replace function public.snh_game_images_import_opdb('));
    // Execute the actual replacement RPC; Storage service policy is source-tested above.
    await db.exec(between(migration, 'create or replace function', 'commit;'));
    const asUser = n => db.exec(`reset role; set role authenticated; set request.jwt.claim.sub='${uid(n)}'`);
    const upsert = async (id, fields) => (await db.query('select snh_game_images_upsert($1,$2,$3) id', [id, uid(10), JSON.stringify(fields)])).rows[0].id;
    const remove = id => db.query('select snh_game_images_delete_uploaded($1,$2) value', [uid(10), id]);
    await asUser(1);
    const first = await upsert(null, {sourceType:'club',sourceKey:'storage:first',locationType:'remote_url',locationValue:'https://example.com/first.jpg',metadata:{storageBucket:'game-images',storagePath:uid(10)+'/first.jpg'}});
    const second = await upsert(null, {sourceType:'club',sourceKey:'storage:second',locationType:'remote_url',locationValue:'https://example.com/second.jpg',metadata:{storageBucket:'game-images',storagePath:uid(10)+'/second.jpg'}});
    await upsert(second, {altText:'Edited', usageStatus:'reference_only'});
    await upsert(second, {usageStatus:'approved'});
    await db.query('select snh_game_images_set_primary($1,$2)', [uid(10), first]);
    await assert.rejects(remove(first), error => error.code === '42501');
    assert.equal((await db.query('select count(*)::int n from game_images')).rows[0].n, 2);
    assert.equal((await db.query('select is_primary from game_images where id=$1',[first])).rows[0].is_primary, true);
    await db.exec('reset role');
    assert.equal((await db.query("select count(*)::int n from audit_log where action='delete'")).rows[0].n, 0);
    await asUser(2);
    assert.equal((await remove(first)).rows[0].value.path, uid(10)+'/first.jpg');
    assert.equal((await db.query('select is_primary from game_images where id=$1',[second])).rows[0].is_primary, true);
    await asUser(3);
    await remove(second);
    await db.exec('reset role');
    assert.equal((await db.query("select count(*)::int n from audit_log where action='delete'")).rows[0].n, 2);
  } finally { await db.close(); }
});

function clientContext({uploadError, associationError, thrownError, cleanupError, deleteError, derivativeRows = []} = {}) {
  const calls = [];
  const client = {
    storage: {from(bucket) { return {
      async upload(path, file, options) { calls.push(['upload',bucket,path,options]); return {error:uploadError}; },
      getPublicUrl() { return {data:{publicUrl:'https://example.com/image.jpg'}}; },
      async remove(paths) { calls.push(['remove',bucket,paths]); return {error:cleanupError}; }
    }; }},
    async rpc(name, args) {
      calls.push(['rpc',name,args]);
      if (name === 'snh_game_images_upsert') {
        if (thrownError) throw thrownError;
        return {data:'image-id',error:associationError};
      }
      return {data:{bucket:'game-images',path:'game/object.jpg'},error:deleteError};
    }
  };
  const context = {getClient:()=>client,window:{crypto:{randomUUID:()=> 'object'},SNHGameImages:{generate:async()=>derivativeRows,widths:[320,640,1200]}}};
  vm.runInNewContext(between(portal, '  async function gameImageUpsert(', '  async function opdbGameImageSync('), context);
  return {context,calls};
}
const file = {type:'image/jpeg',size:123,name:'photo.jpg'};

test('Editor upload creates approved association without requiring DELETE', async () => {
  const {context,calls} = clientContext();
  assert.equal(await context.gameImageUpload('game',file,{}),'image-id');
  assert.equal(calls[0][3].upsert,false);
  assert.equal(calls[1][2].p_fields.usageStatus,'approved');
  assert.equal(calls[1][2].p_fields.makePrimary,true);
  assert.equal(calls.some(c=>c[0]==='remove'),false);
});

test('upload, rejected association and ambiguous response preserve errors without Storage DELETE', async () => {
  for (const key of ['uploadError','associationError','thrownError']) {
    const original = new Error(key);
    const {context,calls} = clientContext({[key]:original});
    await assert.rejects(context.gameImageUpload('game',file,{}),error=>error===original);
    assert.equal(calls.some(c=>c[0]==='remove'),false);
  }
});

test('explicit admin removal cleans Storage after RPC and preserves warning', async () => {
  for (const cleanupError of [null,new Error('Storage unavailable')]) {
    const {context,calls} = clientContext({cleanupError});
    const result = await context.gameImageDeleteUploaded('game','image');
    assert.equal(calls[0][1],'snh_game_images_delete_uploaded');
    assert.equal(calls[1][0],'remove');
    assert.deepEqual(Array.from(calls[1][2]), ['game/object.jpg', 'game/object.jpg.w320.webp', 'game/object.jpg.w640.webp', 'game/object.jpg.w1200.webp']);
    assert.equal(result.warning,cleanupError ? 'The image was removed from the game, but its stored file could not be cleaned up.' : null);
  }
  const original = new Error('not authorized');
  const {context,calls} = clientContext({deleteError:original});
  await assert.rejects(context.gameImageDeleteUploaded('game','image'),error=>error===original);
  assert.equal(calls.some(c=>c[0]==='remove'),false);
});

test('Editor remove controls are gated and handler exits before confirmation or deletion', async () => {
  assert.match(panel,/if \(isUploadedClubImage && hasDeleteAccess\(\)\) \{/);
  let called = false;
  const context = {hasDeleteAccess:()=>false,currentGameId:'game',window:{SNHMemberPortal:{},confirm(){called=true;}}};
  vm.runInNewContext(between(panel,'  async function onRemoveUploadedImage(', '  async function onSyncOpdbImages('),context);
  await context.onRemoveUploadedImage({id:'image'});
  assert.equal(called,false);
  assert.match(between(panel,'  function hasDeleteAccess()', '  function isGameDeleted('),/games_admin,club_admin/);
  assert.doesNotMatch(between(panel,'  async function onAddClubImage()', '  async function onRemoveUploadedImage('),/hasDeleteAccess/);
});

test('failed upload refreshes images while preserving original error even if refresh fails', async () => {
  for (const refreshFails of [false,true]) {
    const original = new Error('association response lost');
    let refreshes = 0;
    let status;
    const input = {files:[file]};
    const context = {
      currentGameId:'game',imageUploadBusy:false,
      document:{getElementById:id=>id==='mg-image-file'?input:null},
      getVal:()=>'',currentGame:()=>({title:'Game'}),setStatus:value=>{status=value;},
      async refreshCurrentGameImages(){refreshes++; if(refreshFails) throw new Error('refresh failed');},
      window:{SNHMemberPortal:{async gameImageUpload(){throw original;},getFriendlyAuthErrorMessage(error){assert.equal(error,original);return error.message;}}}
    };
    vm.runInNewContext(between(panel,'  async function onAddClubImage()', '  async function onRemoveUploadedImage('),context);
    await context.onAddClubImage();
    assert.equal(refreshes,1);
    assert.equal(status,original.message);
    assert.equal(context.imageUploadBusy,false);
    assert.equal(input.disabled,false);
  }
});

test('upload publishes variant metadata after all immutable derivative writes', async () => {
  const derivativeRows=[320,640,1200].map(target=>({target,width:target,height:target/2,blob:{size:target,type:'image/webp'}}));
  const {context,calls}=clientContext({derivativeRows});
  await context.gameImageUpload('game',file,{});
  assert.deepEqual(calls.slice(0,4).map(c=>c[2]),['game/object.jpg','game/object.jpg.w320.webp','game/object.jpg.w640.webp','game/object.jpg.w1200.webp']);
  assert.equal(calls[4][0],'rpc');
  assert.deepEqual(Array.from(calls[4][2].p_fields.metadata.deliveryVariants,v=>v.width),[320,640,1200]);
  assert.equal(calls.slice(1,4).every(c=>c[3].upsert===false&&c[3].cacheControl==='31536000'),true);
});
