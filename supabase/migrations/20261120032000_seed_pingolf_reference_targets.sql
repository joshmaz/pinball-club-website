-- Move the targets previously shown by the public page into the game editor.
-- Resolve games by slug because staging and production use different game UUIDs.
do $$
declare
  seed record;
  inserted public.pingolf_targets;
begin
  for seed in
    select g.id as game_id, targets.target_type, targets.description,
           targets.score_threshold, targets.prefer_if_empty
      from (values
        ('godzilla-pro', 'score', 'Score at least 80,000,000 points', 80000000::bigint, true),
        ('godzilla-pro', 'score', 'Score at least 120,000,000 points', 120000000::bigint, false),
        ('world-cup-soccer', 'feature', 'Lock a ball', null::bigint, false)
      ) as targets(game_slug, target_type, description, score_threshold, prefer_if_empty)
      join public.games g on g.slug = targets.game_slug and g.deleted_at is null
     order by g.slug, targets.prefer_if_empty desc, targets.description
     for update of g
  loop
    insert into public.pingolf_targets (game_id, target_type, description, score_threshold, is_preferred)
    select seed.game_id, seed.target_type, seed.description, seed.score_threshold,
      seed.prefer_if_empty and not exists (
        select 1 from public.pingolf_targets where game_id = seed.game_id
      )
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
