import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import ts from 'typescript';
const source=await readFile(new URL('../supabase/functions/publishing-media/index.ts',import.meta.url),'utf8');
const js=ts.transpileModule(source.replace(/^import .*;\n/gm,''),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
function fixture({invalid=false,allowed=true,stale=false}={}){
 let handler;const calls=[];const id='00000000-0000-4000-8000-000000000001';
 const client={auth:{getUser:async()=>({error:invalid?{}:null,data:{user:invalid?null:{id:'actor'}}})},rpc:async(name,args)=>{calls.push({name,args});return {data:name==='snh_member_has_publishing_access'?allowed:name==='snh_publishing_activities'?[{id,version:3,draft:{image_id:id}}]:name==='snh_publishing_images'?[{id,state:'ready'}]:name==='snh_publishing_activity_write'?{id}:null};},storage:{from:bucket=>({list:async()=>{calls.push({bucket,action:'list'});return {data:[]};},download:async()=>{calls.push({bucket,action:'download'});return {data:new Blob(['webp'])};},upload:async()=>{calls.push({bucket,action:'upload'});return {};}})}};
 const check=r=>{if(r.error)throw new Error('Operation failed');};
 new Function('Deno','createClient','json','preflight','check','uuid','webpDimensions',js)({env:{get:()=> 'configured'},serve:f=>handler=f},()=>client,(body,status=200)=>Response.json(body,{status}),()=>new Response(null,{status:204}),check,x=>x,()=>({width:100,height:100}));
 return {calls,id,invoke:body=>handler(new Request('https://function.example',{method:'POST',headers:{authorization:'Bearer user','content-type':'application/json'},body:JSON.stringify(body)}))};
}
test('media worker rejects unauthenticated and non-publishing callers before accessing storage',async()=>{
 for(const options of [{invalid:true},{allowed:false}]){const f=fixture(options);const r=await f.invoke({action:'library'});assert.equal(r.status,options.invalid?401:403);assert.ok(!f.calls.some(x=>x.bucket));}
});
test('stale publish does not expose a private image',async()=>{const f=fixture();const r=await f.invoke({action:'publish',id:f.id,version:2});assert.equal(r.status,400);assert.ok(!f.calls.some(x=>x.bucket));});
test('publication copies the private derivative before committing a versioned public snapshot',async()=>{
 const f=fixture(),r=await f.invoke({action:'publish',id:f.id,version:3});assert.equal(r.status,200);
 const upload=f.calls.findIndex(x=>x.action==='upload'),commit=f.calls.findIndex(x=>x.name==='snh_publishing_activity_write'&&x.args.p_action==='publish');assert.ok(upload>=0&&upload<commit);assert.equal(f.calls[commit].args.p_version,3);
});
