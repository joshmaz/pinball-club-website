-- Advisor 0008 (rls_enabled_no_policy): RLS was ON with zero policies.
-- These tables are intentionally opaque to PostgREST clients: reads/writes go
-- through SECURITY DEFINER RPCs or service_role. Explicit deny policies for
-- anon + authenticated document that and satisfy the linter.

create policy audit_log_no_api_role_access
  on public.audit_log
  for all
  to anon, authenticated
  using (false)
  with check (false);

create policy club_issue_import_keys_no_api_role_access
  on public.club_issue_import_keys
  for all
  to anon, authenticated
  using (false)
  with check (false);

create policy game_custom_mods_no_api_role_access
  on public.game_custom_mods
  for all
  to anon, authenticated
  using (false)
  with check (false);

create policy game_high_scores_no_api_role_access
  on public.game_high_scores
  for all
  to anon, authenticated
  using (false)
  with check (false);

create policy game_sale_listings_no_api_role_access
  on public.game_sale_listings
  for all
  to anon, authenticated
  using (false)
  with check (false);

create policy owner_parties_no_api_role_access
  on public.owner_parties
  for all
  to anon, authenticated
  using (false)
  with check (false);

create policy pingolf_sessions_no_api_role_access
  on public.pingolf_sessions
  for all
  to anon, authenticated
  using (false)
  with check (false);

create policy pingolf_targets_no_api_role_access
  on public.pingolf_targets
  for all
  to anon, authenticated
  using (false)
  with check (false);
