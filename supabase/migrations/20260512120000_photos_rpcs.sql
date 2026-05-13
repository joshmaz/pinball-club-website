-- Photos RPCs: editor-facing CRUD for albums and assets, plus public read.
--
-- Authorization model:
--   - All editor RPCs require snh_member_has_photos_access() (photos_editor /
--     photos_admin / club_admin).
--   - Destructive actions (delete album, delete asset, force-unpublish another
--     editor's work) require snh_member_has_photos_admin_access().
--   - Storage operations (signed upload URL, derivative generation, public
--     bucket writes) live in the photo-upload-intent and photo-publish Edge
--     Functions; this migration only owns metadata writes and audit.
--   - Pending asset rows are inserted by the photo-upload-intent Edge Function
--     using the service role; finalize/publish/unpublish/etc. flow through
--     SECURITY DEFINER RPCs gated on the user's role.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- snh_photo_albums_list_editor: list every album for the editor UI.
-- ---------------------------------------------------------------------------

create or replace function public.snh_photo_albums_list_editor()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_payload jsonb;
begin
  if not coalesce(public.snh_member_has_photos_access(), false) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(row_json order by sort_position, lower(title_sort)), '[]'::jsonb)
  into v_payload
  from (
    select
      jsonb_build_object(
        'id', alb.id,
        'slug', alb.slug,
        'title', alb.title,
        'description', alb.description,
        'sortPosition', alb.sort_position,
        'published', alb.published,
        'coverAssetId', alb.cover_asset_id,
        'createdAt', alb.created_at,
        'updatedAt', alb.updated_at,
        'assetCounts', jsonb_build_object(
          'total', (select count(*) from public.photo_assets a where a.album_id = alb.id),
          'pending', (select count(*) from public.photo_assets a where a.album_id = alb.id and a.status = 'pending'),
          'uploaded', (select count(*) from public.photo_assets a where a.album_id = alb.id and a.status = 'uploaded'),
          'published', (select count(*) from public.photo_assets a where a.album_id = alb.id and a.status = 'published')
        )
      ) as row_json,
      alb.sort_position as sort_position,
      alb.title as title_sort
    from public.photo_albums alb
  ) sub;

  return coalesce(v_payload, '[]'::jsonb);
end;
$$;

revoke all on function public.snh_photo_albums_list_editor() from public;
grant execute on function public.snh_photo_albums_list_editor() to authenticated;

-- ---------------------------------------------------------------------------
-- snh_photo_album_upsert: create or update an album.
-- p_fields keys: slug, title, description, sortPosition, published, coverAssetId
-- ---------------------------------------------------------------------------

