-- Service-only finalization for the repo-to-Storage legacy game image migration.
-- The file upload is performed by scripts/migrate-legacy-game-images.mjs; this
-- function atomically converts the existing backfilled row in place.

create or replace function public.snh_game_images_migrate_legacy(
  p_game_id uuid,
  p_legacy_filename text,
  p_storage_path text,
  p_public_url text,
  p_metadata jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text;
  v_legacy_key text;
  v_storage_key text;
  v_image public.game_images%rowtype;
  v_conflict_id uuid;
begin
  v_role := coalesce((select auth.jwt())->>'role', '');
  if v_role is distinct from 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;

  p_legacy_filename := nullif(trim(p_legacy_filename), '');
  p_storage_path := nullif(trim(p_storage_path), '');
  p_public_url := nullif(trim(p_public_url), '');
  if p_legacy_filename is null
     or p_legacy_filename ~ '(^/|(^|/)\.\.(/|$)|/)' then
    raise exception 'invalid legacy filename' using errcode = '22023';
  end if;
  if p_storage_path is null
     or p_storage_path not like (p_game_id::text || '/%')
     or p_storage_path ~ '(^/|(^|/)\.\.(/|$))' then
    raise exception 'storage path does not match game' using errcode = '22023';
  end if;
  if p_public_url is null or p_public_url !~ '^https://' then
    raise exception 'public URL must use HTTPS' using errcode = '22023';
  end if;

  v_legacy_key := 'legacy:' || p_legacy_filename;
  v_storage_key := 'storage:' || p_storage_path;

  select * into v_image
  from public.game_images i
  where i.game_id = p_game_id
    and i.source_type = 'club'
    and i.source_key in (v_legacy_key, v_storage_key)
  order by case when i.source_key = v_storage_key then 0 else 1 end
  limit 1
  for update;

  if v_image.id is null then
    return jsonb_build_object('status', 'manual_review', 'reason', 'legacy association not found');
  end if;

  if v_image.source_key = v_storage_key then
    if v_image.location_type = 'remote_url'
       and v_image.location_value = p_public_url
       and v_image.metadata->>'storageBucket' = 'game-images'
       and v_image.metadata->>'storagePath' = p_storage_path then
      return jsonb_build_object('status', 'already_migrated', 'imageId', v_image.id);
    end if;
    return jsonb_build_object('status', 'manual_review', 'reason', 'storage association differs', 'imageId', v_image.id);
  end if;

  select i.id into v_conflict_id
  from public.game_images i
  where i.game_id = p_game_id
    and i.source_type = 'club'
    and i.source_key = v_storage_key
    and i.id <> v_image.id;
  if v_conflict_id is not null then
    return jsonb_build_object('status', 'manual_review', 'reason', 'duplicate storage association', 'imageId', v_conflict_id);
  end if;

  update public.game_images
  set source_key = v_storage_key,
      location_type = 'remote_url',
      location_value = p_public_url,
      metadata = metadata || coalesce(p_metadata, '{}'::jsonb) || jsonb_build_object(
        'storageBucket', 'game-images',
        'storagePath', p_storage_path,
        'migratedFromLegacyPath', 'assets/images/machines/' || p_legacy_filename
      )
  where id = v_image.id;

  perform private.snh_audit_game(
    'migrate',
    'game_image',
    v_image.id::text,
    to_jsonb(v_image),
    (select to_jsonb(i.*) from public.game_images i where i.id = v_image.id),
    jsonb_build_object('gameId', p_game_id, 'storagePath', p_storage_path)
  );

  return jsonb_build_object('status', 'migrated', 'imageId', v_image.id);
end;
$$;

revoke all on function public.snh_game_images_migrate_legacy(uuid, text, text, text, jsonb) from public;
grant execute on function public.snh_game_images_migrate_legacy(uuid, text, text, text, jsonb) to service_role;
