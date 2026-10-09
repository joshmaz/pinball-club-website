import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeExport, downloadTips, opdbGroup, EXPORT_URL } from '../supabase/functions/pintips-import/provider.mjs';
const tip = { tipId:1,opdbId:'Gabc',category:'general',text:'<img src=x onerror=alert(1)>\nKeep as text',voteTotal:0,createdAt:'2026-01-01 00:00:00',updatedAt:'2026-01-02 00:00:00' };
test('documented OPDB parser accepts groups, machines and aliases with exact case', () => {
 for (const id of ['Gabc','Gabc-M123','Gabc-M123-Adef']) assert.equal(opdbGroup(id),'Gabc');
 for (const id of ['gabc','Gabc-Adef','Gabc-M','Gabc-M123-unknown',' Gabc',null]) assert.equal(opdbGroup(id),null);
 assert.notEqual(opdbGroup('GABC'),opdbGroup('Gabc'));
});
test('validate complete export before importing; never broaden machine-specific upstream tips', () => {
 assert.equal(normalizeExport([tip])[0].text,tip.text);
 for (const payload of [null,{},[],[tip,tip],[{...tip,tipId:'1'}],[{...tip,opdbId:'Gabc-M123'}],
 [{...tip,text:''}],[{...tip,text:'\0'}],[{...tip,updatedAt:'bad'}],[{...tip,voteTotal:null}]]) assert.throws(()=>normalizeExport(payload));
});
test('one bounded CDN request per refresh and actionable failures', async () => {
 let calls=0;
 const tips=await downloadTips(async (url,opts)=> { calls++; assert.equal(url,EXPORT_URL); assert.ok(opts.signal); return new Response(JSON.stringify([tip])); });
 assert.equal(calls,1); assert.equal(tips.length,1);
 await assert.rejects(downloadTips(async()=>new Response('upstream secret',{status:503})),/HTTP 503/);
 await assert.rejects(downloadTips(async()=>new Response('{broken')),/valid UTF-8 JSON/);
 await assert.rejects(downloadTips(async()=>{throw Error('secret');}),/download failed/);
 await assert.rejects(downloadTips(async()=>new Response('x'.repeat(20*1024*1024+1))),/exceeds 20 MB/);
});
