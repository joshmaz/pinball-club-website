-- Track estimated OpenAI usage and enforce a club-wide monthly cap.
-- Prompts and generated text are never stored in this ledger.
create table public.ai_usage_budget (
  singleton boolean primary key default true check (singleton),
  monthly_limit_usd numeric(10,2) not null default 5.00 check (monthly_limit_usd between 0 and 100),
  tracking_started_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);
insert into public.ai_usage_budget(singleton, monthly_limit_usd) values (true, 5.00)
on conflict (singleton) do nothing;

create table public.ai_usage_calls (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  feature text not null check (feature in ('game_metadata','game_description')),
  model text not null,
  status text not null default 'reserved' check (status in ('reserved','completed','failed')),
  reserved_usd numeric(14,8) not null check (reserved_usd >= 0),
  cost_usd numeric(14,8) not null default 0 check (cost_usd >= 0),
  input_tokens integer not null default 0 check (input_tokens >= 0),
  output_tokens integer not null default 0 check (output_tokens >= 0)
);
create index ai_usage_calls_created_at on public.ai_usage_calls(created_at desc);
create index ai_usage_calls_feature_month on public.ai_usage_calls(feature, created_at desc);

alter table public.ai_usage_budget enable row level security;
alter table public.ai_usage_calls enable row level security;
revoke all on public.ai_usage_budget, public.ai_usage_calls from public, anon, authenticated;
grant select, insert, update on public.ai_usage_budget to service_role;
grant select, insert, update on public.ai_usage_calls to service_role;

create function public.snh_ai_usage_reserve(p_feature text, p_model text, p_reserved_usd numeric)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_limit numeric(10,2);
  v_used numeric(14,8);
  v_reserve numeric(14,8);
  v_month timestamptz := date_trunc('month', now() at time zone 'UTC') at time zone 'UTC';
  v_id uuid;
begin
  if p_feature is null or p_feature not in ('game_metadata','game_description')
     or p_model is null or length(p_model) < 1 or length(p_model) > 100
     or p_reserved_usd is null or p_reserved_usd <= 0 or p_reserved_usd > 100 then
    raise exception 'Invalid AI usage reservation' using errcode='22023';
  end if;
  v_reserve := round(p_reserved_usd, 8);
  select monthly_limit_usd into v_limit from public.ai_usage_budget where singleton for update;
  if not found then raise exception 'AI usage budget is not configured'; end if;
  select coalesce(sum(case when status='reserved' then reserved_usd else cost_usd end),0)
    into v_used from public.ai_usage_calls where created_at >= v_month;
  if v_used + v_reserve > v_limit then
    return jsonb_build_object('allowed',false,'used_usd',round(v_used,8),
      'limit_usd',v_limit,'warning_limit_usd',round(v_limit * 0.8,2),
      'reset_at',v_month + interval '1 month');
  end if;
  insert into public.ai_usage_calls(feature,model,reserved_usd)
    values(p_feature,p_model,v_reserve) returning id into v_id;
  return jsonb_build_object('allowed',true,'id',v_id,'used_usd',round(v_used,8),
    'limit_usd',v_limit,'warning_limit_usd',round(v_limit * 0.8,2),
    'reset_at',v_month + interval '1 month');
end; $$;
revoke all on function public.snh_ai_usage_reserve(text,text,numeric) from public, anon, authenticated;
grant execute on function public.snh_ai_usage_reserve(text,text,numeric) to service_role;

create function public.snh_ai_usage_settle(
  p_call_id uuid, p_cost_usd numeric, p_input_tokens integer, p_output_tokens integer, p_succeeded boolean
) returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_call_id is null or p_cost_usd is null or p_cost_usd < 0 or p_cost_usd > 100
     or p_input_tokens is null or p_input_tokens < 0 or p_input_tokens > 10000000
     or p_output_tokens is null or p_output_tokens < 0 or p_output_tokens > 10000000
     or p_succeeded is null then
    raise exception 'Invalid AI usage settlement' using errcode='22023';
  end if;
  update public.ai_usage_calls set
    status = case when p_succeeded then 'completed' else 'failed' end,
    cost_usd = round(p_cost_usd,8),
    input_tokens = p_input_tokens,
    output_tokens = p_output_tokens
  where id=p_call_id and status='reserved';
  if not found then raise exception 'AI usage reservation is unavailable'; end if;
