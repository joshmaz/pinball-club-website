begin;

-- Reuse the Operations ledger. No browser access to worker functions or raw data.
alter table public.notification_outbox drop constraint notification_outbox_kind_check;
alter table public.notification_outbox add constraint notification_outbox_kind_check
  check (kind in ('member_signup','pinballmap_failure'));

create function public.snh_pinballmap_finish(p_run uuid, p_error text default null, p_warning text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare v_run public.operations_job_runs; v_previous public.operations_job_runs; v_member record;
begin
 perform pg_advisory_xact_lock(hashtextextended('pinballmap-ingest',0));
 select * into v_run from public.operations_job_runs where id=p_run and job='pinballmap_ingest' and status='running' for update;
 if not found then raise exception 'Import run is no longer running'; end if;
 select * into v_previous from public.operations_job_runs
 where job='pinballmap_ingest' and id<>p_run and status<>'running'
 order by started_at desc,id desc limit 1;
 update public.operations_job_runs set finished_at=clock_timestamp(),
   status=case when p_error is null then 'succeeded' else 'failed' end,
   error=left(p_error,500), result=result||jsonb_build_object('warning',left(p_warning,500)) where id=p_run;
 insert into public.integration_status(provider,resource_type,last_attempt_at,last_success_at,last_error_at,last_error,latency_ms)
 values('pinballmap','ingest',v_run.started_at,case when p_error is null then clock_timestamp() end,
   case when p_error is not null then clock_timestamp() end,left(p_error,500),
   greatest(0,(extract(epoch from (clock_timestamp()-v_run.started_at))*1000)::integer))
 on conflict(provider,resource_type) do update set
   last_attempt_at=excluded.last_attempt_at,
   last_success_at=coalesce(excluded.last_success_at,public.integration_status.last_success_at),
   last_error_at=coalesce(excluded.last_error_at,public.integration_status.last_error_at),
   last_error=excluded.last_error,latency_ms=excluded.latency_ms;
 -- One alert per failure episode. Existing dispatcher retains preview/test/live controls.
 if p_error is not null and v_previous.status is distinct from 'failed' then
   for v_member in select distinct on(lower(btrim(m.email))) m.id,btrim(m.email) email
     from public.members m join public.member_roles r on r.member_id=m.id
     where r.role_slug='club_admin' and m.user_id is not null
       and btrim(coalesce(m.email,'')) ~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
     order by lower(btrim(m.email)),m.id
   loop
     insert into public.notification_outbox(event_key,kind,recipient_member_id,recipient_email,subject,body)
     values('pinballmap_failure:'||p_run::text||':'||v_member.id::text,'pinballmap_failure',v_member.id,v_member.email,
       'SNHPC Pinball Map import needs attention',
       'The Pinball Map import failed. Some changes may already have been imported.'||E'\n\n'||left(p_error,500)||E'\n\n'||
       'Review Operations: https://snhpinballclub.com/members.html?panel=operations&section=jobs')
     on conflict(event_key) do nothing;
   end loop;
 end if;
end; $$;

create function public.snh_pinballmap_begin(p_actor uuid default null, p_location integer default 8908)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_run uuid; v_old uuid;
begin
 perform pg_advisory_xact_lock(hashtextextended('pinballmap-ingest',0));
 if exists(select 1 from public.operations_job_runs where job='pinballmap_ingest'
   and (status='running' and started_at>now()-interval '10 minutes' or started_at>now()-interval '30 seconds')) then
   return null;
 end if;
 for v_old in select id from public.operations_job_runs where job='pinballmap_ingest' and status='running'
 loop perform public.snh_pinballmap_finish(v_old,'Completion was not recorded within ten minutes. Check Jobs before retrying.'); end loop;
 insert into public.operations_job_runs(job,result) values('pinballmap_ingest',
   jsonb_build_object('actor_user_id',p_actor,'trigger',case when p_actor is null then 'scheduled' else 'manual' end,
     'location_id',p_location,'change_count',0,'changes','[]'::jsonb,'counts','{}'::jsonb)) returning id into v_run;
 insert into public.integration_status(provider,resource_type,last_attempt_at)
 values('pinballmap','ingest',now()) on conflict(provider,resource_type) do update set last_attempt_at=excluded.last_attempt_at;
 insert into public.audit_log(module,action,actor_user_id,entity_type,entity_id,new_data)
 values('games','import_requested',p_actor,'pinballmap_ingest',v_run::text,jsonb_build_object('location_id',p_location));
 return v_run;
end; $$;

-- Transaction-local snapshots count committed changes, excluding timestamp-only updates.
-- Only names and changed field names are stored in the run, never old/new values.
create function private.snh_pinballmap_snapshot(p_kind text, p_payload jsonb) returns jsonb
language sql stable set search_path = '' as $$
 select coalesce(jsonb_object_agg(x.key,x.value),'{}'::jsonb) from (
   select 'games:'||g.id::text key,jsonb_build_object('kind','games','game_id',g.id,'title',g.title,'slug',g.slug,
     'data',to_jsonb(g)-'updated_at'-'created_at') value from public.games g where p_kind='catalog'
   union all
   select 'locations:'||s.id::text,jsonb_build_object('kind','locations','game_id',g.id,'title',g.title,'slug',g.slug,
     'data',to_jsonb(s)-'updated_at'-'created_at') from public.game_location_stints s join public.games g on g.id=s.game_id where p_kind='catalog'
   union all
   select 'conditions:'||i.id::text,jsonb_build_object('kind','conditions','game_id',g.id,'title',coalesce(g.title,i.title),'slug',g.slug,
     'data',to_jsonb(i)-'updated_at'-'created_at') from public.clu…4142 tokens truncated…, true], ['events_admin', true], ['club_admin', true], ['games_admin', false], ['photos_admin', false], ['membership_admin', false], [null, false]]
        : [['games_editor', true], ['games_admin', true], ['club_admin', true], ['events_admin', false], ['photos_admin', false], ['membership_admin', false], [null, false]];
      for (const [role, allowed] of matrix) await t.test(`${name}: ${role || 'no role'}`, async () => {
        await db.exec('delete from member_roles');
        if (role) await db.query('insert into member_roles values ($1,$2)', [uid(1), role]);
        const f = fixture(name, db);
        const response = await f.request();
        assert.equal(response.status, allowed ? 200 : 403);
        assert.equal(response.headers.get('Access-Control-Allow-Origin'), '*');
        if (!allowed) { noProtectedWork(f); return; }
        const body = await response.json();
        assert.deepEqual(f.calls.slice(0, 2).map(c => c.path), ['/auth/v1/user', '/rest/v1/rpc/' +
          (eventsDomain ? 'snh_member_has_events_access' : 'snh_member_has_games_access')]);
        assert.deepEqual(f.clients, ['public-key', 'service-key']);
        if (name === 'opdb-image-sync') {
          assert.deepEqual(body, { ok: true, requested: 1, imported: 1 });
          assert.deepEqual(f.calls.find(c => c.path === 'opdb-import').ids, ['G-test']);
        } else if (eventsDomain) {
          assert.equal(body.tournaments[0].id, '42');
          assert.equal(body.tournaments[0].title, 'Test tournament');
          assert.equal(f.calls.find(c => c.path === 'matchplay-provider').requested, 'tournaments?owner=7&page=1');
        } else {
          assert.equal(body.ok, true);
          const payload = JSON.parse(f.calls.find(c => c.path.endsWith('snh_pinballmap_upsert_from_activity')).init.body).p_payload;
          assert.equal(payload.manual_actor_user_id, uid(101));
        }
      });
      for (const options of [{ rpcValue: false }, { rpcValue: null }, { rpcValue: 'true' }, { rpcValue: 1 },
        { rpcValue: [] }, { rpcValue: {} }, { rpcError: true }, { transportThrows: true }, { rpcThrows: true }, { authThrows: true }]) {
        await t.test(`${name}: fail closed ${JSON.stringify(options)}`, async () => {
          const f = fixture(name, db, options), response = await f.request();
          const expected = options.authThrows || options.rpcThrows ? (name === 'pinballmap-ingest' ? 503 : 500)
            : options.rpcError || options.transportThrows ? (name === 'pinballmap-ingest' ? 503 : eventsDomain ? 500 : 403) : 403;
          assert.equal(response.status, expected);
          const text = await response.text();
          assert.ok(!text.includes(marker));
          assert.ok(!text.includes(diagnostic));
          noProtectedWork(f);
        });
      }
      await t.test(`${name}: authentication and methods`, async () => {
        const missing = fixture(name, db);
        assert.equal((await missing.request({})).status, 401);
        assert.deepEqual(missing.clients, []);
        const invalid = fixture(name, db, { invalidJwt: true });
        assert.equal((await invalid.request()).status, 401);
        assert.deepEqual(invalid.calls.map(c => c.path), ['/auth/v1/user']);
        noProtectedWork(invalid);
        for (const method of ['GET', 'OPTIONS']) {
          const f = fixture(name, db), response = await f.request({}, method);
          assert.equal(response.status, method === 'OPTIONS' ? 200 : 405);
          assert.deepEqual(f.clients, []);
          assert.deepEqual(f.calls, []);
        }
      });
      if (name !== 'pinballmap-ingest') await t.test(`${name}: authorized request validation`, async () => {
        await db.exec('delete from member_roles');
        await db.query('insert into member_roles values ($1,$2)', [uid(1), 'club_admin']);
        const f = fixture(name, db);
        const response = await f.request(undefined, 'POST', name === 'opdb-image-sync' ? {} : { mode: 'discover', scope: 'owner', value: 'invalid' });
        assert.equal(response.status, 400);
        assert.ok(!f.calls.some(c => c.path === 'opdb-import' || c.path === 'matchplay-provider' || c.path === '/rest/v1/games'));
      });
    }
    await t.test('scheduler is independent of member auth, SQL availability and anon configuration', async () => {
      await db.exec('delete from member_roles');
      for (const bearer of [undefined, 'Bearer caller-jwt', 'Bearer invalid']) {
        const f = fixture('pinballmap-ingest', db, { rpcThrows: true, authThrows: true, env: { SUPABASE_ANON_KEY: '' } });
        const response = await f.request({ 'x-pinballmap-scheduler-secret': secret, ...(bearer ? { Authorization: bearer } : {}) });
        assert.equal(response.status, 200);
        assert.deepEqual(f.clients, ['service-key']);
        assert.ok(!f.calls.some(c => c.path.includes('snh_member_has_') || c.path === '/auth/v1/user'));
        const payload = JSON.parse(f.calls.find(c => c.path.endsWith('snh_pinballmap_upsert_from_activity')).init.body).p_payload;
        assert.equal(Object.hasOwn(payload, 'manual_actor_user_id'), false); // existing SQL records System/null
      }
    });
    await t.test('invalid/empty scheduler header never falls back to valid authorized user', async () => {
      await db.query('insert into member_roles values ($1,$2)', [uid(1), 'club_admin']);
      for (const supplied of ['', 'wrong']) {
        const f = fixture('pinballmap-ingest', db);
        assert.equal((await f.request({ 'x-pinballmap-scheduler-secret': supplied, Authorization: 'Bearer caller-jwt' })).status, 401);
        assert.deepEqual(f.calls, []);
        assert.deepEqual(f.clients, []);
      }
    });
  } finally { await db.close(); }
});
