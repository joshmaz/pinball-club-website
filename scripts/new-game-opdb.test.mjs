import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
const read = path => readFile(new URL('../' + path, import.meta.url), 'utf8');
const source = await read('supabase/functions/_shared/opdb-images.ts');
const code = ts.transpileModule(source.replace(/^export /gm, ''), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;
const { matchNewGameToOpdb, prepareNewGameOpdbImports, entriesByOpdbId } = new Function(
  code + '\nreturn {matchNewGameToOpdb,prepareNewGameOpdbImports,entriesByOpdbId};')();
const machine = (id, fields = {}) => ({opdbId:id, name:'Test Game', ipdbId:42,
  manufacturer:{name:'Stern'}, manufactureDate:'2020-01-01', images:[], ...fields});
const games = values => new Map(values.map(e => [e.opdbId,e]));
const game = fields => ({title:'Test Game',manufacturer:'Stern',releaseDate:'2020-01-01',...fields});

test('identifier matching resolves exact machines, aliases and group hints without arbitrary editions', () => {
  const entry=machine('Gtest-Mone'), alias=machine('Gtest-Mone-Ale',{name:'Test Game (LE)',ipdbId:43});
  const entries=games([entry,alias,machine('Gtest-Mtwo',{name:'Test Game (Pro)',ipdbId:44})]);
  assert.equal(matchNewGameToOpdb(game({opdbId:entry.opdbId}),entries).entry,entry);
  assert.equal(matchNewGameToOpdb(game({opdbId:alias.opdbId,ipdbUrl:'https://www.ipdb.org/machine.cgi?id=43'}),entries).entry,alias);
  assert.equal(matchNewGameToOpdb(game({opdbId:'Gtest',ipdbUrl:'https://www.ipdb.org/machine.cgi?id=43'}),entries).entry,alias);
  assert.equal(matchNewGameToOpdb(game({ipdbUrl:'https://www.ipdb.org/machine.cgi?id=44'}),entries).entry.opdbId,'Gtest-Mtwo');
  assert.equal(matchNewGameToOpdb(game({opdbId:'Gtest-Mtwo',ipdbUrl:'https://www.ipdb.org/machine.cgi?id=43'}),entries).status,'unmatched','conflicting IDs never match across editions');
  assert.equal(matchNewGameToOpdb(game({opdbId:'Gtest',title:'Unknown'}),entries).status,'unmatched');
  assert.equal(matchNewGameToOpdb(game({opdbId:'Gtest'}),games([entry])).entry,entry,'a group with only one export record is safe');
  assert.equal(matchNewGameToOpdb(game({opdbId:'Gone-Mone',ipdbUrl:'https://www.ipdb.org/machine.cgi?id=42'}),games([machine('Gone-Mone',{ipdbId:null})])).via,'pinballmap_opdb_id','an exact supplied OPDB ID remains authoritative when its IPDB field is absent');
});

test('metadata fallback is exact and requires manufacturer/year; duplicate candidates remain ambiguous', () => {
  const entry=machine('Gtest-Mone');
  assert.equal(matchNewGameToOpdb(game({title:'  TEST   GAME  '}),games([entry])).entry,entry);
  for (const fields of [{title:'Test Game LE'},{manufacturer:'Other'},{releaseDate:'2021-01-01'},
    {manufacturer:''},{releaseDate:null},{title:'Test Gam'}]) {
    assert.equal(matchNewGameToOpdb(game(fields),games([entry])).status,'unmatched');
  }
  const dup=machine('Gtest-Mtwo');
  assert.equal(matchNewGameToOpdb(game({}),games([entry,dup])).status,'ambiguous');
  assert.equal(matchNewGameToOpdb(game({ipdbUrl:'https://www.ipdb.org/machine.cgi?id=42'}),games([entry,dup])).status,'ambiguous');
  assert.equal(matchNewGameToOpdb(game({opdbId:entry.opdbId,ipdbUrl:'https://www.ipdb.org/machine.cgi?id=42'}),games([entry,dup])).entry,entry,'exact supplied ID disambiguates duplicate IPDB IDs');
});

test('real checked-in OPDB export resolves representative IPDB, full-ID and group-ID records', async () => {
  const entries=entriesByOpdbId(JSON.parse(await read('data/latest-opdb.json')));
  const catacomb=[...entries.values()].find(e=>e.name==='Catacomb' && e.ipdbId===469);
  assert.ok(catacomb?.images.length);
  for (const hint of [undefined, catacomb.opdbId, catacomb.opdbId.split('-')[0]]) {
    const result=matchNewGameToOpdb(game({title:'Catacomb',opdbId:hint,ipdbUrl:'https://www.ipdb.org/machine.cgi?id=469'}),entries);
    assert.equal(result.entry.opdbId,catacomb.opdbId);
  }
  const alias=[...entries.values()].find(e=>String(e.opdbId).includes('-A') && e.ipdbId);
  assert.ok(alias);
  assert.equal(matchNewGameToOpdb(game({opdbId:alias.opdbId,ipdbUrl:`https://www.ipdb.org/machine.cgi?id=${alias.ipdbId}`}),entries).entry.opdbId,alias.opdbId);
});

test('new-game preparation fetches once, carries exact-entry provenance, and reports unmatched/image-less outcomes', async () => {
  const oldFetch=globalThis.fetch;let calls=0;
  globalThis.fetch=async url => { calls++;assert.equal(url,'https://mp-data.sfo3.cdn.digitaloceanspaces.com/latest-opdb.json');return Response.json({machines:[
    machine('Gtest-Mone',{images:[{group:'photo',type:'playfield',urls:{large:'https://img.opdb.org/play.jpg'}}]}),
    machine('Gnone-Mone',{name:'No Photo',ipdbId:99}),
  ]});};
  try {
    const creates=[game({slug:'new-game',opdbId:'Gtest'}),game({slug:'unknown',title:'Unknown'}),game({slug:'empty',opdbId:'Gnone-Mone'})];
    const summary=await prepareNewGameOpdbImports(creates);
    assert.equal(calls,1);assert.equal(summary.matched,2);assert.deepEqual(summary.unmatched,['unknown']);assert.deepEqual(summary.withoutImages,['empty']);
    assert.equal(creates[0].opdbId,'Gtest-Mone');assert.equal(creates[0].opdbImages[0].sourceUrl,'https://app.matchplay.events/opdb/entries/Gtest-Mone');
    assert.equal(creates[0].opdbImages[0].metadata.rightsReviewed,false);
    assert.deepEqual(creates[1].opdbImages,[]);assert.equal(creates[1].opdbId,undefined);
    await prepareNewGameOpdbImports([]);assert.equal(calls,1,'no new games needs no export');
    globalThis.fetch=async()=>Response.json({}, {status:503});
    await assert.rejects(prepareNewGameOpdbImports([game({})]),/503/);
    globalThis.fetch=async()=>Response.json({machines:[]});
    await assert.rejects(prepareNewGameOpdbImports([game({})]),/did not contain/);
  } finally {globalThis.fetch=oldFetch;}
});

const edgeCode = ts.transpileModule((await read('supabase/functions/pinballmap-ingest/index.ts'))
  .replace(/^import[\s\S]*?from\s+"[^"]+";\s*/gm, ''), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;
function ingestFixture({creates=[],updates=[],providerFails=false}={}) {
  let handler;const calls=[];
  const fakeFetch=async url=>{
    if (String(url).includes('latest-opdb.json')) {
      calls.push({kind:'export'});
      if (providerFails) return Response.json({}, {status:503});
      return Response.json({machines:[machine('Gtest-Mone',{images:[{group:'play',type:'playfield',urls:{large:'https://img.opdb.org/play.jpg'}}]})]});
    }
    return Response.json({user_submissions:[],machines:[]});
  };
  const helpers=new Function('fetch',code+'\nreturn {prepareNewGameOpdbImports,importOpdbImages};')(fakeFetch);
  const client={
    from:()=>({select:async()=>({data:[],error:null}),insert:async()=>({error:null})}),
    rpc:async(name,args)=>{calls.push({kind:'rpc',name,args});return {data:name==='snh_pinballmap_begin'?'run-1':name==='snh_pinballmap_import_images'?1:{ok:true},error:null};}
  };
  const env={SUPABASE_URL:'https://test.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'service-key',PINBALLMAP_API_TOKEN:'token'};
  new Function('Deno','createClient','fetch','authorizeIngest','ingestMethodResponse','buildPinballRpcPayload',
    'buildPinballConditionPayload','prepareNewGameOpdbImports','importOpdbImages',edgeCode)(
    {env:{get:key=>env[key]},serve:fn=>{handler=fn;}},()=>client,fakeFetch,
    async()=>({ok:true,manualActorUserId:null}),()=>null,
    ()=>({location_id:8908,location_address:'Club',creates:structuredClone(creates),updates:structuredClone(updates)}),
    ()=>({rows:[]}),helpers.prepareNewGameOpdbImports,helpers.importOpdbImages);
  return {calls,run:()=>handler(new Request('https://test/ingest',{method:'POST'}))};
}

test('actual ingest handler prepares new photos before catalog RPC and records an actionable provider failure without catalog writes',async()=>{
  const f=ingestFixture({creates:[game({slug:'new',opdbId:'Gtest-Mone'})]});
  const response=await f.run();assert.equal(response.status,200);
  const result=await response.json();assert.equal(result.newGameOpdb.matched,1);
  const catalog=f.calls.find(c=>c.name==='snh_pinballmap_upsert_from_activity');
  assert.equal(catalog.args.p_payload.creates[0].opdbImages[0].imageType,'playfield');
  assert.ok(f.calls.findIndex(c=>c.kind==='export')<f.calls.indexOf(catalog));
  assert.ok(!f.calls.some(c=>c.name==='snh_pinballmap_import_images'),'new-game images are part of the catalog transaction only');
  const failed=ingestFixture({creates:[game({slug:'new'})],providerFails:true});
  const failure=await failed.run();assert.equal(failure.status,500);
  assert.match((await failure.json()).error,/no catalog changes saved; retry import/);
  assert.ok(!failed.calls.some(c=>c.name==='snh_pinballmap_upsert_from_activity'));
  assert.match(failed.calls.find(c=>c.name==='snh_pinballmap_finish').args.p_error,/no catalog changes saved/);
});

test('actual handler imports unmatched games with a review warning and keeps existing-only refresh best effort',async()=>{
  const unmatched=ingestFixture({creates:[game({slug:'unknown',title:'Unknown'})]});
  assert.equal((await unmatched.run()).status,200);
  assert.deepEqual(unmatched.calls.find(c=>c.name==='snh_pinballmap_upsert_from_activity').args.p_payload.creates[0].opdbImages,[]);
  assert.match(unmatched.calls.find(c=>c.name==='snh_pinballmap_finish').args.p_warning,/1 unmatched/);
  const existing=ingestFixture({updates:[game({slug:'old',opdbId:'Gtest-Mone'})],providerFails:true});
  assert.equal((await existing.run()).status,200);
  assert.ok(existing.calls.findIndex(c=>c.name==='snh_pinballmap_upsert_from_activity')<existing.calls.findIndex(c=>c.kind==='export'));
  assert.match(existing.calls.find(c=>c.name==='snh_pinballmap_finish').args.p_warning,/Catalog changes were retained/);
});
