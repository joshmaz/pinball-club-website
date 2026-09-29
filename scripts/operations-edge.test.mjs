import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { createClient } from '@supabase/supabase-js';
const sources = {};
for (const name of ['operations','notification-dispatch']) sources[name] = ts.transpileModule(
 await readFile(new URL(`../supabase/functions/${name}/index.ts`,import.meta.url),'utf8').then(s=>s.replace(/^import .*;\n/gm,'')),
 {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
function setup(t,name,options={}) {
 const calls=[]; let handler;
 const env={SUPABASE_URL:'https://test.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'private-key',
 MATCHPLAY_API_TOKEN:'private-token',NOTIFICATION_DISPATCH_SECRET:'private-dispatch',...options.env};
 const fakeFetch=async(input,init={})=>{
  const url=new URL(input); calls.push({url,init});
  if(url.pathname==='/auth/v1/user') return Response.json({id:'user'});
  if(url.pathname==='/rest/v1/members') return Response.json(options.denied ? [] : [{id:'member'}]);
  if(url.pathname==='/rest/v1/integration_status') return new Response(null,{status:201});
  if(url.pathname==='/rest/v1/rpc/snh_operations_dispatch_request') {
   assert.equal(init.headers.get('Authorization'),'Bearer user-session');
   return options.auditError ? Response.json({message:'failed'},{status:500}) : Response.json(null);
  }
  if(url.pathname==='/functions/v1/notification-dispatch') return Response.json({next:{body:'private-message'}});
  if(url.pathname==='/rest/v1/operations_job_runs') return init.method==='POST' ? Response.json({id:'run'}) : new Response(null,{status:204});
  if(url.pathname==='/rest/v1/notification_outbox') return Response.json([{id:'message',body:'private-message',subject:'Subject'}]);
  throw new Error('Unexpected fetch '+url);
 };
 t.mock.method(globalThis,'fetch',fakeFetch);
 new Function('Deno','createClient','getMatchplay',sources[name])(
 {env:{get:k=>env[k]},serve:fn=>{handler=fn;}},
 (url,key,opts)=>createClient(url,key,{...opts,global:{...opts?.global,fetch:fakeFetch}}),
 async()=>{if(options.providerFails) throw new Error('private-token');return {data:{userId:123}};});
 return {calls,request: (body,headers={Authorization:'Bearer user-session'})=>handler(new Request('https://function.test',{
 method:'POST',headers,body:JSON.stringify(body)}))};
}
test('Operations rejects non-admins before configuration or tests',async t=>{
 const f=setup(t,'operations',{denied:true});
 assert.equal((await f.request({action:'test_matchplay'})).status,403);
 assert.equal(f.calls.length,2);
});
test('configuration contains booleans, no credentials',async t=>{
 const f=setup(t,'operations'); const response=await f.request({action:'configuration'});
 assert.equal(response.status,200); const body=await response.text(); assert.ok(!body.includes('private-'));
});
test('connection test records safe success and error without returning provider data',async t=>{
 const f=setup(t,'operations',{providerFails:true}); const response=await f.request({action:'test_matchplay'});
 assert.equal((await response.json()).ok,false);
 const updates=f.calls.filter(c=>c.url.pathname.endsWith('integration_status')).map(c=>JSON.parse(c.init.body));
 assert.ok(updates[0].last_attempt_at); assert.equal(updates[1].last_error,'Connection test failed');
});
test('dispatch fails closed if actor audit fails',async t=>{
 const f=setup(t,'operations',{auditError:true}); assert.equal((await f.request({action:'dispatch'})).status,503);
 assert.ok(!f.calls.some(c=>c.url.pathname.includes('/functions/')));
});
test('dispatch audits actor before invoking worker and discards preview body',async t=>{
 const f=setup(t,'operations'); const response=await f.request({action:'dispatch'});
 assert.equal(response.status,200); assert.ok(!(await response.text()).includes('private-message'));
 assert.ok(f.calls.findIndex(c=>c.url.pathname.includes('/rpc/'))<f.calls.findIndex(c=>c.url.pathname.includes('/functions/')));
});
test('dispatcher records preview completion without consuming queue or retaining message body',async t=>{
 const f=setup(t,'notification-dispatch');
 assert.equal((await f.request({},{})).status,401);
 const response=await f.request({}, {'x-notification-secret':'private-dispatch'}); assert.equal(response.status,200);
 const finish=f.calls.find(c=>c.init.method==='PATCH');
 const row=JSON.parse(finish.init.body); assert.equal(row.status,'succeeded'); assert.equal(row.result.mode,'preview');
 assert.ok(!finish.init.body.includes('private-message'));
 assert.ok(!f.calls.some(c=>c.url.pathname.includes('snh_claim_notification')));
});
