import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { createClient } from '@supabase/supabase-js';
import { createHash, timingSafeEqual } from 'node:crypto';
const compile = async path => ts.transpileModule((await readFile(new URL(path,import.meta.url),'utf8')).replace(/^import .*;\n/gm,'').replace(/^export /gm,''),
 {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
const auth = new Function('createHash','timingSafeEqual',await compile('../supabase/functions/pinballmap-ingest/auth.ts')+'; return { authorizeIngest, ingestMethodResponse };')(createHash,timingSafeEqual);
const code = await compile('../supabase/functions/pintips-import/index.ts');
function setup(options={}) {
 let handler; const calls=[];
 const env = { SUPABASE_URL:'https://test.supabase.co', SUPABASE_SERVICE_ROLE_KEY:'private-key',SUPABASE_ANON_KEY:'public-key',PINTIPS_IMPORT_SCHEDULER_SECRET:'pintips-test-secret' };
 const fakeFetch = async (input,init) => {
  const url=new URL(input); calls.push(url.pathname);
  if(url.pathname==='/auth/v1/user') return options.badToken ? Response.json({message:'bad token'},{status:401}) : Response.json({id:'00000000-0000-0000-0000-000000000001'});
  if(url.pathname.endsWith('/snh_member_has_games_admin_access')) {
    assert.equal(init.headers.get('Authorization'),'Bearer user-token');
    return Response.json(options.allowed===true);
  }
  if(url.pathname.endsWith('/snh_pintips_begin')) {
    const body=JSON.parse(init.body); assert.equal(body.p_actor,options.scheduler ? null : '00000000-0000-0000-0000-000000000001');
    return Response.json(options.busy ? null : '00000000-0000-0000-0000-000000000010');
  }
  if(url.pathname.endsWith('/snh_pintips_finish')) return options.dbError ? Response.json({message:'private db details'},{status:500}) : Response.json({tips:1});
  if(url.pathname.endsWith('/snh_pintips_fail')) return Response.json(null);
  throw new Error('Unexpected call '+url.pathname);
 };
 new Function('Deno','createClient','authorizeIngest','ingestMethodResponse','downloadTips',code)(
 {env:{get:k=>env[k]},serve:fn=>{handler=fn;}},
 (url,key,opts)=>createClient(url,key,{...opts,global:{...opts.global,fetch:fakeFetch}}),auth.authorizeIngest,auth.ingestMethodResponse,
 async()=> {calls.push('download'); if(options.downloadFails) throw Error('Invalid PinTips export. Check format.'); return [{tip_id:1}]; });
 return { calls, request:(headers={Authorization:'Bearer user-token'},method='POST')=>handler(new Request('https://example.test',{method,headers})) };
}
test('only verified Games Admin capability or the dedicated scheduler secret reaches download',async()=> {
 for(const options of [{},{allowed:false},{badToken:true,allowed:true}]) {
  const f=setup(options); assert.ok([401,403].includes((await f.request()).status)); assert.ok(!f.calls.includes('download'));
 }
 for(const headers of [{},{apikey:'public-key'},{'x-pintips-scheduler-secret':'wrong',Authorization:'Bearer user-token'},
 {'x-pintips-scheduler-secret':'',Authorization:'Bearer user-token'},{'x-pinballmap-scheduler-secret':'pintips-test-secret'}]) {
  const f=setup({allowed:true}); assert.equal((await f.request(headers)).status,401); assert.ok(!f.calls.includes('download'));
 }
 for(const scheduler of [true,false]) {
  const f=setup({allowed:true,scheduler});
  assert.equal((await f.request(scheduler ? {'x-pintips-scheduler-secret':'pintips-test-secret'} : undefined)).status,200);
  assert.equal(f.calls.filter(x=>x==='download').length,1);
  assert.ok(f.calls.includes('/rest/v1/rpc/snh_pintips_finish'));
 }
});
test('preflight and unsupported methods cannot import; active lease avoids redundant CDN requests',async()=>{
 const f=setup({allowed:true,busy:true});
 assert.equal((await f.request({},'OPTIONS')).status,200); assert.equal((await f.request({},'GET')).status,405); assert.equal(f.calls.length,0);
 assert.equal((await f.request()).status,409); assert.ok(!f.calls.includes('download'));
});
test('failed downloads do not publish and database failures are recorded without private details',async()=>{
 for(const options of [{downloadFails:true},{dbError:true}]) {
  const f=setup({allowed:true,...options}); const res=await f.request(); assert.equal(res.status,503);
  assert.ok(!(await res.text()).includes('private db'));
  assert.ok(f.calls.includes('/rest/v1/rpc/snh_pintips_fail'));
  if(options.downloadFails) assert.ok(!f.calls.includes('/rest/v1/rpc/snh_pintips_finish'));
 }
});
