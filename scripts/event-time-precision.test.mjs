import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import vm from 'node:vm';
test('precision migration preserves legacy timestamps and supports explicit all-day/known-time metadata',async()=>{
 const db=new PGlite();try {
  await db.exec("create table public.events(id integer primary key, starts_at timestamptz); insert into events values(1,'2026-04-18T00:00:00Z');");
  const sql=await readFile(new URL('../supabase/migrations/20260925180000_event_time_precision.sql',import.meta.url),'utf8');
  await db.exec(sql);await db.exec(sql);
  let {rows}=await db.query('select all_day,time_known from events');assert.deepEqual(rows,[{all_day:false,time_known:null}]);
  await db.exec('update events set all_day=true,time_known=false');
  ({rows}=await db.query("select starts_at::text as starts_at,all_day,time_known from events"));assert.equal(Date.parse(rows[0].starts_at),Date.parse('2026-04-18T00:00:00Z'));assert.equal(rows[0].all_day,true);
 }finally{await db.close();}
});
test('event editor converts all-day input without shifting the calendar date',async()=>{
 const html=await readFile(new URL('../members.html',import.meta.url),'utf8');
 const source=html.slice(html.indexOf('    function setEventDateInputMode('),html.indexOf('    if (memberEventsAllDay) memberEventsAllDay.addEventListener'));
 const input={value:'2026-04-18T19:30',type:'datetime-local'};
 const ctx=vm.createContext({memberEventsStartsAt:input});vm.runInContext(source,ctx);
 ctx.setEventDateInputMode(true);assert.equal(input.type,'date');assert.equal(input.value,'2026-04-18');
 ctx.setEventDateInputMode(false);assert.equal(input.type,'datetime-local');assert.equal(input.value,'2026-04-18T00:00');
});