end; $$;
revoke all on function public.snh_ai_usage_settle(uuid,numeric,integer,integer,boolean) from public, anon, authenticated;
grant execute on function public.snh_ai_usage_settle(uuid,numeric,integer,integer,boolean) to service_role;

create function public.snh_ai_usage_snapshot() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_limit numeric(10,2);
  v_tracking_started_at timestamptz;
  v_used numeric(14,8);
  v_calls bigint;
  v_input bigint;
  v_output bigint;
  v_month timestamptz := date_trunc('month', now() at time zone 'UTC') at time zone 'UTC';
  v_features jsonb;
begin
  perform private.snh_require_operations_admin();
  select monthly_limit_usd,tracking_started_at into v_limit,v_tracking_started_at from public.ai_usage_budget where singleton;
  select coalesce(sum(case when status='reserved' then reserved_usd else cost_usd end),0),
    count(*),coalesce(sum(input_tokens),0),coalesce(sum(output_tokens),0)
    into v_used,v_calls,v_input,v_output
    from public.ai_usage_calls where created_at >= greatest(v_month,v_tracking_started_at);
  select coalesce(jsonb_agg(jsonb_build_object(
    'feature',feature,'models',models,'request_count',request_count,'cost_usd',round(cost_usd,8),
    'input_tokens',input_tokens,'output_tokens',output_tokens
  ) order by feature),'[]'::jsonb) into v_features
  from (
    select feature,string_agg(distinct model, ', ' order by model) models,count(*) request_count,
      sum(case when status='reserved' then reserved_usd else cost_usd end) cost_usd,
      sum(input_tokens) input_tokens,sum(output_tokens) output_tokens
    from public.ai_usage_calls where created_at >= greatest(v_month,v_tracking_started_at) group by feature
  ) f;
  return jsonb_build_object(
    'provider','OpenAI API',
    'period','UTC calendar month',
    'month_start',v_month,
    'tracking_started_at',v_tracking_started_at,
    'reset_at',v_month + interval '1 month',
    'monthly_limit_usd',v_limit,
    'warning_limit_usd',round(v_limit * 0.8,2),
    'used_usd',round(v_used,8),
    'request_count',v_calls,
    'input_tokens',v_input,
    'output_tokens',v_output,
    'status',case when v_used >= v_limit then 'paused' when v_used >= v_limit * 0.8 then 'warning' else 'ok' end,
    'features',v_features
  );
end; $$;
revoke all on function public.snh_ai_usage_snapshot() from public, anon;
grant execute on function public.snh_ai_usage_snapshot() to authenticated, service_role;

create function public.snh_ai_usage_set_budget(p_limit_usd numeric) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_old numeric(10,2);
  v_new numeric(10,2);
begin
  perform private.snh_require_operations_admin();
  if p_limit_usd is null or p_limit_usd < 0 or p_limit_usd > 100 then
    raise exception 'AI monthly limit must be between 0 and 100 USD' using errcode='22023';
  end if;
  v_new := round(p_limit_usd,2);
  select monthly_limit_usd into v_old from public.ai_usage_budget where singleton for update;
  update public.ai_usage_budget set monthly_limit_usd=v_new,updated_at=now(),updated_by=auth.uid() where singleton;
  insert into public.audit_log(module,action,actor_user_id,entity_type,entity_id,old_data,new_data)
  values('operations','update',auth.uid(),'ai_usage_budget','monthly_limit',
    jsonb_build_object('monthly_limit_usd',v_old),
    jsonb_build_object('monthly_limit_usd',v_new,'warning_limit_usd',round(v_new*0.8,2)));
end; $$;
revoke all on function public.snh_ai_usage_set_budget(numeric) from public, anon;
grant execute on function public.snh_ai_usage_set_budget(numeric) to authenticated, service_role;
