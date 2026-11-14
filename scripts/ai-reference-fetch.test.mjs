import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = ts.transpileModule(
  (await readFile(new URL('../supabase/functions/ai-game-enrich-propose/index.ts', import.meta.url), 'utf8'))
    .replace(/^import .*;\n/gm, ''),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } },
).outputText;
const providerLinks = {
  IPDB: 'https://www.ipdb.org/machine.cgi?id=2697',
  Pinside: 'https://pinside.com/pinball/machine/gottlieb-2001',
  Kineticist: 'https://www.kineticist.com/games/pinball/2001-dimension-galaxie',
};
const html = '<title>Game &amp; history</title><h1>2001</h1><meta name="description" content="A pinball machine">';
function fixture(response = () => new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } })) {
  const calls=[];
  const functions = new Function('Deno', 'createClient', 'fetch', source +
    '\nreturn {researchUrl,fetchReferenceHtml,fetchReferenceEvidence,buildDescriptionResearchContext,referenceEvidence,operatorConfirmedSourceEvidence,buildLinkField,REFERENCE_MAX_BYTES};')(
    {serve() {}}, () => { throw new Error('No database calls expected'); }, async (url, init) => {
      calls.push({url,init});return response(url,init);
    });
  return {...functions,calls};
}

test('an exact IPDB mapping is proposed over a saved search URL without applying it automatically', () => {
  const f=fixture();
  const saved='https://www.ipdb.org/search.pl?searchtype=quick&searchstr=Aquarius';
  const direct='https://www.ipdb.org/machine.cgi?id=79';
  const field=f.buildLinkField('ipdbUrl',saved,{
    value:direct,
    reason:'Exact IPDB ID mapping from OPDB ID GreKP',
    sourceUrl:direct,
    score:0.99,
    warnings:[],
  });
  assert.equal(field.currentValue,saved);
  assert.equal(field.suggestedValue,direct);
  assert.equal(field.sourceUrl,direct);
  assert.equal(field.reviewRequired,true);
  assert.equal(field.applyByDefault,false);
  assert.match(field.warnings[0],/Saved URL: https:\/\/www\.ipdb\.org\/search\.pl/);
});

test('the fetch boundary accepts catalog/provider generators and rejects hostile or ambiguous destinations', async () => {
  const f=fixture();
  for (const [provider,url] of Object.entries(providerLinks)) {
    assert.ok(f.researchUrl(provider,url));
    const result=await f.fetchReferenceHtml(provider,url,new AbortController().signal);
    assert.equal(result.html,html);
  }
  assert.equal(f.calls.length,3);
  for (const {url,init} of f.calls) {
    assert.ok(Object.values(providerLinks).includes(url));
    assert.equal(init.redirect,'manual');assert.equal(init.credentials,'omit');
    assert.ok(init.signal instanceof AbortSignal);
    assert.deepEqual(Object.keys(init.headers),['Accept','User-Agent'],'No caller/provider/service credentials are forwarded');
  }
  const rejected = [
    'http://pinside.com/pinball/machine/test', '//pinside.com/pinball/machine/test',
    'file:///etc/passwd', 'data:text/html,test', 'javascript:alert(1)',
    'https://127.0.0.1/', 'https://[::1]/', 'https://169.254.169.254/latest/meta-data/',
    'https://2130706433/', 'https://0x7f000001/', 'https://localhost/', 'https://10.0.0.1/',
    'https://pinside.com.evil.example/', 'https://evil-pinside.com/', 'https://sub.pinside.com/',
    'https://pinside.com@evil.example/', 'https://user:password@pinside.com/',
    'https://@pinside.com/', 'https://pinside.com:443/', 'https://pinside.com:8443/',
    'https://pinside.com./', 'https://%70inside.com/', 'https://pinsıde.com/',
    'https://pinside.com\\@evil.example/', 'https://pin\tside.com/', 'https://pinside.com\n/',
    'https://pinside.com/white space', 'https://pinside.com/'+'x'.repeat(4096),
    providerLinks.IPDB, providerLinks.Kineticist,
  ];
  for(const value of rejected) {
    assert.equal((await f.fetchReferenceHtml('Pinside',value,new AbortController().signal)).html,'',value);
  }
  assert.equal(f.calls.length,3,'Invalid references never reach fetch');
  assert.equal(f.researchUrl('Pinside',' HTTPS://PINSIDE.COM/pinball/machine/test#details ').href,
    'https://pinside.com/pinball/machine/test');
  const snapshot=JSON.parse(await readFile(new URL('../data/games.json',import.meta.url),'utf8'));
  const fields={ipdbUrl:'IPDB',pinsideUrl:'Pinside',kineticistUrl:'Kineticist'};
  let covered=0;
  function walk(value) {
    if(!value||typeof value!=='object')return;
    for(const [key,item] of Object.entries(value)) {
      if(fields[key]&&typeof item==='string'&&item) {
        assert.ok(f.researchUrl(fields[key],item),`Existing provider link: ${item}`);covered++;
      }
      walk(item);
    }
  }
  walk(snapshot);assert.ok(covered>100,'Exercise the real catalog, not only synthetic examples');
});

