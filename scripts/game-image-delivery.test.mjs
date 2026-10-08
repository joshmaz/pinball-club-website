import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';
const source = await readFile(new URL('../assets/js/game-image-delivery.js', import.meta.url), 'utf8');
function context(extra = {}) { const c = { ...extra }; vm.runInNewContext(source, c); return c.SNHGameImages; }
function img() { return {removeAttribute(key) { delete this[key]; }}; }
const image = {url:'https://example.test/original.jpg', variants:[
  {url:'https://example.test/small.webp',width:320},
  {url:'https://example.test/medium.webp',width:640},
  {url:'https://example.test/large.webp',width:1200}]};
test('card and detail use derivative candidates and never include original in srcset', () => {
 const api=context(), card=img(), detail=img(); api.apply(card,image,false); api.apply(detail,image,true);
 assert.equal(card.src,image.variants[1].url); assert.equal(detail.src,image.variants[2].url);
 assert.equal(card.srcset.includes('original'),false); assert.match(card.srcset,/320w.*640w.*1200w/);
});
test('old records and animation fallback clear previous slideshow srcset', () => {
 const api=context(), element=img(); api.apply(element,image,false); api.apply(element,{url:image.url},false);
 assert.equal(element.src,image.url); assert.equal(element.srcset,undefined);
});
test('invalid widths and duplicate candidates are excluded', () => {
 const rows=context().variants({variants:[...image.variants,image.variants[0],{url:'javascript:alert(1)',width:400},{url:'https://x',width:-1}]});
 assert.equal(rows.length,3);
});
test('encoder preserves aspect ratio, avoids upscaling, and releases bitmap', async () => {
 let closed=false;
 const api=context({createImageBitmap:async()=>({width:500,height:1000,close(){closed=true;}}),
 document:{createElement(){return {getContext(){return {drawImage(){}};},toBlob(cb,type){cb({type,size:12});}};}}});
 const rows=await api.generate({type:'image/jpeg'});
 assert.deepEqual(Array.from(rows,v=>[v.width,v.height]),[[320,640],[500,1000]]); assert.equal(closed,true);
 assert.equal((await api.generate({type:'image/gif'})).length,0);
});
test('unsupported WebP fails before upload instead of publishing mismatched files', async () => {
 const api=context({createImageBitmap:async()=>({width:500,height:500,close(){}}),
 document:{createElement(){return {getContext(){return {drawImage(){}};},toBlob(cb){cb({type:'image/png'});}};}}});
 await assert.rejects(api.generate({type:'image/jpeg'}),/cannot encode WebP/);
});

test('catalog migration preserves selected association and hides reference-only variants', async () => {
 const { PGlite } = await import('@electric-sql/pglite');
 const oldSource=await readFile(new URL('../supabase/migrations/20260916100000_game_images.sql',import.meta.url),'utf8');
 const start=oldSource.indexOf('create or replace view public.games_catalog_v1');
 const oldView=oldSource.slice(start,oldSource.indexOf('comment on view public.games_catalog_v1',start));
 const migration=await readFile(new URL('../supabase/migrations/20261007120000_game_image_delivery_variants.sql',import.meta.url),'utf8');
 const fields=[...new Set([...oldView.matchAll(/ge\.(\w+)/g)].map(m=>m[1]))].filter(x=>x!=='effective_at_club');
 const types={id:'uuid',manual_at_club_override:'boolean',map_at_club:'boolean',deleted_at:'timestamptz',release_date:'date',manufacture_date:'date',player_count:'integer'};
 if(!fields.includes('deleted_at')) fields.push('deleted_at');
 const db=new PGlite();
 try {
  await db.exec(`create role anon; create role authenticated;
    create table games(${fields.map(f=>f+' '+(types[f]||'text')).join(',')});
    create table game_location_stints(id uuid, game_id uuid,address text,pinball_map_location_id integer,pinball_map_machine_id integer,joined_club_date date,left_club_date date);
    create table game_images(id uuid,game_id uuid,location_type text,location_value text,source_type text,image_type text,alt_text text,attribution_text text,attribution_url text,source_url text,license_name text,license_url text,usage_status text,is_primary boolean,created_at timestamptz,metadata jsonb);`);
  await db.exec(oldView); await db.exec(migration);
  const gid='00000000-0000-0000-0000-000000000001';
  await db.query('insert into games(id,slug,title,map_at_club) values($1, $2, $3,true)',[gid,'example','Example']);
  const add=async (id,status,primary,url,created)=>db.query('insert into game_images(id,game_id,source_type,location_type,location_value,usage_status,is_primary,created_at,metadata) values($1,$2, $3,$4,$5,$6,$7,$8,$9)',[id,gid,'club','remote_url',url,status,primary,created,JSON.stringify({deliveryVariants:image.variants})]);
  await add('00000000-0000-0000-0000-000000000002','reference_only',false,'https://example.test/private','2020-01-01');
  assert.equal((await db.query('select game from games_catalog_v1')).rows[0].game.primaryImage,undefined);
  await add('00000000-0000-0000-0000-000000000003','approved',true,image.url,'2021-01-01');
  const selected=(await db.query('select game from games_catalog_v1')).rows[0].game.primaryImage;
  assert.equal(selected.url,image.url); assert.deepEqual(selected.variants,image.variants);
  const options=(await db.query("select reloptions from pg_class where relname='games_catalog_v1'")).rows[0].reloptions;
  assert.equal(options.includes('security_invoker=true'),true);
 } finally {await db.close();}
});

test('animated PNG and WebP bypass Canvas and retain original delivery', async () => {
 const api=context({Uint8Array,DataView});
 const png=new Uint8Array(28); png.set([0,0,0,8,97,99,84,76],8);
 const webp=new Uint8Array(24); webp.set([65,78,73,77,4,0,0,0],12);
 assert.equal((await api.generate({type:'image/png',arrayBuffer:async()=>png.buffer})).length,0);
 assert.equal((await api.generate({type:'image/webp',arrayBuffer:async()=>webp.buffer})).length,0);
});
