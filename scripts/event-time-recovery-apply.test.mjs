import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
const script=new URL('./apply-event-time-recovery.mjs',import.meta.url);
for(const scenario of ['apply','changed','concurrent','dry-run']) test(`recovery safely handles ${scenario}`,async t=>{
 const dir=await mkdtemp(path.join(tmpdir(),'event-recovery-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const id='21c40393-4962-4b98-ad70-9655ba6601fe';
 const proposal={source_checked_at:'2026-09-25T12:00:00Z',proposed:[{id,title:'Test event',expected_starts_at:'2016-01-30T00:00:00Z',proposed_starts_at:'2016-01-30T17:00:00Z',basis:'Verified source'}]};
 await writeFile(path.join(dir,'proposal.json'),JSON.stringify(proposal));
 await writeFile(path.join(dir,'mock.mjs'),`
 import assert from 'node:assert/strict';
 const row={id:${JSON.stringify(id)},title:'Test event',starts_at:'2016-01-30T00:00:00Z',updated_at:${JSON.stringify(scenario==='changed'?'2026-09-25T13:00:00Z':'2026-09-24T12:00:00Z')},description:'Keep me',published:true};
 globalThis.fetch=async(url,options)=>{
  const q=new URL(url).searchParams;
  assert.equal(q.get('id'),'eq.'+row.id);
  if(options.method==='PATCH'){
   assert.equal(q.get('starts_at'),'eq.'+row.starts_at);
   assert.equal(q.get('updated_at'),'eq.'+row.updated_at);
   assert.deepEqual(JSON.parse(options.body),{starts_at:'2016-01-30T17:00:00Z'});
   return {ok:true,json:async()=>${scenario==='concurrent'?'[]':"[{...row,starts_at:'2016-01-30T17:00:00Z'}]"}};
  }
  return {ok:true,json:async()=>[row]};
 };
 `);
 const journal=path.join(dir,'journal');
 const result=spawnSync(process.execPath,['--import',path.join(dir,'mock.mjs'),script.pathname,path.join(dir,'proposal.json'),journal,...(scenario==='dry-run'?[]:['--apply'])],{encoding:'utf8',env:{...process.env,SUPABASE_URL:'https://example.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'test-only'}});
 assert.equal(result.status,0,result.stderr);
 const backup=JSON.parse(await readFile(journal+'.backup.json','utf8'));
 assert.equal(backup.ready.length,scenario==='changed'?0:1);
 if(scenario==='dry-run') await assert.rejects(readFile(journal),{code:'ENOENT'});
 else {
  const lines=(await readFile(journal,'utf8')).trim();
  if(scenario==='changed') assert.equal(lines,'');
  else assert.equal(JSON.parse(lines).status,scenario==='concurrent'?'skipped_concurrent_change':'applied');
 }
});