test('redirects, HTTP errors, non-HTML responses and network failures yield no snippets', async () => {
  for(const status of [301,302,303,307,308,403,500]) {
    const f=fixture(()=>new Response('<title>Must not be used</title>',{
      status,headers:{'content-type':'text/html',location:'https://169.254.169.254/'},
    }));
    assert.equal((await f.fetchReferenceHtml('IPDB',providerLinks.IPDB,new AbortController().signal)).html,'');
    assert.equal(f.calls.length,1);assert.equal(f.calls[0].init.redirect,'manual');
  }
  for(const type of ['', 'application/json','image/svg+xml','text/plain','application/octet-stream']) {
    let canceled=false;
    const f=fixture(()=>new Response(new ReadableStream({cancel(){canceled=true;}}),{
      headers:type?{'content-type':type}:{},
    }));
    assert.equal((await f.fetchReferenceHtml('IPDB',providerLinks.IPDB,new AbortController().signal)).html,'');
    assert.equal(canceled,true,'Rejected response body is canceled');
  }
  const redirected=fixture(()=>{
    const res=new Response(html,{headers:{'content-type':'text/html'}});
    Object.defineProperty(res,'redirected',{value:true});return res;
  });
  assert.equal((await redirected.fetchReferenceHtml('IPDB',providerLinks.IPDB,new AbortController().signal)).html,'');
  const network=fixture(()=>{throw new Error('Private network diagnostic with a credential marker');});
  await assert.rejects(network.fetchReferenceHtml('IPDB',providerLinks.IPDB,new AbortController().signal));
  const abort=fixture(()=>{throw new DOMException('Request aborted','AbortError');});
  const failed=await abort.fetchReferenceEvidence({title:'2001',release_date:null,manufacturer:null,manufacturer_full_name:null},'IPDB',providerLinks.IPDB);
  assert.equal(failed.identityMatches,false);
  assert.equal(failed.excerpt,'');
});

test('reference body limits apply to declared, missing, dishonest and decoded transport sizes', async () => {
  const limit=fixture().REFERENCE_MAX_BYTES;
  for(const length of [String(limit+1),'99999999999999999999999999','invalid']) {
    let canceled=false;
    const f=fixture(()=>new Response(new ReadableStream({cancel(){canceled=true;}}),{
      headers:{'content-type':'text/html','content-length':length},
    }));
    assert.equal((await f.fetchReferenceHtml('IPDB',providerLinks.IPDB,new AbortController().signal)).html,'');assert.equal(canceled,true);
  }
  for(const declared of [null,'12']) {
    let canceled=false;
    const f=fixture(()=>new Response(new ReadableStream({
      start(controller){
        controller.enqueue(new TextEncoder().encode('<title>Do not retain partial text</title>'));
        controller.enqueue(new Uint8Array(limit));
      },cancel(){canceled=true;},
    }),{headers:{'content-type':'text/html',...(declared?{'content-length':declared,'content-encoding':'gzip'}:{})}}));
    assert.equal((await f.fetchReferenceHtml('IPDB',providerLinks.IPDB,new AbortController().signal)).html,'');assert.equal(canceled,true);
  }
  // Exact boundary succeeds; multibyte characters split across chunks are decoded correctly.
  const title='<title>Café</title>',bytes=new TextEncoder().encode(title);
  const data=new Uint8Array(limit);data.fill(32);data.set(bytes);
  const f=fixture(()=>new Response(new ReadableStream({start(c){
    c.enqueue(data.slice(0,11));c.enqueue(data.slice(11));c.close();
  }}),{headers:{'content-type':'APPLICATION/XHTML+XML; charset=utf-8','content-length':String(limit)}}));
  const exact=await f.fetchReferenceHtml('IPDB',providerLinks.IPDB,new AbortController().signal);
  assert.match(exact.html,/<title>Café<\/title>/);
});

test('routine description context uses attributed API details without fetching provider pages', () => {
  const f=fixture();
  const references={
    opdbUrl:'https://opdb.org/entries/G2001',
    opdbEntry:{opdb_id:'G2001',name:'2001',manufacturer:'Gottlieb',manufacture_date:'1971-01-01'},
    ipdbId:2697,ipdbUrl:providerLinks.IPDB,
    kineticistUrl:providerLinks.Kineticist,
    kineticistPayload:{data:{
      name:'2001',first_manufacture_year:1971,manufacturer:{name:'Gottlieb'},
      game_type:'Electro-Mechanical',display_type:'Reels',player_count:4,
      description:'<p>A four-player electro-mechanical pinball machine featuring ramps, shots, targets, and a multiball mode.</p>',
      tags:[{name:'Space'}],
      credits:[{role:'design',person:{name:'Ed Krynski'}}],
      editions:[],
    }},
    kineticistStale:false,warnings:[],
  };
  const evidence=f.referenceEvidence(references);
  const context=f.buildDescriptionResearchContext(references);
  assert.equal(f.calls.length,0);
  assert.match(context,/OPDB ID: G2001/);
  assert.match(context,/Data provided by Kineticist/);
  assert.match(context,/Kineticist description \(source text; paraphrase, do not copy\): A four-player electro-mechanical pinball machine featuring ramps, shots, targets, and a multiball mode\./);
  assert.match(context,/Design credits: Ed Krynski \(design\)/);
  assert.match(context,/Gameplay tags: Space/);
  assert.equal(evidence.find((item)=>item.provider==='Kineticist API').canGroundDescription,true);
});

test('operator source confirmation records identity without fetching its page', () => {
  const f=fixture();
  const game={ipdb_url:providerLinks.IPDB,pinside_url:providerLinks.Pinside,kineticist_url:providerLinks.Kineticist};
  const evidence=f.operatorConfirmedSourceEvidence(game,[{provider:'Pinside',url:providerLinks.Pinside}]);
  assert.equal(f.calls.length,0);
  assert.equal(evidence.length,1);
  assert.equal(evidence[0].verified,true);
  assert.equal(evidence[0].excerpt,'');
  assert.equal(evidence[0].verificationMethod,'operator');
});
