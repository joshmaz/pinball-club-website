import test from 'node:test';
import assert from 'node:assert/strict';
import {photoDb,id,variants} from './photo-management-db.test.mjs';
const call=async(db,name,args=[]) => (await db.query(`select ${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) result`,args)).rows[0].result;
const role=(db,name,user)=>db.exec(`reset role;set role ${name};set request.jwt.claim.sub='${user||''}';`);
test('event photo digest returns linked albums/counts and reusable hero without exposing it to unauthorized callers',async()=>{
 const db=await photoDb();
 try {
  await role(db,'authenticated',id(101));
  const album=await call(db,'snh_photo_album_upsert',[null,{slug:'warrior',title:'American Pinball Warrior',published:true,eventId:id(501)}]);
  const draft=await call(db,'snh_photo_album_upsert',[null,{slug:'draft',title:'Draft photos',eventId:id(501)}]);
  await role(db,'service_role');
  const pending=await call(db,'snh_photo_browser_intent',[album,id(101),'event.jpg',null]);
  await call(db,'snh_photo_browser_commit',[pending.assetId,pending.uploadToken,variants(pending),id(101),false,0]);
  await call(db,'snh_photo_browser_commit',[pending.assetId,pending.uploadToken,variants(pending,'photos-public'),id(101),true,0]);
  await role(db,'authenticated',id(101));
  await call(db,'snh_photo_event_promo_set',[id(501),pending.assetId]);
  const digest=await call(db,'snh_event_photo_digest_for_editor',[id(501)]);
  assert.deepEqual(digest.albums.map(a=>a.id),[draft,album]);
  assert.equal(digest.albums.find(a=>a.id===album).assetCounts.published,1);
  assert.equal(digest.hero.assetId,pending.assetId);
  assert.deepEqual((await call(db,'snh_event_photo_digest_for_editor',[id(502)])).albums,[]);
  await role(db,'authenticated',id(103));
  await assert.rejects(call(db,'snh_event_photo_digest_for_editor',[id(501)]),/not authorized/);
  await role(db,'postgres');await db.query('insert into member_roles values($1,$2)',[id(3),'events_editor']);
  await role(db,'authenticated',id(103));
  assert.equal((await call(db,'snh_event_photo_digest_for_editor',[id(501)])).albums.length,2,'Events Editor keeps existing digest access');
  await role(db,'anon');await assert.rejects(call(db,'snh_event_photo_digest_for_editor',[id(501)]),/permission denied|not authorized/);
 } finally {await db.close();}
});
