import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import ts from 'typescript';
const source=await readFile(new URL('../supabase/functions/publishing-discord-dispatch/index.ts',import.meta.url),'utf8');
const js=ts.transpileModule(source.replace(/^import .*;\n/gm,'').replace(/^export /gm,''),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
function fixture(options={}){
 let handler,protectedCalls=0;const requests=[];
 const env={SUPABASE_URL:'https://stage.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'test-service',SUPABASE_ANON_KEY:'test-public',PUBLISHING_SITE_URL:'https://stage.example',PUBLISHING_DISPATCH_SECRET:'scheduler',...options.env};
 const fakeDb={auth:{getUser:async()=>options.invalid?{error:{message:'invalid'},data:{}}:{data:{user:{id:'actor'}}}},
  rpc:async(name,args)=>{if(name==='snh_member_has_publishing_access')return {data:!!options.allowed};protectedCalls++;if(name==='snh_claim_publishing_discord')return {data:null};return {data:true};},
  from:()=>({upsert:async()=>{protectedCalls++;return {error:null};}})};
 const fakeFetch=async(url,init)=>{requests.push({url,init});return Response.json({guild_id:'1473002560511021298',channel_id:options.wrongChannel?'1561436651136483338':'1561436946780135464'});};
 const helpers=new Function('Deno','createClient','fetch',js+'\nreturn {deliver,discordPayload};')({env:{get:k=>env[k]},serve:fn=>{handler=fn;}},()=>fakeDb,fakeFetch);
 return {helpers,handler,requests,get protectedCalls(){return protectedCalls;}};
}
const job={entry_id:'abc',snapshot:{title:'News',body:'Hello @everyone'},message_id:null};
test('Discord posts are linked, mention-safe, and distinguish ambiguous creation from safe edit retries',async()=>{
 const {helpers}=fixture();const payload=helpers.discordPayload(job,'https://stage.example');
 assert.deepEqual(payload.allowed_mentions,{parse:[]});assert.equal(payload.embeds[0].url,'https://stage.example/announcements.html?id=abc');
 let request;
 let result=await helpers.deliver(job,'https://discord.com/api/webhooks/123/token','https://stage.example',async(url,init)=>{request={url,init};return Response.json({id:'1561436651136483001',channel_id:'1561436946780135464'});});
 assert.equal(result.status,'shared');assert.match(request.url,/wait=true$/);assert.equal(request.init.method,'POST');
 result=await helpers.deliver(job,'webhook','site',async()=>{throw Error('SECRET TOKEN');});assert.equal(result.status,'uncertain');assert.ok(!JSON.stringify(result).includes('SECRET'));
 result=await helpers.deliver(job,'webhook','site',async()=>new Response('',{status:429}));assert.equal(result.status,'failed');
 result=await helpers.deliver(job,'webhook','site',async()=>new Response('',{status:502}));assert.equal(result.status,'uncertain');
 result=await helpers.deliver({...job,message_id:'existing'},'webhook','site',async(url,init)=>{assert.equal(init.method,'PATCH');return new Response('',{status:502});});assert.equal(result.status,'failed');
 const withdrawn=helpers.discordPayload({...job,snapshot:null},'site');assert.equal(withdrawn.embeds[0].title,'Announcement withdrawn');assert.equal(withdrawn.embeds[0].url,undefined);
});
test('worker checks live user authorization before protected work and preview never sends',async()=>{
 for(const options of [{invalid:true},{allowed:false},{allowed:true}]){
  const f=fixture(options),r=await f.handler(new Request('https://function.example',{method:'POST',headers:{authorization:'Bearer user'}}));
  assert.equal(r.status,options.invalid?401:options.allowed?200:403);assert.equal(f.protectedCalls,0);assert.equal(f.requests.length,0);
 }
});
test('live worker validates the exact configured staging destination before claims',async()=>{
 const env={PUBLISHING_DISCORD_MODE:'live',PUBLISHING_DISCORD_WEBHOOK:'https://discord.com/api/webhooks/1561436651136483001/fake-token',PUBLISHING_DISCORD_GUILD_ID:'1473002560511021298',PUBLISHING_DISCORD_CHANNEL_ID:'1561436946780135464'};
 const f=fixture({env,wrongChannel:true});const r=await f.handler(new Request('https://function.example',{method:'POST',headers:{'x-publishing-secret':'scheduler'}}));assert.equal(r.status,409);assert.equal(f.protectedCalls,0);
 const good=fixture({env});const response=await good.handler(new Request('https://function.example',{method:'POST',headers:{'x-publishing-secret':'scheduler'}}));assert.equal(response.status,200);assert.equal(good.protectedCalls,2);
});

test('explicit preview origins are allowed without changing canonical message links',async()=>{
 const preview='https://deploy-preview-132--snhpinballclub-staging.netlify.app';
 for(const origin of [preview,'https://evil.example','https://deploy-preview-132--snhpinballclub-staging.netlify.app.evil.example','null']){
  const f=fixture({env:{PUBLISHING_ALLOWED_ORIGINS:preview}});
  const response=await f.handler(new Request('https://function.example',{method:'OPTIONS',headers:{Origin:origin}}));
  assert.equal(response.headers.get('Access-Control-Allow-Origin'),origin===preview?preview:null);
  assert.equal(f.protectedCalls,0);
  assert.equal(f.helpers.discordPayload(job,'https://stage.example').embeds[0].url,'https://stage.example/announcements.html?id=abc');
 }
 const unconfigured=fixture();const response=await unconfigured.handler(new Request('https://function.example',{method:'OPTIONS',headers:{Origin:preview}}));
 assert.equal(response.headers.get('Access-Control-Allow-Origin'),null,'previews are opt-in');
});
