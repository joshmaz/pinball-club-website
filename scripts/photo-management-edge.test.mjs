import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
const read = file => readFile(new URL('../' + file, import.meta.url), 'utf8');
const transpile = source => ts.transpileModule(source.replace(/^import .*?;\s*$/gm,'').replace(/^export /gm,''),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
const shared = transpile(await read('supabase/functions/_shared/photo-v2.ts'));
const sources = Object.fromEntries(await Promise.all(['photo-upload-intent','photo-finalize','photo-publish','photo-purge'].map(async name=>[name,transpile(await read(`supabase/functions/${name}/index.ts`))])));
const assetId='00000000-0000-0000-0000-000000000100',albumId='00000000-0000-0000-0000-000000000200',token='00000000-0000-0000-0000-000000000300';
function webp(width=1920,height=1280,extra) {
 const bytes=new Uint8Array(extra?40:30),v=new DataView(bytes.buffer);
 const put=(p,s)=>bytes.set([...s].map(c=>c.charCodeAt(0)),p);
 put(0,'RIFF');v.setUint32(4,bytes.length-8,true);put(8,'WEBP');put(12,'VP8 ');v.setUint32(16,10,true);
 put(23,'\x9d\x01\x2a');v.setUint16(26,width,true);v.setUint16(28,height,true);
 if(extra){put(30,extra);v.setUint32(34,2,true);}
 return bytes;
}
function fixture(name,options={}) {
 let handler;const calls=[];
 const a={id:assetId,album_id:albumId,scope_type:'club',scope_id:'snh',upload_mode:'browser',upload_token:token,
  upload_revision:4,status:name==='photo-finalize'?'pending':'uploaded',upload_expires_at:new Date(Date.now()+3600000).toISOString(),...options.asset};
 const user={auth:{getUser:async()=>options.invalid?{error:{message:'bad'},data:{user:null}}:{data:{user:{id:assetId}},error:null}},
  rpc:async(name,args)=>{calls.push(['user-rpc',name,args]);return {data:options.denied?false:true,error:null};}};
 const admin={rpc:async(name,args)=>{
  calls.push(['admin-rpc',name,args]);
  if(name==='snh_photo_browser_intent')return {data:{assetId,uploadToken:token,prefix:`club/snh/${albumId}/${assetId}`,expiresAt:a.upload_expires_at},error:null};
  if(name==='snh_photo_cleanup_list')return {data:[{id:1,bucket:'photos-public',object_key:'old-public.webp'}],error:null};
  if(options.commitFail && name==='snh_photo_browser_commit')return {error:{message:'state changed'}};
  return {data:null,error:null};
 },from:table=>({select:()=>({eq:()=>({maybeSingle:async()=>({data:a,error:null}),eq:async()=>({data:[{variant:'web'}],error:null})})})}),
 storage:{from:bucket=>({
  createSignedUploadUrl:async(key,opts)=>{calls.push(['signed-upload',bucket,key,opts]);return {data:{token:'signed',signedUrl:'https://storage.test'},error:null};},
  createSignedUrl:async(key,ttl)=>{calls.push(['signed-read',bucket,key,ttl]);return {data:{signedUrl:'https://private.test'},error:null};},
  download:async key=>{calls.push(['download',bucket,key]);return {data:new Blob([options.bytes || webp(key.includes('thumb')?640:1920,key.includes('thumb')?427:1280)]),error:null};},
  upload:async(key,bytes,opts)=>{calls.push(['upload',bucket,key,opts]);return options.uploadFail?{error:{message:'upload unavailable'}}:{error:null};},
  remove:async keys=>{calls.push(['remove',bucket,keys]);return options.removeFail?{error:{message:'storage offline'}}:{data:keys,error:null};}
 })}};
 const createClient=(_url,key)=>key==='anon'?user:admin;
 const deno={env:{get:key=>({SUPABASE_URL:'https://test.supabase.co',SUPABASE_ANON_KEY:'anon',SUPABASE_SERVICE_ROLE_KEY:'service'})[key]},serve:fn=>{handler=fn;}};
 new Function('Deno','createClient',shared+'\n'+sources[name])(deno,createClient);
 return {calls,request:async(body={},headers={Authorization:'Bearer session'},method='POST')=>{
  const response=await handler(new Request('https://edge.test',{method,headers,...(method==='POST'?{body:JSON.stringify(body)}:{})}));
  return {status:response.status,body:method==='OPTIONS'?null:await response.json()};
 }};
}
test('all photo functions authenticate and enforce roles before service work',async()=>{
 for(const name of Object.keys(sources)) {
  const body=name==='photo-purge'?{action:'cleanup'}:{albumId,assetId,uploadToken:token,contentType:'image/webp'};
  for(const options of [{},{invalid:true},{denied:true}]) {
   const f=fixture(name,options),r=await f.request(body,options.invalid||options.denied?{Authorization:'Bearer session'}:{});
   assert.equal(r.status,options.denied?403:401,name);
   assert.equal(f.calls.some(c=>c[0].startsWith('admin')||['download','upload','remove','signed-read','signed-upload'].includes(c[0])),false,name);
  }
  const f=fixture(name);assert.equal((await f.request({}, {},'OPTIONS')).status,200);assert.equal((await f.request({}, {},'GET')).status,405);
 }
});
test('upload intent only reserves WebP derivatives and insert-only private URLs',async()=>{
 const f=fixture('photo-upload-intent');assert.equal((await f.request({albumId,contentType:'image/jpeg'})).status,400);
 assert.equal((await f.request({albumId,contentType:'image/webp',originalFilename:'camera.jpg'})).status,200);
 const signed=f.calls.filter(c=>c[0]==='signed-upload');assert.equal(signed.length,2);
 assert.ok(signed.every(c=>c[1]==='photos-private' && c[2].endsWith('.webp') && c[3].upsert===false));
});
test('finalization checks WebP bytes, size/dimensions and metadata before recording',async()=>{
 for(const bytes of [new Uint8Array([1,2,3]),webp(1921,100),webp(100,100,'EXIF'),webp(100,100,'XMP '),webp(100,100,'ANIM'),new Uint8Array(8388609)]) {
  const f=fixture('photo-finalize',{bytes});assert.equal((await f.request({assetId,uploadToken:token})).status,400);
  assert.equal(f.calls.some(c=>c[1]==='snh_photo_browser_commit'),false);
 }
 const f=fixture('photo-finalize');assert.equal((await f.request({assetId,uploadToken:token})).status,200);
 const commit=f.calls.find(c=>c[1]==='snh_photo_browser_commit')[2];assert.equal(commit.p_revision,4);assert.equal(commit.p_variants.length,2);
 assert.equal(commit.p_variants[0].contentHash.length,64);
 const lost=fixture('photo-finalize',{asset:{status:'uploaded'}});assert.equal((await lost.request({assetId,uploadToken:token})).status,200);assert.equal(lost.calls.some(c=>c[0]==='download'),false);
});
test('publication queues paths before writes, validates staged bytes, and commits with revision',async()=>{
 const f=fixture('photo-publish');assert.equal((await f.request({assetId})).status,200);
 const uploads=f.calls.filter(c=>c[0]==='upload');assert.equal(uploads.length,2);
 assert.ok(uploads.every(c=>c[1]==='photos-public' && c[3].contentType==='image/webp' && c[3].upsert===false));
 assert.ok(f.calls.findIndex(c=>c[1]==='snh_photo_queue_storage')<f.calls.findIndex(c=>c[0]==='upload'));
 assert.equal(f.calls.find(c=>c[1]==='snh_photo_browser_commit')[2].p_revision,4);
 for(const options of [{uploadFail:true},{commitFail:true}]) {
  const failed=fixture('photo-publish',options);assert.equal((await failed.request({assetId})).body.ok,false);
  assert.ok(failed.calls.some(c=>c[1]==='snh_photo_queue_storage'),'failed storage remains tracked');
 }
});
test('legacy originals are read only through authorized browser conversion; no server codec',async()=>{
 const f=fixture('photo-publish',{asset:{upload_mode:'legacy',original_object_key:'retained/original.jpg',original_content_type:'image/jpeg'}});
 assert.equal((await f.request({assetId,action:'source'})).status,200);
 assert.equal(f.calls.some(c=>c[0]==='download'||c[0]==='upload'),false);
 assert.ok(f.calls.find(c=>c[0]==='signed-read')[2].endsWith('original.jpg'));
 assert.doesNotMatch(await read('supabase/functions/photo-publish/index.ts'),/imagescript|encodeJPEG|decodeImage/);
});
test('purge persists storage failure and reports queued cleanup; album deletion uses RPC',async()=>{
 const f=fixture('photo-purge',{removeFail:true}),r=await f.request({albumId,action:'album-delete'});
 assert.equal(r.status,200);assert.equal(r.body.cleanupPending,true);
 assert.ok(f.calls.some(c=>c[1]==='snh_photo_album_delete'));
 assert.equal(f.calls.find(c=>c[1]==='snh_photo_cleanup_ack')[2].p_error,'storage offline');
});