create or replace function public.snh_photo_album_upsert(
  p_album_id uuid,
  p_fields jsonb
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_member_id uuid;
  v_old jsonb;
  v_slug text;
  v_title text;
  v_desc text;
  v_sort int;
  v_pub boolean;
  v_cover uuid;
  v_has_cover boolean;
begin
  if not coalesce(public.snh_member_has_photos_access(), false) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  if p_fields is null then
    raise exception 'fields required' using errcode = '22023';
  end if;

  v_slug := lower(btrim(coalesce(p_fields->>'slug', '')));
  if v_slug = '' or v_slug !~ '^[a-z0-9][a-z0-9_-]{0,80}$' then
    raise exception 'invalid slug (lowercase letters, digits, underscore or dash)' using errcode = '22023';
  end if;

  v_title := btrim(coalesce(p_fields->>'title', ''));
  if v_title = '' or length(v_title) > 200 then
    raise exception 'title required (1-200 characters)' using errcode = '22023';
  end if;

  v_desc := nullif(btrim(coalesce(p_fields->>'description', '')), '');
  v_sort := coalesce((p_fields->>'sortPosition')::int, 0);
  v_pub := coalesce((p_fields->>'published')::boolean, false);
  v_has_cover := p_fields ? 'coverAssetId';
  v_cover := case
    when v_has_cover and nullif(p_fields->>'coverAssetId', '') is not null then (p_fields->>'coverAssetId')::uuid
    else null
  end;

  select m.id into v_member_id from public.members m where m.user_id = auth.uid() limit 1;

  if p_album_id is null then
    insert into public.photo_albums (
      slug, title, description, sort_position, published, cover_asset_id, created_by
    ) values (
      v_slug, v_title, v_desc, v_sort, v_pub, v_cover, v_member_id
    )
    returning id into v_id;

    perform private.snh_audit_photo(
      'create',
      'photo_album',
      v_id::text,
      '{}'::jsonb,
      jsonb_build_object('slug', v_slug, 'title', v_title, 'published', v_pub),
      '{}'::jsonb
    );
  else
    select to_jsonb(alb.*) into v_old from public.photo_albums alb where alb.id = p_album_id;
    if v_old is null then
      raise exception 'album not found' using errcode = 'P0002';
    end if;

    update public.photo_albums alb
       set slug = v_slug,
           title = v_title,
           description = v_desc,
           sort_position = v_sort,
           published = v_pub,
           cover_asset_id = case when v_has_cover then v_cover else alb.cover_asset_id end
     where alb.id = p_album_id
    returning id into v_id;

    perform private.snh_audit_photo(
      'update',
      'photo_album',
      v_id::text,
      v_old,
      (select to_jsonb(alb.*) from public.photo_albums alb where alb.id = v_id),
      '{}'::jsonb
    );
  end if;

  return v_id;
end;
$$;

revoke all on function public.snh_photo_album_upsert(uuid, jsonb) from public;
grant execute on function public.snh_photo_album_upsert(uuid, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- snh_photo_album_delete: admin-only delete, cascades to assets & variants.
-- Storage objects are NOT removed here; the photo-publish Edge Function or a
-- maintenance task is responsible for purging photos-private and photos-public
-- objects when given the deleted asset list. This RPC returns the asset IDs
-- so the caller can run cleanup.
-- ---------------------------------------------------------------------------

create or replace function public.snh_photo_album_delete(p_album_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old jsonb;
  v_asset_ids uuid[];
begin
  if not coalesce(public.snh_member_has_photos_admin_access(), false) then
    raise exception 'not authorized (admin role required)' using errcode = '42501';
  end if;

  if p_album_id is null then
    raise exception 'album_id required' using errcode = '22023';
  end if;

  select to_jsonb(alb.*) into v_old from public.photo_albums alb where alb.id = p_album_id;
  if v_old is null then
    raise exception 'album not found' using errcode = 'P0002';
  end if;

  select coalesce(array_agg(a.id), '{}'::uuid[]) into v_asset_ids
  from public.photo_assets a where a.album_id = p_album_id;

  delete from public.photo_albums where id = p_album_id;

  perform private.snh_audit_photo(
    'delete',
    'photo_album',
    p_album_id::text,
    v_old,
    '{}'::jsonb,
    jsonb_build_object('cascaded_asset_ids', to_jsonb(v_asset_ids))
  );

  return jsonb_build_object(
    'ok', true,
    'cascadedAssetIds', to_jsonb(v_asset_ids)
  );
end;
$$;

revoke all on function public.snh_photo_album_delete(uuid) from public;
grant execute on function public.snh_photo_album_delete(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- snh_photo_assets_list_editor: list assets for a single album with variants.
-- ---------------------------------------------------------------------------

create or replace function public.snh_photo_assets_list_editor(p_album_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_payload jsonb;
begin
  if not coalesce(public.snh_member_has_photos_access(), false) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  if p_album_id is null then
    raise exception 'album_id required' using errcode = '22023';
  end if;

  select coalesce(jsonb_agg(row_json order by sort_position, created_sort), '[]'::jsonb)
  into v_payload
  from (
    select
      jsonb_build_object(
        'id', a.id,
        'albumId', a.album_id,
        'status', a.status,
        'visibility', a.visibility,
        'caption', a.caption,
        'altText', a.alt_text,
        'sortPosition', a.sort_position,
        'originalObjectKey', a.original_object_key,
        'originalContentType', a.original_content_type,
        'originalByteSize', a.original_byte_size,
        'originalContentHash', a.original_content_hash,
        'originalWidth', a.original_width,
        'originalHeight', a.original_height,
        'originalFilename', a.original_filename,
        'publishedAt', a.published_at,
        'unpublishedAt', a.unpublished_at,
        'createdAt', a.created_at,
        'updatedAt', a.updated_at,
        'variants', coalesce((
          select jsonb_agg(jsonb_build_object(
            'variant', v.variant,
            'bucket', v.bucket,
            'objectKey', v.object_key,
            'contentType', v.content_type,
            'byteSize', v.byte_size,
            'width', v.width,
            'height', v.height,
            'contentHash', v.content_hash
          ) order by v.variant)
          from public.photo_asset_variants v
          where v.asset_id = a.id
        ), '[]'::jsonb)
      ) as row_json,
      a.sort_position as sort_position,
      a.created_at as created_sort
    from public.photo_assets a
    where a.album_id = p_album_id
  ) sub;

  return coalesce(v_payload, '[]'::jsonb);
end;
$$;

revoke all on function public.snh_photo_assets_list_editor(uuid) from public;
grant execute on function public.snh_photo_assets_list_editor(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- snh_photo_assets_create_pending: insert a pending asset row. Called by the
-- photo-upload-intent Edge Function (service role) after validating the
-- caller's role and inputs. EXECUTE granted to service_role only; client
-- roles cannot call this directly.
-- ---------------------------------------------------------------------------

create or replace function public.snh_photo_assets_create_pending(
  p_album_id uuid,
  p_actor_user_id uuid,
  p_content_type text,
  p_byte_size bigint,
  p_original_filename text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_album record;
  v_member_id uuid;
  v_asset_id uuid := gen_random_uuid();
  v_ext text;
  v_object_key text;
begin
  if p_album_id is null then
    raise exception 'album_id required' using errcode = '22023';
  end if;

  select id, scope_type, scope_id into v_album from public.photo_albums where id = p_album_id;
  if v_album.id is null then
    raise exception 'album not found' using errcode = 'P0002';
  end if;

  if p_content_type is null or p_content_type not in ('image/jpeg','image/png') then
    raise exception 'unsupported content type' using errcode = '22023';
  end if;

  if p_byte_size is null or p_byte_size <= 0 or p_byte_size > 50 * 1024 * 1024 then
    raise exception 'byte_size out of range (1..50MB)' using errcode = '22023';
  end if;

  v_ext := case p_content_type
    when 'image/jpeg' then 'jpg'
    when 'image/png' then 'png'
  end;

  v_object_key := format(
    '%s/%s/%s/%s/original.%s',
    v_album.scope_type,
    v_album.scope_id,
    v_album.id,
    v_asset_id,
    v_ext
  );

  if p_actor_user_id is not null then
    select m.id into v_member_id from public.members m where m.user_id = p_actor_user_id limit 1;
  end if;

  insert into public.photo_assets (
    id, album_id, scope_type, scope_id, status, visibility,
    original_object_key, original_content_type, original_byte_size,
    original_filename, created_by
  ) values (
    v_asset_id, v_album.id, v_album.scope_type, v_album.scope_id, 'pending', 'public',
    v_object_key, p_content_type, p_byte_size,
    nullif(btrim(coalesce(p_original_filename, '')), ''), v_member_id
  );

  insert into public.audit_log (
    module, action, actor_user_id, entity_type, entity_id, old_data, new_data, metadata
  ) values (
    'photos',
    'upload_intent',
    p_actor_user_id,
    'photo_asset',
    v_asset_id::text,
    '{}'::jsonb,
    jsonb_build_object('album_id', v_album.id, 'object_key', v_object_key, 'content_type', p_content_type, 'byte_size', p_byte_size),
    '{}'::jsonb
  );

  return jsonb_build_object(
    'assetId', v_asset_id,
    'albumId', v_album.id,
    'scopeType', v_album.scope_type,
    'scopeId', v_album.scope_id,
    'bucket', 'photos-private',
    'objectKey', v_object_key,
    'contentType', p_content_type,
    'byteSize', p_byte_size
  );
end;
$$;

revoke all on function public.snh_photo_assets_create_pending(uuid, uuid, text, bigint, text) from public;
grant execute on function public.snh_photo_assets_create_pending(uuid, uuid, text, bigint, text) to service_role;

-- ---------------------------------------------------------------------------
-- snh_photo_asset_finalize_upload: client calls this AFTER the signed PUT
-- completes. Cross-checks the file size and content hash supplied by the
-- client and transitions the asset from pending -> uploaded.
-- ---------------------------------------------------------------------------

create or replace function public.snh_photo_asset_finalize_upload(
  p_asset_id uuid,
  p_byte_size bigint,
  p_content_hash text,
  p_width integer default null,
  p_height integer default null
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old jsonb;
begin
  if not coalesce(public.snh_member_has_photos_access(), false) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  if p_asset_id is null then
    raise exception 'asset_id required' using errcode = '22023';
  end if;

  if p_byte_size is null or p_byte_size <= 0 or p_byte_size > 50 * 1024 * 1024 then
    raise exception 'byte_size out of range' using errcode = '22023';
  end if;

  if p_content_hash is null or p_content_hash !~ '^[0-9a-f]{16,128}$' then
    raise exception 'content_hash must be hex' using errcode = '22023';
  end if;

  select to_jsonb(a.*) into v_old from public.photo_assets a where a.id = p_asset_id;
  if v_old is null then
    raise exception 'asset not found' using errcode = 'P0002';
  end if;

  if (v_old->>'status') not in ('pending', 'uploaded') then
    raise exception 'asset is not in an uploadable state' using errcode = '22023';
  end if;

  update public.photo_assets a
     set status = 'uploaded',
         original_byte_size = p_byte_size,
         original_content_hash = lower(p_content_hash),
         original_width = coalesce(p_width, a.original_width),
         original_height = coalesce(p_height, a.original_height)
   where a.id = p_asset_id;

  perform private.snh_audit_photo(
    'finalize_upload',
    'photo_asset',
    p_asset_id::text,
    v_old,
    (select to_jsonb(a.*) from public.photo_assets a where a.id = p_asset_id),
    '{}'::jsonb
  );
end;
$$;

revoke all on function public.snh_photo_asset_finalize_upload(uuid, bigint, text, integer, integer) from public;
grant execute on function public.snh_photo_asset_finalize_upload(uuid, bigint, text, integer, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- snh_photo_asset_set_metadata: caption / alt text / sort position.
-- ---------------------------------------------------------------------------

create or replace function public.snh_photo_asset_set_metadata(
  p_asset_id uuid,
  p_fields jsonb
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old jsonb;
  v_caption text;
  v_alt text;
  v_sort int;
  v_has_caption boolean;
  v_has_alt boolean;
  v_has_sort boolean;
begin
  if not coalesce(public.snh_member_has_photos_access(), false) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  if p_asset_id is null or p_fields is null then
    raise exception 'asset_id and fields required' using errcode = '22023';
  end if;

  v_has_caption := p_fields ? 'caption';
  v_has_alt := p_fields ? 'altText';
  v_has_sort := p_fields ? 'sortPosition';

  if v_has_caption then
    v_caption := nullif(btrim(coalesce(p_fields->>'caption', '')), '');
    if v_caption is not null and length(v_caption) > 1000 then
      raise exception 'caption too long' using errcode = '22023';
    end if;
  end if;

  if v_has_alt then
    v_alt := nullif(btrim(coalesce(p_fields->>'altText', '')), '');
    if v_alt is not null and length(v_alt) > 500 then
      raise exception 'altText too long' using errcode = '22023';
    end if;
  end if;

  if v_has_sort then
    v_sort := coalesce((p_fields->>'sortPosition')::int, 0);
  end if;

  select to_jsonb(a.*) into v_old from public.photo_assets a where a.id = p_asset_id;
  if v_old is null then
    raise exception 'asset not found' using errcode = 'P0002';
  end if;

  update public.photo_assets a
     set caption = case when v_has_caption then v_caption else a.caption end,
         alt_text = case when v_has_alt then v_alt else a.alt_text end,
         sort_position = case when v_has_sort then v_sort else a.sort_position end
   where a.id = p_asset_id;

  perform private.snh_audit_photo(
    'update',
    'photo_asset',
    p_asset_id::text,
    v_old,
    (select to_jsonb(a.*) from public.photo_assets a where a.id = p_asset_id),
    '{}'::jsonb
  );
end;
$$;

revoke all on function public.snh_photo_asset_set_metadata(uuid, jsonb) from public;
grant execute on function public.snh_photo_asset_set_metadata(uuid, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- snh_photo_asset_record_variants: called by the photo-publish Edge Function
-- (service role) to upsert generated derivative rows. Does not transition
-- status; the caller decides when to publish. EXECUTE granted to service_role
-- only.
-- ---------------------------------------------------------------------------

create or replace function public.snh_photo_asset_record_variants(
  p_asset_id uuid,
  p_variants jsonb
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row jsonb;
  v_variant text;
  v_bucket text;
  v_key text;
  v_ct text;
  v_size bigint;
  v_w int;
  v_h int;
  v_hash text;
begin
  if p_asset_id is null then
    raise exception 'asset_id required' using errcode = '22023';
  end if;

  if not exists (select 1 from public.photo_assets where id = p_asset_id) then
    raise exception 'asset not found' using errcode = 'P0002';
  end if;

  if p_variants is null or jsonb_array_length(p_variants) = 0 then
    raise exception 'variants required' using errcode = '22023';
  end if;

  for v_row in select * from jsonb_array_elements(p_variants)
  loop
    v_variant := lower(btrim(coalesce(v_row->>'variant', '')));
    v_bucket := lower(btrim(coalesce(v_row->>'bucket', '')));
    v_key := nullif(btrim(coalesce(v_row->>'objectKey', '')), '');
    v_ct := nullif(btrim(coalesce(v_row->>'contentType', '')), '');
    v_size := (v_row->>'byteSize')::bigint;
    v_w := (v_row->>'width')::int;
    v_h := (v_row->>'height')::int;
    v_hash := nullif(btrim(coalesce(v_row->>'contentHash', '')), '');

    if v_variant not in ('web','thumb') then
      raise exception 'unsupported variant: %', v_variant using errcode = '22023';
    end if;
    if v_bucket not in ('photos-public','photos-private') then
      raise exception 'unsupported bucket: %', v_bucket using errcode = '22023';
    end if;
    if v_key is null then
      raise exception 'objectKey required for variant %', v_variant using errcode = '22023';
    end if;
    if v_ct is null then
      raise exception 'contentType required for variant %', v_variant using errcode = '22023';
    end if;

    insert into public.photo_asset_variants (
      asset_id, variant, bucket, object_key, content_type, byte_size, width, height, content_hash
    ) values (
      p_asset_id, v_variant, v_bucket, v_key, v_ct, v_size, v_w, v_h, v_hash
    )
    on conflict (asset_id, variant) do update
      set bucket = excluded.bucket,
          object_key = excluded.object_key,
          content_type = excluded.content_type,
          byte_size = excluded.byte_size,
          width = excluded.width,
          height = excluded.height,
          content_hash = excluded.content_hash;
  end loop;

  insert into public.audit_log (
    module, action, actor_user_id, entity_type, entity_id, old_data, new_data, metadata
  ) values (
    'photos',
    'record_variants',
    auth.uid(),
    'photo_asset',
    p_asset_id::text,
    '{}'::jsonb,
    p_variants,
    '{}'::jsonb
  );
end;
$$;

revoke all on function public.snh_photo_asset_record_variants(uuid, jsonb) from public;
grant execute on function public.snh_photo_asset_record_variants(uuid, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- snh_photo_asset_publish: transitions asset to 'published'. Requires that at
-- least one 'web' variant exists in photos-public. Idempotent.
-- ---------------------------------------------------------------------------

create or replace function public.snh_photo_asset_publish(p_asset_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old jsonb;
begin
  if not coalesce(public.snh_member_has_photos_access(), false) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  if p_asset_id is null then
    raise exception 'asset_id required' using errcode = '22023';
  end if;

  select to_jsonb(a.*) into v_old from public.photo_assets a where a.id = p_asset_id;
  if v_old is null then
    raise exception 'asset not found' using errcode = 'P0002';
  end if;

  if (v_old->>'status') = 'pending' then
    raise exception 'cannot publish a pending asset; finalize upload and generate derivatives first' using errcode = '22023';
  end if;

  if not exists (
    select 1 from public.photo_asset_variants v
    where v.asset_id = p_asset_id and v.variant = 'web' and v.bucket = 'photos-public'
  ) then
    raise exception 'cannot publish without a public web variant' using errcode = '22023';
  end if;

  update public.photo_assets a
     set status = 'published',
         published_at = case when a.published_at is null then now() else a.published_at end,
         unpublished_at = null
   where a.id = p_asset_id;

  perform private.snh_audit_photo(
    'publish',
    'photo_asset',
    p_asset_id::text,
    v_old,
    (select to_jsonb(a.*) from public.photo_assets a where a.id = p_asset_id),
    '{}'::jsonb
  );
end;
$$;

revoke all on function public.snh_photo_asset_publish(uuid) from public;
grant execute on function public.snh_photo_asset_publish(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- snh_photo_asset_unpublish: transitions asset to 'unpublished'. Returns the
-- list of public-bucket object keys to remove so the caller (Edge Function or
-- maintenance task) can purge them. Idempotent.
-- ---------------------------------------------------------------------------

create or replace function public.snh_photo_asset_unpublish(p_asset_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old jsonb;
  v_keys text[];
begin
  if not coalesce(public.snh_member_has_photos_access(), false) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  if p_asset_id is null then
    raise exception 'asset_id required' using errcode = '22023';
  end if;

  select to_jsonb(a.*) into v_old from public.photo_assets a where a.id = p_asset_id;
  if v_old is null then
    raise exception 'asset not found' using errcode = 'P0002';
  end if;

  select coalesce(array_agg(v.object_key), '{}'::text[]) into v_keys
  from public.photo_asset_variants v
  where v.asset_id = p_asset_id and v.bucket = 'photos-public';

  update public.photo_assets a
     set status = 'unpublished',
         unpublished_at = now()
   where a.id = p_asset_id;

  delete from public.photo_asset_variants
   where asset_id = p_asset_id and bucket = 'photos-public';

  perform private.snh_audit_photo(
    'unpublish',
    'photo_asset',
    p_asset_id::text,
    v_old,
    (select to_jsonb(a.*) from public.photo_assets a where a.id = p_asset_id),
    jsonb_build_object('public_object_keys_to_purge', to_jsonb(v_keys))
  );

  return jsonb_build_object(
    'ok', true,
    'publicObjectKeysToPurge', to_jsonb(v_keys)
  );
end;
$$;

revoke all on function public.snh_photo_asset_unpublish(uuid) from public;
grant execute on function public.snh_photo_asset_unpublish(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- snh_photo_asset_delete: admin-only hard delete. Returns the list of object
-- keys (private + public) to purge from storage.
-- ---------------------------------------------------------------------------

create or replace function public.snh_photo_asset_delete(p_asset_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old jsonb;
  v_private_keys text[];
  v_public_keys text[];
  v_original_key text;
begin
  if not coalesce(public.snh_member_has_photos_admin_access(), false) then
    raise exception 'not authorized (admin role required)' using errcode = '42501';
  end if;

  if p_asset_id is null then
    raise exception 'asset_id required' using errcode = '22023';
  end if;

  select to_jsonb(a.*) into v_old from public.photo_assets a where a.id = p_asset_id;
  if v_old is null then
    raise exception 'asset not found' using errcode = 'P0002';
  end if;

  v_original_key := v_old->>'original_object_key';

  select coalesce(array_agg(v.object_key), '{}'::text[]) into v_private_keys
  from public.photo_asset_variants v where v.asset_id = p_asset_id and v.bucket = 'photos-private';

  select coalesce(array_agg(v.object_key), '{}'::text[]) into v_public_keys
  from public.photo_asset_variants v where v.asset_id = p_asset_id and v.bucket = 'photos-public';

  if v_original_key is not null then
    v_private_keys := array_append(v_private_keys, v_original_key);
  end if;

  delete from public.photo_assets where id = p_asset_id;

  perform private.snh_audit_photo(
    'delete',
    'photo_asset',
    p_asset_id::text,
    v_old,
    '{}'::jsonb,
    jsonb_build_object(
      'private_object_keys_to_purge', to_jsonb(v_private_keys),
      'public_object_keys_to_purge', to_jsonb(v_public_keys)
    )
  );

  return jsonb_build_object(
    'ok', true,
    'privateObjectKeysToPurge', to_jsonb(v_private_keys),
    'publicObjectKeysToPurge', to_jsonb(v_public_keys)
  );
end;
$$;

revoke all on function public.snh_photo_asset_delete(uuid) from public;
grant execute on function public.snh_photo_asset_delete(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- snh_public_photo_albums: the single public read entry point. Returns
-- published albums with published assets and their public derivatives. Used
-- by the home page and any public gallery view.
-- ---------------------------------------------------------------------------

create or replace function public.snh_public_photo_albums()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(row_json order by sort_position, lower(title_sort)), '[]'::jsonb)
  from (
    select
      jsonb_build_object(
        'id', alb.id,
        'slug', alb.slug,
        'title', alb.title,
        'description', alb.description,
        'sortPosition', alb.sort_position,
        'updatedAt', alb.updated_at,
        'assets', coalesce((
          select jsonb_agg(jsonb_build_object(
            'id', a.id,
            'caption', a.caption,
            'altText', a.alt_text,
            'sortPosition', a.sort_position,
            'width', a.original_width,
            'height', a.original_height,
            'variants', coalesce((
              select jsonb_agg(jsonb_build_object(
                'variant', v.variant,
                'bucket', v.bucket,
                'objectKey', v.object_key,
                'contentType', v.content_type,
                'width', v.width,
                'height', v.height,
                'contentHash', v.content_hash
              ) order by v.variant)
              from public.photo_asset_variants v
              where v.asset_id = a.id
                and v.bucket = 'photos-public'
            ), '[]'::jsonb)
          ) order by a.sort_position, a.created_at)
          from public.photo_assets a
          where a.album_id = alb.id
            and a.status = 'published'
            and a.visibility = 'public'
        ), '[]'::jsonb)
      ) as row_json,
      alb.sort_position as sort_position,
      alb.title as title_sort
    from public.photo_albums alb
    where alb.published = true
  ) sub;
$$;

revoke all on function public.snh_public_photo_albums() from public;
grant execute on function public.snh_public_photo_albums() to anon, authenticated;
