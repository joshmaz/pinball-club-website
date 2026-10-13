import test from 'node:test';
import assert from 'node:assert/strict';
import {photoDb,id,variants} from './photo-management-db.test.mjs';
const call=async(db,name,args=[]) => (await db.query(`select ${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) result`,args)).rows[0].result;
const role=(db,name,user)=>db.exec(`reset role;set role ${name};set request.jwt.claim.sub='${user||''}';`);
test('photo ordering: atomic save, snapshots, append uploads, metadata and public gallery order',async()=>{
 const db=await photoDb();
 try {
  await role(db,'authenticated',id(101));
  const album=await call(db,'snh_photo_album_upsert',[null,{slug:'ordered-photos',title:'Ordered photos',published:true}]);
  const other=await call(db,'snh_photo_album_upsert',[null,{slug:'other-photos',title:'Other photos'}]);
  const make=async(target,name)=>{
   await role(db,'service_role');
   const pending=await call(db,'snh_photo_browser_intent',[target,id(101),name,null]);
   await call(db,'snh_photo_browser_commit',[pending.assetId,pending.uploadToken,variants(pending),id(101),false,0]);
   await call(db,'snh_photo_browser_commit',[pending.assetId,pending.uploadToken,variants(pending,'photos-public'),id(101),true,0]);
   await role(db,'authenticated',id(101));return pending.assetId;
  };
  const a=await make(album,'a.jpg'),b=await make(album,'b.jpg'),foreign=await make(other,'other.jpg');
  await call(db,'snh_photo_asset_set_metadata',[a,{caption:'Keep caption',altText:'Keep alternative',excludeFromSlideshow:true}]);
  await call(db,'snh_photo_album_upsert',[album,{slug:'ordered-photos',title:'Ordered photos',published:true,coverAssetId:a}]);
  const list=()=>call(db,'snh_photo_assets_list_editor',[album]);
  const snapshot=assets=>assets.map(v=>({id:v.id,sortPosition:v.sortPosition}));
  let before=await list();assert.deepEqual(before.map(v=>v.id),[a,b]);
  assert.equal((await call(db,'snh_photo_album_order_settings')).photoOrderAvailable,true);
  await assert.rejects(call(db,'snh_photo_asset_order_save',[album,[a,a],snapshot(before)]),/exactly once/);
  await assert.rejects(call(db,'snh_photo_asset_order_save',[album,[a,foreign],snapshot(before)]),/exactly once/);
  await assert.rejects(call(db,'snh_photo_asset_order_save',[album,[a],snapshot(before)]),/exactly once/);
  assert.deepEqual((await list()).map(v=>v.id),[a,b],'invalid save rolls back');
  await call(db,'snh_photo_asset_order_save',[album,[b,a],snapshot(before)]);
  const after=await list();assert.deepEqual(after.map(v=>v.id),[b,a],'reload preserves saved order');
  for(const item of before) {
   const updated=after.find(v=>v.id===item.id);
   for(const field of ['caption','altText','visibility','status','albumId','excludeFromSlideshow','promoRole'])assert.deepEqual(updated[field],item[field],field+' preserved');
  }
  const gallery=await call(db,'snh_public_photo_albums');
  assert.deepEqual(gallery.find(v=>v.id===album).assets.map(v=>v.id),[b,a]);
  assert.equal(gallery.find(v=>v.id===album).coverAssetId,a,'cover remains selected independently');
  await assert.rejects(call(db,'snh_photo_asset_order_save',[album,[a,b],snapshot(before)]),/Photos changed/);
  const c=await make(album,'c.jpg');assert.deepEqual((await list()).map(v=>v.id),[b,a,c],'new upload appends');
  await assert.rejects(call(db,'snh_photo_asset_order_save',[album,[a,b],snapshot(after)]),/Photos changed/);
  await call(db,'snh_photo_asset_unpublish',[b]);
  await role(db,'postgres');await db.query("update photo_assets set visibility='private' where id=$1",[b]);
  await role(db,'authenticated',id(101));
  before=await list();
  await call(db,'snh_photo_asset_order_save',[album,[c,b,a],snapshot(before)]);
  const hidden=(await list()).find(v=>v.id===b);
  assert.equal(hidden.status,'unpublished');assert.equal(hidden.visibility,'private','hidden/private photos stay hidden');
  assert.deepEqual((await call(db,'snh_public_photo_albums')).find(v=>v.id===album).assets.map(v=>v.id),[c,a]);
  before=await list();
  await role(db,'authenticated',id(103));await assert.rejects(call(db,'snh_photo_asset_order_save',[album,[c,a,b],snapshot(before)]),/not authorized/);
  await role(db,'anon');await assert.rejects(call(db,'snh_photo_asset_order_save',[album,[c,a,b],snapshot(before)]),/permission denied/);
 }finally{await db.close();}
});
