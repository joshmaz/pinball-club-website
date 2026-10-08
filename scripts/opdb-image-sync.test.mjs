import test from 'node:test';
import assert from 'node:assert/strict';
import { planSync } from './sync-opdb-images.mjs';

test('plans every catalog game, deduplicates IDs, and distinguishes new/existing/unmatched images', () => {
  const games = [{id:'a',title:'A',opdb_id:' X '},{id:'b',title:'B',opdb_id:'X'},{id:'c',title:'C',opdb_id:null},{id:'d',title:'D',opdb_id:'missing'}];
  const existing = [{id:'old',game_id:'a',source_key:'known'}, {id:'orphan',game_id:'a',source_key:'gone'}];
  const entries = new Map([['X',{images:[{sourceKey:'known',metadata:{deliveryVariants:[{width:250}]}},{sourceKey:'new',metadata:{deliveryVariants:[]}}]}]]);
  const plan = planSync(games,existing,entries,e => e.images);
  assert.equal(plan.withoutId.length,1);
  assert.equal(plan.plans.length,2);
  const matched=plan.plans.find(p=>p.opdbId==='X');
  assert.deepEqual(matched.changes,[{gameId:'a',title:'A',newImages:1,existingImages:1,unmatchedExisting:['orphan']},{gameId:'b',title:'B',newImages:2,existingImages:0,unmatchedExisting:[]}]);
  assert.deepEqual(matched.missingCandidates,['new']);
  assert.equal(plan.plans.find(p=>p.opdbId==='missing').matched,false);
  assert.deepEqual(existing.map(r=>r.source_key),['known','gone']);
});
