import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
const source=await readFile(new URL('../supabase/functions/account-delete/index.ts',import.meta.url),'utf8');
const js=ts.transpileModule(source.replace(/^import .*;\n/,''),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
const actor='00000000-0000-4000-8000-000000000001';
const target='00000000-0000-4000-8000-000000000002';
const receipt='00000000-0000-4000-8000-000000000003';
function fixture(options={}) {
 let handler; const calls=[];
 const token='header.'+btoa(JSON.stringify({aal:'aal1'}))+'.signature';
 const db={auth:{getUser:async()=>{calls.push('getUser');return options.invalid?{error:{},data:{user:null}}:{data:{user:{id:actor,email:'member@example.test',factors:options.mfa?[{status:'verified'}]:[]}}};},admin:{deleteUser:async(id,soft)=>{calls.push(['deleteUser',id,soft]);return {error:options.deleteError?{}:null};}}},
 rpc:async(name,args)=>{calls.push([name,args]);
   if(name==='snh_prepare_account_deletion')return options.denied?{error:{}}:{data:receipt};
   if(name==='snh_activate_account_deletion')return options.expired?{error:{}}:{data:target};
   if(name==='snh_account_deletion_request')return {data:{completed:!options.deleteError&&!options.incomplete}};
   throw Error('Unexpected RPC');}};
 const reauth={auth:{signInWithPassword:async credentials=>{calls.push(['reauth',credentials]);return options.badPassword?{error:{},data:{user:null}}:{data:{user:{id:options.otherUser?target:actor}}};},signOut:async o=>{calls.push(['signOut',o]);return {};}}};
 let created=0;
 new Function('Deno','createClient',js)({env:{get:k=>({SUPABASE_URL:'https://test.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'secret',ACCOUNT_DELETION_BILLING_MODE:options.billingMode}[k])},serve:f=>{handler=f;}},()=>++created===1?db:reauth);
 return {calls,request:(body,headers={Authorization:'Bearer '+token},method='POST')=>handler(new Request('https://edge.test',{method,headers,...(method==='POST'?{body:JSON.stringify(body)}:{})}))};
}
const valid={action:'prepare',password:'never-log-this',billingAcknowledged:true,confirmation:'DELETE',memberId:target,reason:'Requested removal'};
test('method, live identity, explicit payment acknowledgment, password and identity-bound fresh auth guard preparation',async()=>{
 for(const [opts,body,headers,status] of [[{},valid,{},401],[{invalid:true},valid,undefined,401],[{}, {...valid,billingAcknowledged:false},undefined,400],[{}, {...valid,confirmation:'yes'},undefined,400],[{badPassword:true},valid,undefined,403],[{otherUser:true},valid,undefined,403],[{mfa:true},valid,undefined,403],[{denied:true},valid,undefined,403],[{billingMode:'integrated'},valid,undefined,409]]) {
   const f=fixture(opts);assert.equal((await f.request(body,headers)).status,status);assert.ok(!f.calls.some(c=>Array.isArray(c)&&c[0]==='deleteUser'));
 }
 const f=fixture();assert.equal((await f.request({},undefined,'GET')).status,405);
 const p=fixture();assert.equal((await p.request(valid)).status,200);
 const rpc=p.calls.find(c=>Array.isArray(c)&&c[0]==='snh_prepare_account_deletion');assert.equal(rpc[1].p_actor,actor);assert.equal(rpc[1].p_member_id,target);
 assert.ok(p.calls.find(c=>Array.isArray(c)&&c[0]==='signOut'));
});
test('self path derives target from verified caller and does not accept actor or email overrides',async()=>{
 const f=fixture();await f.request({...valid,memberId:null,actorId:target,email:'attacker@example.test'});
 assert.deepEqual(f.calls.find(c=>Array.isArray(c)&&c[0]==='reauth')[1],{email:'member@example.test',password:valid.password});
 assert.deepEqual(f.calls.find(c=>Array.isArray(c)&&c[0]==='snh_prepare_account_deletion')[1],{p_actor:actor,p_member_id:null,p_reason:'Self-service account deletion'});
});
test('execution requires a receipt bound to caller; status works after self-deletion and exposes only outcome',async()=>{
 const denied=fixture({expired:true});assert.equal((await denied.request({action:'delete',receipt})).status,403);assert.ok(!denied.calls.some(c=>Array.isArray(c)&&c[0]==='deleteUser'));
 const f=fixture();const response=await f.request({action:'delete',receipt});assert.equal(response.status,200);assert.deepEqual(f.calls.find(c=>Array.isArray(c)&&c[0]==='deleteUser'),['deleteUser',target,false]);
 const status=fixture({invalid:true});assert.deepEqual(await (await status.request({action:'status',receipt},{})).json(),{ok:true,completed:true});assert.ok(!status.calls.includes('getUser'));
 const missing=fixture();assert.equal((await missing.request({action:'status',receipt:'guess'},{})).status,400);
 const error=fixture({deleteError:true});assert.equal((await error.request({action:'delete',receipt})).status,409);
 const unknown=fixture({incomplete:true});assert.equal((await unknown.request({action:'delete',receipt})).status,503);
});
