import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../assets/js/member-portal.js',import.meta.url),'utf8');
function fixture({failThumb=false,failFinalize=false,duplicate=false}={}) {
 const uploads=[],requests=[],progress=[];let conversions=0;
 class XHR {
  constructor(){this.upload={};}
  open(method,url){this.method=method;this.url=url;}
  setRequestHeader(name,value){this.header=[name,value];}
  send(blob){uploads.push([this.url,blob.size,this.method,this.header]);this.upload.onprogress({lengthComputable:true,loaded:blob.size/2,total:blob.size});
   if(this.url.endsWith('thumb')&&failThumb){failThumb=false;this.onerror();return;}
   this.status=duplicate?409:200;this.responseText=JSON.stringify({message:'The resource already exists'});this.onload();}
 }
 const window={SNHSiteAuth:{ROLE_GROUPS:{},ROLE_CATALOG:{}},location:{hash:''},SNH_CONFIG:{supabaseUrl:'https://test.invalid'},snhSupabase:{auth:{getSession:async()=>({data:{session:{access_token:'session'}}})}},SNHPhotoConversion:{convert:async()=>{conversions++;return ['web','thumb'].map(variant=>({variant,blob:new Blob(['webp'])}));}}};
 const fetch=async(url,opts)=>{
  requests.push([url,JSON.parse(opts.body)]);
  if(url.endsWith('photo-finalize')&&failFinalize){failFinalize=false;return {ok:false,status:503,json:async()=>({error:'Try again'})};}
  return {ok:true,json:async()=>url.endsWith('photo-upload-intent')?{ok:true,assetId:'same-asset',uploadToken:'token',expiresAt:new Date(Date.now()+3600000).toISOString(),uploads:['web','thumb'].map(variant=>({variant,signedUrl:'https://storage.invalid/'+variant}))}:{ok:true}};
 };
 vm.runInNewContext(source,{window,fetch,XMLHttpRequest:XHR,Blob,console});
 const job={onProgress:(label,value)=>progress.push([label,value])};
 return {job,uploads,requests,progress,get conversions(){return conversions;},upload:()=>window.SNHMemberPortal.photoUploadAndRegister('album',{name:'camera.png'},job)};
}
test('signed derivative uploads report byte progress and retry only the failed derivative',async()=>{
 const f=fixture({failThumb:true});await assert.rejects(f.upload(),/Connection interrupted/);await f.upload();
 assert.equal(f.conversions,1);assert.deepEqual(f.uploads.map(v=>v[0].split('/').pop()),['web','thumb','thumb']);
 assert.equal(f.requests.filter(v=>v[0].endsWith('photo-upload-intent')).length,1);
 assert.ok(f.uploads.every(v=>v[2]==='PUT'&&v[3][1]==='image/webp'));
 assert.ok(f.progress.some(v=>v[0]==='Uploading photo'&&v[1]===47.5));
 assert.ok(f.progress.some(v=>v[0]==='Uploading preview'&&v[1]===85));assert.equal(f.progress.at(-1)[1],100);
});
test('finalization retry reuses uploaded bytes and reservation',async()=>{
 const f=fixture({failFinalize:true});await assert.rejects(f.upload(),/Try again/);await f.upload();
 assert.equal(f.uploads.length,2);assert.equal(f.conversions,1);assert.equal(f.requests.filter(v=>v[0].endsWith('photo-upload-intent')).length,1);
 assert.equal(f.requests.filter(v=>v[0].endsWith('photo-finalize')).length,2);
});
test('lost upload responses recover insert-only conflicts through server finalization',async()=>{
 const f=fixture({duplicate:true});await f.upload();assert.equal(f.uploads.length,2);
 assert.equal(f.requests.at(-1)[0],'https://test.invalid/functions/v1/photo-finalize');
});
