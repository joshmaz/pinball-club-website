import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import links from '../assets/js/event-links.js';
import publicData from '../assets/js/public-data.js';
import { rankEventCandidates } from '../supabase/functions/matchplay-event-review/match.mjs';

test('labels recognize service subdomains, respect custom labels, reject unsafe URLs, and honor empty arrays', () => {
  assert.equal(links.inferLabel('https://www.ifpapinball.com/tournaments/view.php?t=1'), 'IFPA');
  assert.equal(links.inferLabel('https://app.matchplay.events/tournaments/1'), 'Match Play');
  assert.equal(links.inferLabel('https://facebook.com.evil.test'), 'Event link');
  assert.deepEqual(links.presentation({ external_links: [{ url: 'https://discord.gg/club', label: '  Join us  ' }, {url: 'javascript:alert(1)'}] }), [{ url: 'https://discord.gg/club', label: 'Join us' }]);
  assert.deepEqual(links.presentation({ external_links: [], url: 'https://facebook.com/old' }), []);
  assert.throws(() => links.normalize([{ url: 'ftp://example.com' }], true));
  assert.throws(() => links.normalize([{ label: 'Missing URL' }], true));
});

function editorFixture() {
  const doc = { createElement() { return {
    ownerDocument: doc, children: [], handlers: {}, value: '',
    appendChild(child) { this.children.push(child); child.parent = this; },
    replaceChildren() { this.children = []; },
    addEventListener(type, fn) { this.handlers[type] = fn; },
    focus() {}, setCustomValidity() {},
    remove() { this.parent.children = this.parent.children.filter(c => c !== this); },
  }; } };
  const container = doc.createElement(), button = doc.createElement();
  const editor = links.createEditor(container, button);
  const fields = (i=0) => { const row=container.children[i]; return {url:row.children[0].children[0], label:row.children[1].children[0], remove:row.children[2]}; };
  return {editor,container,button,fields};
}
test('repeatable editor autofills labels until manually edited, supports removal/reset, and roundtrips multiple links', () => {
  const {editor,container,button,fields} = editorFixture();
  let {url,label} = fields();
  url.value = 'https://facebook.com/events/1'; url.handlers.input(); assert.equal(label.value,'Facebook');
  url.value = 'https://app.matchplay.events/tournaments/1'; url.handlers.input(); assert.equal(label.value,'Match Play');
  label.value = 'Register here'; label.handlers.input();
  url.value = 'https://discord.gg/example'; url.handlers.input(); assert.equal(label.value,'Register here');
  label.value = ''; label.handlers.input(); url.handlers.input(); assert.equal(label.value,'');
  button.handlers.click(); assert.equal(container.children.length,2);
  fields(1).url.value='https://example.com/info';
  const saved=editor.get(); editor.set(saved); assert.equal(editor.get().length,2);
  fields(1).remove.handlers.click(); assert.equal(editor.get().length,1);
  editor.set([{url:'https://facebook.com/events/1',label:'Facebook'}]);
  ({url,label}=fields());url.value='https://discord.gg/club';url.handlers.input();assert.equal(label.value,'Facebook','saved labels stay intentional');
  editor.append({url:'https://ifpapinball.com'}); assert.equal(editor.get().length,2); assert.equal(label.value,'Facebook');
  editor.set([]); assert.equal(container.children.length,1); assert.deepEqual(editor.get(),[]);
});

test('public adapter retains all links and Match Play recognizes a secondary link', () => {
  const external_links = [{url:'https://facebook.com/1'}, {url:'https://app.matchplay.events/tournaments/1',label:'Results'}];
  const row={id:'6c76d069-3d02-443f-8c33-3f0da3946609',title:'League',external_url:external_links[0].url,external_links};
  assert.deepEqual(publicData.eventFromRow(row).external_links,external_links);
  assert.equal(rankEventCandidates({title:'League',url:external_links[1].url},[row]).length,1);
});

test('migration backfills URLs, preserves extra links for old writers, clears links, validates shape, and is repeatable', async () => {
  const db = new PGlite();
  try {
    await db.exec("create table events(id int primary key, external_url text); insert into events values(1,'https://facebook.com/1'),(2,null);");
    const sql=await readFile(new URL('../supabase/migrations/20260926120000_event_external_links.sql',import.meta.url),'utf8');
    await db.exec(sql); await db.exec(sql);
    let row=(await db.query('select * from events where id=1')).rows[0];
    assert.deepEqual(row.external_links,[{url:'https://facebook.com/1'}]);
    await db.query('update events set external_links=$1 where id=1',[JSON.stringify([{url:'https://facebook.com/1',label:'FB'},{url:'https://ifpapinball.com',label:'IFPA'}])]);
    await db.exec("update events set external_url='https://facebook.com/2' where id=1");
    row=(await db.query('select * from events where id=1')).rows[0];
    assert.equal(row.external_links.length,2);assert.equal(row.external_links[1].label,'IFPA');
    await db.exec("update events set external_links='[]' where id=1");
    row=(await db.query('select * from events where id=1')).rows[0];assert.equal(row.external_url,null);assert.deepEqual(row.external_links,[]);
    await db.exec("insert into events(id,external_url) values(3,'https://example.com/legacy')");
    assert.equal((await db.query('select external_links from events where id=3')).rows[0].external_links.length,1);
    await assert.rejects(db.exec("update events set external_links='[{\"url\":123}]' where id=2"));
    await assert.rejects(db.exec("update events set external_links='{}' where id=2"));
  } finally { await db.close(); }
});

test('admin saves and clears the full array while keeping the compatibility URL synchronized', async () => {
  const {default:vm}=await import('node:vm');
  const source=await readFile(new URL('../assets/js/member-portal.js',import.meta.url),'utf8');
  const fn=source.slice(source.indexOf('  async function saveEventForAdmin('),source.indexOf('  async function deleteEventForAdmin('));
  let payload;
  const client={from(){return {upsert(value){payload=value;return {select(){return {single:async()=>({data:{id:'saved'}})}}}}}}};
  const ctx=vm.createContext({window:{SNHEventLinks:links},getClient:()=>client});vm.runInContext(fn,ctx);
  await ctx.saveEventForAdmin({title:'Test',external_links:[{url:'https://facebook.com/1',label:'Details'},{url:'https://ifpapinball.com',label:'Ranking'}]});
  assert.equal(payload.external_links.length,2);assert.equal(payload.external_url,'https://facebook.com/1');
  assert.equal(payload.external_links[1].label,'Ranking');
  await ctx.saveEventForAdmin({title:'Test',external_links:[]});assert.equal(payload.external_url,null);assert.equal(payload.external_links.length,0);
});
