-- Register template-test data generation with the shared AI budget and audit template-test sends.
alter table public.ai_usage_calls drop constraint if exists ai_usage_calls_feature_check;
alter table public.ai_usage_calls add constraint ai_usage_calls_feature_check
  check (feature in ('game_metadata','game_description','email_template_test_data'));

create or replace function public.snh_ai_usage_reserve(p_feature text, p_model text, p_reserved_usd numeric)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_limit numeric(10,2);
  v_used numeric(14,8);
  v_reserve numeric(14,8);
  v_month timestamptz := date_trunc('month', now() at time zone 'UTC') at time zone 'UTC';
  v_id uuid;
begin
  if p_feature is null or p_feature not in ('game_metadata','game_description','email_template_test_data')
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

create or replace function public.snh_operations_template_test_request(
  p_template_alias text, p_ai_sample_used boolean
) returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.snh_require_operations_admin();
  if p_template_alias is null or p_template_alias !~ '^[a-z0-9][a-z0-9_-]{2,100}$'
     or p_ai_sample_used is null then
    raise exception 'Invalid email template test request' using errcode='22023';
  end if;
  insert into public.audit_log(module,action,actor_user_id,entity_type,entity_id,new_data)
  values('operations','template_test_requested',auth.uid(),'email_template',p_template_alias,
    jsonb_build_object('ai_sample_used',p_ai_sample_used,'recipient','configured_test_inbox'));
end; $$;
revoke all on function public.snh_operations_template_test_request(text,boolean) from public,anon;
grant execute on function public.snh_operations_template_test_request(text,boolean) to authenticated;
