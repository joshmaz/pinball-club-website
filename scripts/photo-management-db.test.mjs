import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
const read = name => readFile(new URL('../supabase/migrations/' + name, import.meta.url), 'utf8');
export const id = n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
export async function photoDb() {
  const db = new PGlite();
  await db.exec(`create role anon;create role authenticated;create role service_role;
    create schema auth;create schema private;create schema storage;
    create function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    create table members(id uuid primary key,user_id uuid unique);
    create table member_roles(member_id uuid,role_slug text);
    create table events(id uuid primary key,title text,starts_at timestamptz,published boolean);
    create table audit_log(module text,action text,actor_user_id uuid,entity_type text,entity_id text,old_data jsonb,new_data jsonb,metadata jsonb);
    create table storage.buckets(id text primary key,allowed_mime_types text[],file_size_limit bigint);
    insert into storage.buckets(id) values ('photos-private'),('photos-public');
    create function set_games_catalog_updated_at() returns trigger language plpgsql as $$begin new.updated_at=now();return new;end$$;
    insert into members values('${id(1)}','${id(101)}'),('${id(2)}','${id(102)}'),('${id(3)}','${id(103)}');
    insert into member_roles values('${id(1)}','photos_editor'),('${id(2)}','photos_admin');
    insert into events values('${id(501)}','Event one',now(),true),('${id(502)}','Event two',now(),true),('${id(503)}','Draft event',now(),false);
  `);
  for (const name of ['20260512100000_photos_foundation.sql','20260512120000_photos_rpcs.sql',
    '20260519090000_photo_albums_events_schema.sql','20260519091000_photo_albums_events_rpcs.sql',
    '20260522140000_photo_album_include_in_highlights.sql','20261013120000_photo_management_v2.sql','20261013140000_photo_album_ordering.sql']) {
    try { await db.exec((await read(name)).replace('create extension if not exists pgcrypto;', '')); } catch(e) { console.error(name,e.position,e.internalPosition,e.internalQuery);throw e; }
  }
  await db.exec('grant select on photo_albums,photo_assets,photo_asset_variants to anon,authenticated;grant usage on schema auth to anon,authenticated;');
  return db;
}
const query = async (db, sql, params = []) => (await db.query(sql, params)).rows;
const call = async (db, name, values) => (await query(db, `select ${name}(${values.map((_, i) => '$' + (i + 1)).join(',')}) result`, values))[0].result;
const role = (db, name, user) => db.exec(`reset role;set role ${name};set request.jwt.claim.sub='${user || ''}';`);
export function variants(pending, bucket = 'photos-private', publication = id(800)) {
  return ['web','thumb'].map(variant => ({ variant, bucket,
    objectKey: bucket === 'photos-private' ? `${pending.prefix}/staged-${pending.uploadToken}-${variant}.webp` : `${pending.prefix}/${variant}-${publication}-${'a'.repeat(12)}.webp`,
    contentType: 'image/webp', width: variant === 'web' ? 1920 : 640, height: variant === 'web' ? 1280 : 427,
    byteSize: 500, contentHash: 'a'.repeat(64) }));
}
test('real photo migrations: roles, publication, reuse, revision races, cascade cleanup and retained originals', async () => {
 const db = await photoDb();
 try {
  await role(db,'authenticated',id(101));
  const album = await call(db,'snh_photo_album_upsert',[null,{slug:'club-night',title:'Club night',published:false,eventId:id(501)}]);
  const album2 = await call(db,'snh_photo_album_upsert',[null,{slug:'other',title:'Other',published:true}]);
  await role(db,'service_role');
  const pending = await call(db,'snh_photo_browser_intent',[album,id(101),'camera.jpg',null]);
  const asset = pending.assetId, staged = variants(pending);
  await assert.rejects(call(db,'snh_photo_browser_commit',[asset,pending.uploadToken,[staged[0],staged[0]],id(101),false,0]),/web and thumb required/);
  await assert.rejects(call(db,'snh_photo_browser_commit',[asset,pending.uploadToken,variants(pending).map(v=>({...v,width:2000})),id(101),false,0]),/invalid derivative/);
  await call(db,'snh_photo_browser_commit',[asset,pending.uploadToken,staged,id(101),false,0]);
  const pub = variants(pending,'photos-public');
  await call(db,'snh_photo_browser_commit',[asset,pending.uploadToken,pub,id(101),true,0]);
  await role(db,'authenticated',id(101));
  await assert.rejects(call(db,'snh_photo_album_upsert',[album2,{slug:'other',title:'Other',coverAssetId:asset}]),/cover must belong/);
  await call(db,'snh_photo_album_upsert',[album,{slug:'club-night',title:'Club night',published:true,coverAssetId:asset,eventId:id(501)}]);
  await call(db,'snh_photo_event_promo_set',[id(502),asset]);
  await assert.rejects(call(db,'snh_photo_event_promo_set',[id(503),asset]),/published event required/);
  await assert.rejects(call(db,'snh_photo_album_delete',[album]),e=>e.code==='42501');
  await role(db,'anon');
  const albums = await call(db,'snh_public_photo_albums',[]);
  assert.equal(albums.find(a=>a.id===album).coverAssetId,asset);
  assert.equal((await call(db,'snh_public_event_promo_asset',[id(502)])).assetId,asset);
  assert.equal(await call(db,'snh_public_event_promo_asset',[id(503)]),null);
  assert.equal((await query(db,'select count(*)::int n from photo_assets'))[0].n,1);
  await assert.rejects(call(db,'snh_photo_browser_intent',[album,id(103),'evil.jpg',null]),e=>e.code==='42501');
  await assert.rejects(query(db,'select * from private.photo_storage_cleanup'),e=>e.code==='42501');
  await role(db,'authenticated',id(103));
  await assert.rejects(call(db,'snh_photo_album_upsert',[album,{slug:'club-night',title:'Changed'}]),e=>e.code==='42501');
  await assert.rejects(call(db,'snh_photo_event_promo_set',[id(502),asset]),e=>e.code==='42501');
  await assert.rejects(call(db,'snh_photo_asset_finalize_upload',[asset,500,'a'.repeat(64),1920,1280]),e=>e.code==='42501');
  await role(db,'authenticated',id(101));
  await call(db,'snh_photo_asset_unpublish',[asset]);
  await role(db,'service_role');
  assert.equal((await call(db,'snh_photo_cleanup_list',[])).length,2,'unpublish queues both public paths');
  await assert.rejects(call(db,'snh_photo_browser_commit',[asset,pending.uploadToken,pub,id(101),true,0]),/changed/);
  await call(db,'snh_photo_browser_commit',[asset,pending.uploadToken,variants(pending,'photos-public',id(801)),id(101),true,1]);
  const queued = await call(db,'snh_photo_cleanup_list',[]);
  assert.equal(queued.length,2,'old keys stay retryable while new publication is protected');
  await call(db,'snh_photo_cleanup_ack',[queued[0].id,'storage unavailable']);
  assert.equal(await call(db,'snh_photo_cleanup_pending',[]),2,'backoff does not hide queued work');
  await role(db,'postgres');
  assert.equal((await query(db,'select attempts from private.photo_storage_cleanup where id=$1',[queued[0].id]))[0].attempts,1);
  // An old original survives a browser upgrade and publication.
  await query(db,`insert into photo_assets(id,album_id,status,original_object_key,original_content_type) values($1,$2,'uploaded','legacy/original.jpg','image/jpeg')`,[id(600),album]);
  await role(db,'service_role');
  const legacy = await call(db,'snh_photo_browser_intent',[album,id(101),'old.jpg',id(600)]);
  await call(db,'snh_photo_browser_commit',[id(600),legacy.uploadToken,variants(legacy),id(101),false,1]);
  await role(db,'postgres');
  assert.equal((await query(db,'select original_object_key from photo_assets where id=$1',[id(600)]))[0].original_object_key,'legacy/original.jpg');
  // A failed/expired upgrade is reset without ever queuing its retained original.
  await query(db,`insert into photo_assets(id,album_id,status,original_object_key,original_content_type) values($1,$2,'unpublished','retained/expired.jpg','image/jpeg')`,[id(601),album]);
  await role(db,'service_role');
  const expired = await call(db,'snh_photo_browser_intent',[album,id(101),'expired.jpg',id(601)]);
  await role(db,'postgres');
  await query(db,"update photo_assets set upload_expires_at=now()-interval '26 hours' where id=$1",[id(601)]);
  await role(db,'service_role');
  await call(db,'snh_photo_cleanup_list',[]);
  await role(db,'postgres');
  const retained = (await query(db,'select upload_mode,status,original_object_key from photo_assets where id=$1',[id(601)]))[0];
  assert.deepEqual(retained,{upload_mode:'legacy',status:'uploaded',original_object_key:'retained/expired.jpg'});
  assert.equal((await query(db,"select count(*)::int n from private.photo_storage_cleanup where object_key='retained/expired.jpg'"))[0].n,0);
  // A new abandoned upload is removed after the expiry grace and its stage keys are queued.
  await role(db,'service_role');
  const abandoned = await call(db,'snh_photo_browser_intent',[album,id(101),'abandoned.jpg',null]);
  await role(db,'postgres');
  await query(db,"update photo_assets set upload_expires_at=now()-interval '26 hours' where id=$1",[abandoned.assetId]);
  await role(db,'service_role'); await call(db,'snh_photo_cleanup_list',[]);
  await role(db,'postgres');
  assert.equal((await query(db,'select count(*)::int n from photo_assets where id=$1',[abandoned.assetId]))[0].n,0);
  assert.equal((await query(db,'select count(*)::int n from private.photo_storage_cleanup where object_key like $1',[abandoned.prefix+'/%']))[0].n,2);
  await role(db,'authenticated',id(102));
  await call(db,'snh_photo_album_delete',[album]);
  await role(db,'postgres');
  assert.equal((await query(db,'select count(*)::int n from photo_assets'))[0].n,0);
  assert.ok((await query(db,"select * from private.photo_storage_cleanup where object_key='legacy/original.jpg'")).length);
  assert.equal((await query(db,'select count(*)::int n from event_photo_promotions'))[0].n,0);
 } finally { await db.close(); }
});
