-- Permanent uploaded-image deletion requires Games Admin or Website Administrator.
-- Upload and ordinary image management retain Games Editor access.
begin;

drop policy if exists game_images_storage_editor_delete on storage.objects;
create policy game_images_storage_admin_delete
  on storage.objects
  for delete
  to authenticated
  using (
    bucket_id = 'game-images'
    and coalesce(public.snh_member_has_games_admin_access(), false)
  );

create or replace function public.snh_game_images_delete_uploaded(
  p_game_id uuid,
  p_image_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_image public.game_images%rowtype;
  v_fallback_id uuid;
  v_result jsonb;
begin
  if not coalesce(public.snh_member_has_games_admin_access(), false) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  perform private.snh_require_game_editable(p_game_id);

  select * into v_image
  from public.game_images
  where id = p_image_id and game_id = p_game_id
  for update;

  if v_image.id is null then
    raise exception 'game image not found' using errcode = 'P0002';
  end if;
  if v_image.source_type <> 'club'
     or v_image.metadata->>'storageBucket' <> 'game-images'
     or nullif(v_image.metadata->>'storagePath', '') is null then
    raise exception 'only uploaded club images can be deleted here' using errcode = '22023';
  end if;
  if (v_image.metadata->>'storagePath') not like (p_game_id::text || '/%') then
    raise exception 'uploaded image path does not match game' using errcode = '22023';
  end if;

  v_result := jsonb_build_object(
    'bucket', v_image.metadata->>'storageBucket',
    'path', v_image.metadata->>'storagePath'
  );

  delete from public.game_images where id = v_image.id;

  if v_image.is_primary then
    select i.id into v_fallback_id
    from public.game_images i
    where i.game_id = p_game_id and i.usage_status = 'approved'
    order by
      case when i.source_type = 'club' then 0 else 1 end,
      i.created_at,
      i.id
    limit 1;

    if v_fallback_id is not null then
      update public.game_images set is_primary = true where id = v_fallback_id;
    end if;
  end if;

  perform private.snh_audit_game(
    'delete',
    'game_image',
    p_image_id::text,
    to_jsonb(v_image),
    '{}'::jsonb,
    jsonb_build_object('gameId', p_game_id, 'storagePath', v_result->>'path')
  );

  return v_result;
end;
$$;

revoke all on function public.snh_game_images_delete_uploaded(uuid, uuid) from public;
grant execute on function public.snh_game_images_delete_uploaded(uuid, uuid) to authenticated;

commit;
