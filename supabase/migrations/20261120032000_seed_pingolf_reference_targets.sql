-- Move the targets previously shown by the public page into the game editor.
do $$
declare
  seed record;
  inserted public.pingolf_targets;
begin
  for seed in
    select * from (values
      ('7c983960-bf4f-4958-b972-29715fc577da'::uuid, 'score', 'Score at least 80,000,000 points', 80000000::bigint, true),
      ('7c983960-bf4f-4958-b972-29715fc577da'::uuid, 'score', 'Score at least 120,000,000 points', 120000000::bigint, false),
      ('00918566-e29b-4f4e-8d8c-0089f4d62a0a'::uuid, 'feature', 'Lock a ball', null::bigint, false)
    ) as targets(game_id, target_type, description, score_threshold, prefer_if_empty)
  loop
    perform 1 from public.games where id = seed.game_id and deleted_at is null for update;
    if not found then continue; end if;

    insert into public.pingolf_targets (game_id, target_type, description, score_threshold, is_preferred)
    select seed.game_id, seed.target_type, seed.description, seed.score_threshold,
      seed.prefer_if_empty and not exists (select 1 from public.pingolf_targets where game_id = seed.game_id)
    where (select count(*) from public.pingolf_targets where game_id = seed.game_id) < 10
      and not exists (
        select 1 from public.pingolf_targets as existing
        where existing.game_id = seed.game_id
          and existing.target_type = seed.target_type
          and (
            (seed.score_threshold is not null and existing.score_threshold = seed.score_threshold)
            or (seed.score_threshold is null and lower(trim(existing.description)) = lower(seed.description))
          )
      )
    returning * into inserted;

    if found then
      perform private.snh_audit_game('insert', 'pingolf_target', inserted.id::text,
        '{}'::jsonb, to_jsonb(inserted), jsonb_build_object('reason', 'Move page targets into the catalog'));
    end if;
  end loop;
end;
$$;
