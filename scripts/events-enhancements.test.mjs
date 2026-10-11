import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { PGlite } from '@electric-sql/pglite';
import data from '../assets/js/public-data.js';
process.env.TZ = 'America/New_York';
const source = await readFile(new URL('../assets/js/events.js', import.meta.url), 'utf8');
const ctx = vm.createContext({});
vm.runInContext(source.replace(/^loadEvents\(\);$|^void loadEventsPhotoSpotlight\(\);$/gm, ''), ctx);
const event = (date, extra = {}) => ({ date, ...extra });
const at = value => new Date(value);
test('Eastern labels use Monday calendar weeks, Friday evening, and bounded Soon', () => {
 const now = at('2026-10-05T14:00:00Z'); // Monday
 for (const [date, label] of [['2026-10-05','Today'],['2026-10-06','Tomorrow'],['2026-10-08','This Week'],['2026-10-10','This Weekend'],['2026-10-11','This Weekend'],['2026-10-12','Next Week'],['2026-10-18','Next Week'],['2026-10-19','Soon'],['2026-11-05','Upcoming'],['TBD','Upcoming']]) assert.equal(ctx.eventTimingLabel(event(date), now), label, date);
 assert.equal(ctx.eventTimingLabel(event('2026-10-09'), now), 'This Week');
 assert.equal(ctx.eventTimingLabel(event('2026-10-09', { starts_at:'2026-10-09T20:59:00Z',time_known:true }), now), 'This Week');
 assert.equal(ctx.eventTimingLabel(event('2026-10-09', { starts_at:'2026-10-09T21:00:00Z',time_known:true }), now), 'This Weekend');
 assert.equal(ctx.eventTimingLabel(event('2026-10-12'), at('2026-10-12T03:30:00Z')), 'Tomorrow'); // still Sunday Eastern
 assert.equal(ctx.eventTimingLabel(event('2027-01-04'), at('2026-12-31T12:00:00Z')), 'Next Week');
 assert.equal(ctx.eventTimingLabel(event('2026-11-01'), at('2026-11-01T04:30:00Z')), 'Today'); // DST fall-back day
});
test('confirmed end controls progress and archive boundary, including across midnight', () => {
 const e=event('2026-10-05',{starts_at:'2026-10-06T03:00:00Z',ends_at:'2026-10-06T06:00:00Z',time_known:true});
 assert.equal(ctx.eventTimingLabel(e,at('2026-10-06T02:59:59Z')),'Today');
 assert.equal(ctx.eventTimingLabel(e,at(e.starts_at)),'In Progress');
 assert.equal(ctx.eventTimingLabel(e,at('2026-10-06T05:00:00Z')),'In Progress');
 assert.equal(ctx.eventIsUpcoming(e,at(e.ends_at)),false);
 assert.equal(ctx.eventTimingLabel(e,at(e.ends_at)),'Past event');
 for(const extra of [{ends_at:null},{time_known:false},{all_day:true}]) {
  assert.notEqual(ctx.eventTimingLabel({...e,...extra},at('2026-10-06T05:00:00Z')),'In Progress');
 }
 assert.equal(ctx.eventIsUpcoming({...e,ends_at:null},at('2026-10-06T03:59:00Z')),true);
 assert.equal(ctx.eventIsUpcoming({...e,ends_at:null},at('2026-10-06T04:00:00Z')),false);
 for(const lifecycle_status of ['canceled','postponed']) {
  assert.notEqual(ctx.eventTimingLabel({...e,lifecycle_status},at(e.starts_at)),'In Progress');
  assert.match(ctx.eventBadgeLabel({...e,lifecycle_status},at(e.starts_at)),new RegExp(lifecycle_status,'i'));
 }
 assert.equal(ctx.eventBadgeLabel({...e,previous_schedule:{starts_at:null}},at(e.starts_at)), 'Rescheduled · In Progress');
});
test('new default follows start until edited; existing ends and all-day dates are protected',async()=>{
 const html=await readFile(new URL('../members.html',import.meta.url),'utf8');
 const snippet=html.slice(html.indexOf('    function updateEventEndDefault()'), html.indexOf('    memberEventsStartsAt.addEventListener("input"'));
 const c=vm.createContext({memberEventsAllDay:{checked:false},memberEventsId:{value:''},memberEventsEndsAt:{value:''},memberEventsStartsAt:{value:'2026-10-05T19:00'},memberEventsEndTouched:false,memberEventsDefaultEnd:null,toIsoOrNull:v=>v?new Date(v).toISOString():null,toLocalDateTimeInputValue:v=>{const d=new Date(v);return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}T${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;}});
 vm.runInContext(snippet,c);c.updateEventEndDefault();assert.equal(c.memberEventsEndsAt.value,'2026-10-05T22:00');
 c.memberEventsStartsAt.value='2026-10-05T20:00';c.updateEventEndDefault();assert.equal(c.memberEventsEndsAt.value,'2026-10-05T23:00');
 c.memberEventsEndTouched=true;c.memberEventsEndsAt.value='2026-10-05T23:30';c.memberEventsStartsAt.value='2026-10-05T21:00';c.updateEventEndDefault();assert.equal(c.memberEventsEndsAt.value,'2026-10-05T23:30');
 c.memberEventsId.value='existing';c.memberEventsEndTouched=false;c.updateEventEndDefault();assert.equal(c.memberEventsEndsAt.value,'2026-10-05T23:30');
 c.memberEventsAllDay.checked=true;c.updateEventEndDefault();assert.equal(c.memberEventsEndsAt.value,'');assert.equal(c.memberEventsEndsAt.disabled,true);
});
test('migration has no end backfill, enforces lifecycle/end rules, and leaves publication independent',async()=>{
 const db=new PGlite();try {
  await db.exec("create table events(id int primary key, starts_at timestamptz, all_day boolean not null default false, time_known boolean, published boolean);insert into events(id,starts_at,published) values(1,'2026-10-05T23:00Z',true),(2,null,false);");
  await db.exec(await readFile(new URL('../supabase/migrations/20261011120000_event_timing_lifecycle.sql',import.meta.url),'utf8'));
  assert.deepEqual((await db.query('select ends_at,lifecycle_status,published from events order by id')).rows,[{ends_at:null,lifecycle_status:'scheduled',published:true},{ends_at:null,lifecycle_status:'scheduled',published:false}]);
  await db.exec("update events set ends_at='2026-10-06T02:00Z',lifecycle_status='canceled' where id=1");
  for(const sql of ["update events set lifecycle_status='rescheduled' where id=1","update events set ends_at='2026-10-05T22:00Z' where id=1","update events set all_day=true where id=1","update events set time_known=false where id=1","update events set ends_at='2026-10-06T02:00Z' where id=2"]) await assert.rejects(db.exec(sql));
 }finally{await db.close();}
});
test('lifecycle and explicit previous schedule survive live adapter, export, and fallback',async()=>{
 const row={id:'6c76d069-3d02-443f-8c33-3f0da3946609',title:'League',starts_at:'2026-10-05T23:00Z',ends_at:'2026-10-06T02:00Z',lifecycle_status:'postponed',previous_schedule:{starts_at:'2026-10-01T23:00Z',time_known:true},reschedule_note:'Venue change'};
 const e=data.eventFromRow(row);const snapshot=data.createSnapshot('events',[e]);
 const loaded=await data.load('events',{fetchImpl:async()=>({ok:true,json:async()=>snapshot})});
 for(const key of ['ends_at','lifecycle_status','previous_schedule','reschedule_note']) assert.deepEqual(loaded.data[0][key],row[key]);
 assert.throws(()=>data.createSnapshot('events',[{...e,lifecycle_status:'invalid'}]));
 assert.throws(()=>data.createSnapshot('events',[{...e,all_day:true}]));
});
test('saving routine edits preserves precision/ends; only explicit reschedule captures previous schedule', async()=>{
 const html=await readFile(new URL('../members.html',import.meta.url),'utf8');
 const start=html.indexOf('      memberEventsForm.addEventListener("submit", async function (ev)');
 const end=html.indexOf('\n    if (memberEventsTableBody)',start);
 const code=html.slice(start,end).replace(/\n    }\s*$/,'');
 const row={id:'existing',starts_at:'2026-10-05T23:00:12Z',ends_at:'2026-10-06T02:30:15Z',time_known:null,lifecycle_status:'postponed',previous_schedule:null};
 let submit,saved,status;
 const c=vm.createContext({window:{SNHMemberPortal:{saveEventForAdmin:async p=>{saved=p;},getFriendlyAuthErrorMessage:e=>e.message}},memberEventsForm:{addEventListener:(name,fn)=>{submit=fn;}},memberEventsTitle:{value:'League'},memberEventsLinks:{get:()=>[]},memberEventsAllDay:{checked:false},memberEventsStartsAt:{value:'2026-10-05T19:00'},memberEventsEndsAt:{value:'2026-10-05T22:30'},memberEventsId:{value:'existing'},memberEventsLocation:{value:''},memberEventsSource:{value:''},memberEventsDescription:{value:''},memberEventsPublished:{checked:true},memberEventsLifecycle:{value:'postponed'},memberEventsOriginalRow:row,memberEventsOriginalSchedule:{value:'2026-10-05T19:00',all_day:false,time_known:null},memberEventsReschedule:{checked:false},memberEventsRescheduleNote:{value:'New venue'},trimOrEmpty:v=>String(v||'').trim(),toIsoOrNull:v=>v?new Date(v).toISOString():null,toLocalDateTimeInputValue:()=> '2026-10-05T22:30',setEventsStatus:v=>{status=v;},resetEventsForm:()=>{},onEventsPanelShown:null});
 vm.runInContext(code,c);
 await submit({preventDefault(){}});assert.equal(saved.starts_at,row.starts_at);assert.equal(saved.ends_at,row.ends_at);assert.equal(saved.time_known,null);assert.equal(saved.previous_schedule,null);
 c.memberEventsStartsAt.value='2026-10-05T20:00';await submit({preventDefault(){}});assert.equal(saved.previous_schedule,null);assert.equal(saved.ends_at,row.ends_at);assert.equal(saved.time_known,true);
 c.memberEventsReschedule.checked=true;await submit({preventDefault(){}});assert.equal(saved.previous_schedule.starts_at,row.starts_at);assert.equal(saved.previous_schedule.ends_at,row.ends_at);assert.equal(saved.reschedule_note,'New venue');assert.equal(saved.lifecycle_status,'scheduled');assert.equal(saved.published,true);assert.equal(status,'Event saved.');
});
test('JSON import keeps UUID snapshot fields and uses legacy keys only for legacy rows, without default ends',async()=>{
 const script=await readFile(new URL('./import-events-json-to-supabase.mjs',import.meta.url),'utf8');
 const body=script.slice(script.indexOf('function toIsoDateOnly'),script.indexOf('main().catch'));
 const id='6c76d069-3d02-443f-8c33-3f0da3946609';const requests=[];
 const rows=[{id,title:'Moved event',date:'2026-10-05',starts_at:'2026-10-05T23:00:00Z',ends_at:'2026-10-06T02:30:00Z',lifecycle_status:'scheduled',previous_schedule:{starts_at:'2026-10-04T23:00:00Z'},reschedule_note:'Moved venue',published:false},{title:'Old date only',date:'2026-10-01'}];
 const c=vm.createContext({URL,console:{log(){}},process:{env:{SUPABASE_URL:'https://test.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'test-key'}},defaultEventsPath:'unused',path:{resolve:v=>v},readFile:async()=>JSON.stringify({events:rows}),importedStart:(row,date)=>row.starts_at||(date?date+'T00:00:00Z':null),eventLinks:{normalize:v=>v,fromEvent:()=>[]},createHash:()=>({update:()=>({digest:()=> 'legacy-key'})}),fetch:async(url,options)=>{requests.push({url,rows:JSON.parse(options.body)});return {ok:true};}});
 vm.runInContext(body,c);await c.main();
 assert.equal(requests.length,2);assert.match(requests[0].url,/on_conflict=id$/);assert.match(requests[1].url,/on_conflict=legacy_import_key$/);
 const saved=requests[0].rows[0];for(const key of ['id','ends_at','previous_schedule','lifecycle_status','reschedule_note','published']) assert.deepEqual(saved[key],rows[0][key]);
 assert.equal(Object.hasOwn(requests[1].rows[0],'ends_at'),false);assert.equal(Object.hasOwn(requests[1].rows[0],'lifecycle_status'),false);
});
