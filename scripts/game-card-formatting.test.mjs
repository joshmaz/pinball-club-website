import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../assets/js/games.js',import.meta.url),'utf8').replace(/loadGames\(\);\s*$/,'');
const ctx=vm.createContext({console,window:{},document:{}});vm.runInContext(source,ctx);
test('compact stints preserve dates, current first, unknowns and returning machines',()=>{
 const stints=[{address:'134 Haines Street, Nashua, NH',joinedClubDate:'2020-01-01',leftClubDate:'2021-02-03'},
  {address:'48 Bridge St, Unit 3A, Nashua',joinedClubDate:'2026-04-26'},
  {address:'Haines St',joinedClubDate:'2018-06-01'}];
 const before=JSON.stringify(stints);const value=ctx.formatLocationStints(stints,true);
 assert.equal(value.split('\n')[0],'Bridge St · Apr 2026 – Present · Current');
 assert.match(value,/Haines St · Jan 2020 – Feb 2021/);
 assert.match(value,/Jun 2018 – End unknown/);
 assert.equal(value.match(/Present/g).length,1);
 assert.equal(JSON.stringify(stints),before);
 assert.doesNotMatch(ctx.formatLocationStints(stints,false),/Present|Current/);
 assert.equal(ctx.formatLocationStints([{address:'Bridge St'}],true),'Bridge St · Start unknown – Present · Current');
 assert.equal(ctx.formatLocationStints([{address:'Bridge St'}],false),'Bridge St · Dates unknown');
 assert.equal(ctx.formatLocationStints(null),'');
 assert.equal(ctx.shortClubLocation('Other venue'),'Other venue');
});
test('era uses one OPDB display field; snapshot covers matched collection',()=>{
 for(const [display,label] of [['reels','EM'],['lights','EM'],['alphanumeric','Solid State'],['dmd','Modern'],['lcd','Modern'],['LCD','Modern'],['unknown',''],[null,'']])
  assert.equal(ctx.gameEraLabel({display,type:'anything',releaseDate:'2025-01-01'}),label);
 const games=JSON.parse(readFileSync(new URL('../data/games.json',import.meta.url))).games;
 const counts={};
 for(const game of games.filter(g=>g.opdbId)){const label=ctx.gameEraLabel(game);assert.ok(label,game.title);counts[label]=(counts[label]||0)+1;}
 assert.deepEqual(counts,{EM:29,Modern:45,'Solid State':50});
});
