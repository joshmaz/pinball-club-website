import test from 'node:test';
import assert from 'node:assert/strict';
import {photoDb,id} from './photo-management-db.test.mjs';
const call=async(db,name,args=[]) => (await db.query(`select ${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) result`,args)).rows[0].result;
const role=(db,name,user)=>db.exec(`reset role;set role ${name};set request.jwt.claim.sub='${user||''}';`);
test('album ordering: atomic custom save, roles, revisions, date modes and new album placement',async()=>{
 const db=await photoDb();
 try {
  // Check the installed definitions, since the embedded database lacks the hosted
  // safety check that rejects UPDATE statements without a WHERE clause.
  for(const name of ['private.snh_photo_order_revision()','public.snh_photo_album_order_save(text,uuid[],bigint)']) {
   const definition=(await db.query('select pg_get_functiondef($1::regprocedure) body',[name])).rows[0].body;
   assert.match(definition,/update private\.photo_gallery_order set [^;]+ where singleton=true;/i);
  }
  await role(db,'authenticated',id(101));
  const make=(slug,date)=>call(db,'snh_photo_album_upsert',[null,{slug,title:slug,published:true,displayAt:date}]);
  const a=await make('older','2020-01-01T00:00:00Z'),b=await make('newer','2025-01-01T00:00:00Z');
  let settings=await call(db,'snh_photo_album_order_settings');assert.equal(settings.mode,'custom');
  assert.deepEqual((await call(db,'snh_photo_albums_list_editor')).map(v=>v.id),[b,a]);
  await assert.rejects(call(db,'snh_photo_album_order_save',['custom',[a,a],settings.revision]),/exactly once/);
  await assert.rejects(call(db,'snh_photo_album_order_save',['custom',[a],settings.revision]),/exactly once/);
  await assert.rejects(call(db,'snh_photo_album_order_save',['custom',[a,id(999)],settings.revision]),/exactly once/);
  assert.equal((await call(db,'snh_photo_album_order_settings')).revision,settings.revision,'invalid saves do not change state');
  settings=await call(db,'snh_photo_album_order_save',['custom',[a,b],settings.revision]);
  assert.deepEqual((await call(db,'snh_public_photo_albums')).map(v=>v.id),[a,b]);
  await assert.rejects(call(db,'snh_photo_album_order_save',['newest',null,settings.revision-1]),/Album order changed/);
  const oldPosition=(await call(db,'snh_photo_albums_list_editor')).find(v=>v.id===b).sortPosition;
  await call(db,'snh_photo_album_upsert',[b,{slug:'newer',title:'New title',published:true,displayAt:'2025-01-01T00:00:00Z'}]);
  assert.equal((await call(db,'snh_photo_albums_list_editor')).find(v=>v.id===b).sortPosition,oldPosition,'metadata edits preserve position');
  settings=await call(db,'snh_photo_album_order_settings');
  settings=await call(db,'snh_photo_album_order_save',['newest',null,settings.revision]);
  assert.deepEqual((await call(db,'snh_public_photo_albums')).map(v=>v.id),[b,a]);
  await role(db,'anon');assert.equal((await call(db,'snh_photo_album_order_settings')).mode,'newest');
  await assert.rejects(call(db,'snh_photo_album_order_save',['custom',[a,b],settings.revision]),/permission denied/);
  await assert.rejects(db.query('select * from private.photo_gallery_order'),/permission denied/);
  await role(db,'authenticated',id(103));await assert.rejects(call(db,'snh_photo_album_order_save',['custom',[a,b],settings.revision]),/not authorized/);
  await role(db,'authenticated',id(101));
  settings=await call(db,'snh_photo_album_order_save',['custom',[a,b],settings.revision]);
  const c=await make('fresh','2010-01-01T00:00:00Z');
  assert.deepEqual((await call(db,'snh_public_photo_albums')).map(v=>v.id),[c,a,b]);
  await assert.rejects(call(db,'snh_photo_album_order_save',['custom',[b,a],settings.revision]),/Album order changed/);
  await role(db,'authenticated',id(102));
  settings=await call(db,'snh_photo_album_order_settings');
  await call(db,'snh_photo_album_delete',[c]);
  await assert.rejects(call(db,'snh_photo_album_order_save',['custom',[a,b],settings.revision]),/Album order changed/);
  await role(db,'postgres');assert.equal((await db.query("select count(*)::int n from audit_log where action='reorder'")).rows[0].n,3);
 } finally {await db.close();}
});
