-- Photo Management 2.0. Existing originals and role helpers are untouched.
-- Only bounded browser derivatives are accepted for new photos.
alter table public.photo_assets add column upload_mode text not null default 'legacy'
  check (upload_mode in ('legacy','browser'));
alter table public.photo_assets add column upload_revision integer not null default 0;
alter table public.photo_assets add column upload_token uuid;
alter table public.photo_assets add column upload_expires_at timestamptz;

create table private.photo_storage_cleanup (
 id bigint generated always as identity primary key,
 bucket text not null check (bucket in ('photos-public','photos-private')),
 object_key text not null,
 not_before timestamptz not null default now(),
 attempts integer not null default 0,
 last_error text,
 unique(bucket,object_key)
);
revoke all on private.photo_storage_cleanup from public,anon,authenticated;
grant usage on schema private to service_role;
grant all on private.photo_storage_cleanup to service_role;

-- Queue removals in the same transaction as metadata changes, including cascades.
create function private.snh_photo_queue_removed() returns trigger
language plpgsql security definer set search_path=public,private as $$
begin
 if tg_table_name='photo_asset_variants' then
  if tg_op='DELETE' or old.object_key is distinct from new.object_key or old.bucket is distinct from new.bucket then
   insert into private.photo_storage_cleanup(bucket,object_key) values(old.bucket,old.object_key)
    on conflict(bucket,object_key) do update set not_before=now();
  end if;
 else
  if old.original_object_key is not null then
   insert into private.photo_storage_cleanup(bucket,object_key) values('photos-private',old.original_object_key)
    on conflict(bucket,object_key) do nothing;
  end if;
  if old.upload_mode='browser' then
   insert into private.photo_storage_cleanup(bucket,object_key,not_before)
    select 'photos-private',format('%s/%s/%s/%s/staged-%s-%s.webp',old.scope_type,old.scope_id,old.album_id,old.id,old.upload_token,v),
      greatest(now(),old.upload_expires_at + interval '10 minutes')
    from unnest(array['web','thumb']) v
    on conflict(bucket,object_key) do update set not_before=greatest(photo_storage_cleanup.not_before,excluded.not_before);
  end if;
 end if;
 return old;
end $$;
revoke all on function private.snh_photo_queue_removed() from public;
create trigger photo_variant_cleanup after delete or update on public.photo_asset_variants
 for each row execute function private.snh_photo_queue_removed();
create trigger photo_asset_cleanup before delete on public.photo_assets
 for each row execute function private.snh_photo_queue_removed();

-- Ensure covers belong to their album; existing rows are preserved.
create function private.snh_photo_check_cover() returns trigger language plpgsql
set search_path=public as $$ begin
 if new.cover_asset_id is not null and (tg_op='INSERT' or new.cover_asset_id is distinct from old.cover_asset_id)
 and not exists(select 1 from photo_assets where id=new.cover_asset_id and album_id=new.id) then
  raise exception 'cover must belong to this album' using errcode='22023';
 end if;
 return new;
end $$;
create trigger photo_album_cover_check before insert or update on public.photo_albums
 for each row execute function private.snh_photo_check_cover();
revoke all on function private.snh_photo_check_cover() from public;

-- Disable the retired original upload/finalization paths after rollout.
revoke execute on function public.snh_photo_assets_create_pending(uuid,uuid,text,bigint,text) from service_role;
revoke execute on function public.snh_photo_asset_finalize_upload(uuid,bigint,text,integer,integer) from authenticated;

create function public.snh_photo_browser_intent(p_album_id uuid,p_actor_user_id uuid,p_filename text,p_asset_id uuid default null)
returns jsonb language plpgsql security definer set search_path=public as $$
declare a photo_albums; x photo_assets; token uuid:=gen_random_uuid();
begin
 select * into a from photo_albums where id=p_album_id for update;
 if not found then raise exception 'album not found'; end if;
 if p_asset_id is not null then
  select * into x from photo_assets where id=p_asset_id and album_id=p_album_id for update;
  if not found or x.original_object_key is null or x.status not in ('pending','uploaded','unpublished') then raise exception 'legacy photo is not convertible'; end if;
  if x.upload_mode='browser' and x.status='pending' and x.upload_expires_at>now() then
   token:=x.upload_token;
  else
   if x.upload_mode='browser' then
    insert into private.photo_storage_cleanup(bucket,object_key,not_before)
    select 'photos-private',format('%s/%s/%s/%s/staged-%s-%s.webp',x.scope_type,x.scope_id,x.album_id,x.id,x.upload_token,v),
      greatest(now(),x.upload_expires_at+interval '10 minutes') from unnest(array['web','thumb']) v on conflict do nothing;
   end if;
  update photo_assets set upload_mode='browser',upload_token=token,upload_expires_at=now()+interval '2 hours',status='pending',upload_revision=upload_revision+1
  where id=x.id returning * into x;
  end if;
 else
 insert into photo_assets(album_id,scope_type,scope_id,original_filename,created_by,upload_mode,upload_token,upload_expires_at)
 values(a.id,a.scope_type,a.scope_id,left(p_filename,200),(select id from members where user_id=p_actor_user_id),
 'browser',token,now()+interval '2 hours') returning * into x;
 end if;
 return jsonb_build_object('assetId',x.id,'uploadToken',token,'expiresAt',x.upload_expires_at,
 'prefix',format('%s/%s/%s/%s',a.scope_type,a.scope_id,a.id,x.id));
end $$;
revoke all on function public.snh_photo_browser_intent(uuid,uuid,text,uuid) from public,anon,authenticated;
grant execute on function public.snh_photo_browser_intent(uuid,uuid,text,uuid) to service_role;

-- Atomic finalization/publish with a token and state check prevents stale work resurrecting a photo.
create function public.snh_photo_browser_commit(p_asset_id uuid,p_token uuid,p_variants jsonb,p_actor_user_id uuid,p_publish boolean default false,p_revision integer default 0)
returns void language plpgsql security definer set search_path=public as $$
declare a photo_assets; v jsonb; prefix text; n int:=0;
begin
 select * into a from photo_assets where id=p_asset_id for update;
 if not found or a.upload_mode<>'browser' or a.upload_token is distinct from p_token
 or (not p_publish and (a.status<>'pending' or a.upload_expires_at<now()))
 or a.upload_revision<>p_revision
 or (p_publish and a.status not in ('uploaded','unpublished','published')) then
  raise exception 'photo changed or upload expired; reload and retry';
 end if;
 prefix:=format('%s/%s/%s/%s/',a.scope_type,a.scope_id,a.album_id,a.id);
 if jsonb_array_length(p_variants)<>2 then raise exception 'two variants required'; end if;
 for v in select * from jsonb_array_elements(p_variants) loop
  if v->>'variant' not in ('web','thumb') or v->>'contentType'<>'image/webp'
   or v->>'bucket'<>(case when p_publish then 'photos-public' else 'photos-private' end)
   or left(v->>'objectKey',length(prefix))<>prefix
   or (v->>'width')::int not between 1 and (case when v->>'variant'='web' then 1920 else 640 end)
   or (v->>'height')::int not between 1 and (case when v->>'variant'='web' then 1920 else 640 end)
   or (v->>'byteSize')::bigint not between 1 and 8388608
   or (v->>'contentHash') !~ '^[0-9a-f]{64}$' then raise exception 'invalid derivative'; end if;
  if not p_publish and v->>'objectKey'<>prefix||'staged-'||p_token||'-'||(v->>'variant')||'.webp' then
   raise exception 'invalid staged path'; end if;
  n:=n+case when v->>'variant'='web' then 1 else 10 end;
 end loop;
 if n<>11 then raise exception 'web and thumb required'; end if;
 perform snh_photo_asset_record_variants(p_asset_id,p_variants);
 delete from private.photo_storage_cleanup c where exists(select 1 from jsonb_array_elements(p_variants) as item(payload)
  where item.payload->>'bucket'=c.bucket and item.payload->>'objectKey'=c.object_key);
 update photo_assets set status=case when p_publish then 'published' else 'uploaded' end,
 published_at=case when p_publish then coalesce(published_at,now()) else published_at end,unpublished_at=null where id=p_asset_id;
 insert into audit_log(module,action,actor_user_id,entity_type,entity_id,old_data,new_data,metadata)
 values('photos',case when p_publish then 'publish' else 'finalize_upload' end,p_actor_user_id,'photo_asset',p_asset_id::text,to_jsonb(a),p_variants,'{}');
end $$;
revoke all on function public.snh_photo_browser_commit(uuid,uuid,jsonb,uuid,boolean,integer) from public,anon,authenticated;
grant execute on function public.snh_photo_browser_commit(uuid,uuid,jsonb,uuid,boolean,integer) to service_role;

-- Service-only outbox API: reference checks protect retained originals and current variants.
create function public.snh_photo_cleanup_list() returns jsonb language plpgsql security definer set search_path=public,private as $$
begin
 -- Expired upgrades are rolled back without deleting retained originals.
 insert into private.photo_storage_cleanup(bucket,object_key)
 select 'photos-private',format('%s/%s/%s/%s/staged-%s-%s.webp',a.scope_type,a.scope_id,a.album_id,a.id,a.upload_token,v)
 from photo_assets a cross join unnest(array['web','thumb']) v
 where a.upload_mode='browser' and a.status='pending' and a.original_object_key is not null and a.upload_expires_at<now()-interval '24 hours'
 on conflict do nothing;
 update photo_assets set upload_mode='legacy',status='uploaded',upload_token=null,upload_expires_at=null,upload_revision=upload_revision+1
 where upload_mode='browser' and status='pending' and original_object_key is not null and upload_expires_at<now()-interval '24 hours';
 delete from photo_assets where id in(select id from photo_assets where upload_mode='browser' and status='pending'
 and original_object_key is null and upload_expires_at<now()-interval '24 hours' order by upload_expires_at limit 100);
 return (select coalesce(jsonb_agg(to_jsonb(q)),'[]') from (
 select c.* from private.photo_storage_cleanup c where not_before<=now()
 and not exists(select 1 from photo_asset_variants v where v.bucket=c.bucket and v.object_key=c.object_key)
 and not exists(select 1 from photo_assets a where c.bucket='photos-private' and
 (a.original_object_key=c.object_key or (a.upload_mode='browser' and c.object_key in (
 format('%s/%s/%s/%s/staged-%s-web.webp',a.scope_type,a.scope_id,a.album_id,a.id,a.upload_token),
 format('%s/%s/%s/%s/staged-%s-thumb.webp',a.scope_type,a.scope_id,a.album_id,a.id,a.upload_token)))))
 order by c.id limit 100) q);
end $$;
create function public.snh_photo_cleanup_ack(p_id bigint,p_error text default null) returns void
language plpgsql security definer set search_path=public,private as $$ begin
 if p_error is null then delete from private.photo_storage_cleanup where id=p_id;
 else update private.photo_storage_cleanup set attempts=attempts+1,last_error=left(p_error,500),not_before=now()+interval '5 minutes' where id=p_id; end if;
end $$;
revoke all on function public.snh_photo_cleanup_list() from public,anon,authenticated;
revoke all on function public.snh_photo_cleanup_ack(bigint,text) from public,anon,authenticated;
grant execute on function public.snh_photo_cleanup_list() to service_role;
grant execute on function public.snh_photo_cleanup_ack(bigint,text) to service_role;
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
         upload_revision = upload_revision + 1,
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
        'coverAssetId', alb.cover_asset_id,
        'title', alb.title,
        'description', alb.description,
        'sortPosition', alb.sort_position,
        'updatedAt', alb.updated_at,
        'eventId', alb.event_id,
        'eventStartsAt', ev.starts_at,
        'eventTitle', ev.title,
        'displayAt', alb.display_at,
        'assets', coalesce((
          select jsonb_agg(jsonb_build_object(
            'id', a.id,
            'caption', a.caption,
            'altText', a.alt_text,
            'sortPosition', a.sort_position,
            'excludeFromSlideshow', a.exclude_from_slideshow,
            'promoRole', a.promo_role,
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
    left join public.events ev on ev.id = alb.event_id
    where alb.published = true
  ) sub;
$$;

create table public.event_photo_promotions (
 event_id uuid primary key references public.events(id) on delete cascade,
 asset_id uuid not null references public.photo_assets(id) on delete cascade
);
alter table public.event_photo_promotions enable row level security;
revoke all on public.event_photo_promotions from anon,authenticated;
create function public.snh_photo_event_promo_set(p_event_id uuid,p_asset_id uuid) returns void
language plpgsql security definer set search_path=public as $$ begin
 if not coalesce(snh_member_has_photos_access(),false) then raise exception 'not authorized' using errcode='42501'; end if;
 if not exists(select 1 from events where id=p_event_id and coalesce(published,true)) then raise exception 'published event required'; end if;
 if p_asset_id is null then delete from event_photo_promotions where event_id=p_event_id;
 else
 if not exists(select 1 from photo_assets a join photo_albums b on b.id=a.album_id
 where a.id=p_asset_id and a.status='published' and a.visibility='public' and b.published) then raise exception 'published photo and album required'; end if;
 insert into event_photo_promotions values(p_event_id,p_asset_id) on conflict(event_id) do update set asset_id=excluded.asset_id;
 end if;
 perform private.snh_audit_photo('set_event_promo','event',p_event_id::text,'{}',jsonb_build_object('assetId',p_asset_id));
end $$;
revoke all on function public.snh_photo_event_promo_set(uuid,uuid) from public,anon;
grant execute on function public.snh_photo_event_promo_set(uuid,uuid) to authenticated;
create or replace function public.snh_public_event_promo_asset(p_event_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_asset_id uuid;
  v_album_id uuid;
  v_caption text;
  v_alt text;
  v_w int;
  v_h int;
  v_variants jsonb;
begin
  if p_event_id is null then
    return null;
  end if;

  if not exists (
    select 1 from public.events e
    where e.id = p_event_id and coalesce(e.published, true) = true
  ) then
    return null;
  end if;

  select a.id, a.album_id, a.caption, a.alt_text, a.original_width, a.original_height
  into v_asset_id, v_album_id, v_caption, v_alt, v_w, v_h
  from public.photo_assets a
  join public.photo_albums alb on alb.id = a.album_id
  where (a.id=(select asset_id from event_photo_promotions where event_id=p_event_id) or (alb.event_id = p_event_id and a.promo_role='event_hero'))
    and alb.published = true
    and a.status = 'published'
    and a.visibility = 'public'

  order by (a.id=(select asset_id from event_photo_promotions where event_id=p_event_id)) desc nulls last,a.published_at asc nulls last
  limit 1;

  if not found or v_asset_id is null then
    return null;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'variant', v.variant,
    'bucket', v.bucket,
    'objectKey', v.object_key,
    'contentType', v.content_type,
    'width', v.width,
    'height', v.height,
    'contentHash', v.content_hash
  ) order by v.variant), '[]'::jsonb)
  into v_variants
  from public.photo_asset_variants v
  where v.asset_id = v_asset_id
    and v.bucket = 'photos-public';

  return jsonb_build_object(
    'eventId', p_event_id,
    'assetId', v_asset_id,
    'albumId', v_album_id,
    'caption', v_caption,
    'altText', v_alt,
    'width', v_w,
    'height', v_h,
    'variants', v_variants
  );
end;
$$;

create function public.snh_photo_queue_storage(p_bucket text,p_key text) returns void
language plpgsql security definer set search_path=public,private as $$ begin
 if p_bucket<>'photos-public' or p_key !~ '^[^/]+/[^/]+/[0-9a-f-]+/[0-9a-f-]+/(web|thumb)-[0-9a-f-]+-[0-9a-f]{12}\.webp$' then raise exception 'invalid cleanup key'; end if;
 insert into private.photo_storage_cleanup(bucket,object_key,not_before) values(p_bucket,p_key,now()+interval '10 minutes') on conflict do nothing;
end $$;
revoke all on function public.snh_photo_queue_storage(text,text) from public,anon,authenticated;
grant execute on function public.snh_photo_queue_storage(text,text) to service_role;

-- Bucket limits apply to new writes; retained originals are never rewritten.
update storage.buckets set allowed_mime_types=array['image/jpeg','image/png','image/webp'],file_size_limit=8388608
 where id in ('photos-private','photos-public');

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
        'uploadMode', a.upload_mode,
        'hasOriginal', a.original_object_key is not null,
        'visibility', a.visibility,
        'caption', a.caption,
        'altText', a.alt_text,
        'sortPosition', a.sort_position,
        'excludeFromSlideshow', a.exclude_from_slideshow,
        'promoRole', a.promo_role,
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

create or replace function public.snh_event_photo_digest_for_editor(p_event_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_ok boolean;
  v_albums jsonb;
  v_hero jsonb;
begin
  if p_event_id is null then
    raise exception 'event_id required' using errcode = '22023';
  end if;

  v_ok := coalesce(public.snh_member_has_photos_access(), false)
    or exists (
      select 1
      from public.members m
      join public.member_roles mr on mr.member_id = m.id
      where m.user_id = auth.uid()
        and mr.role_slug in ('events_editor', 'events_admin', 'club_admin')
    );

  if not v_ok then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  if not exists (select 1 from public.events e where e.id = p_event_id) then
    raise exception 'event not found' using errcode = 'P0002';
  end if;

  select coalesce(jsonb_agg(row_json order by alb.sort_position, lower(title_sort)), '[]'::jsonb)
  into v_albums
  from (
    select
      jsonb_build_object(
        'id', alb.id,
        'slug', alb.slug,
        'title', alb.title,
        'published', alb.published,
        'displayAt', alb.display_at,
        'assetCounts', jsonb_build_object(
          'total', (select count(*)::int from public.photo_assets a where a.album_id = alb.id),
          'published', (
            select count(*)::int from public.photo_assets a
            where a.album_id = alb.id and a.status = 'published'
          )
        )
      ) as row_json,
      alb.sort_position as sort_position,
      coalesce(alb.title, '') as title_sort
    from public.photo_albums alb
    where alb.event_id = p_event_id
  ) sub;

  select
    case
      when ha.asset_id is null then null
      else jsonb_build_object(
        'eventId', p_event_id,
        'assetId', ha.asset_id,
        'albumId', ha.album_id,
        'caption', ha.caption,
        'altText', ha.alt_text,
        'width', ha.original_width,
        'height', ha.original_height,
        'variants', coalesce(vv.variants, '[]'::jsonb)
      )
    end
  into v_hero
  from (
    select
      a.id as asset_id,
      a.album_id,
      a.caption,
      a.alt_text,
      a.original_width,
      a.original_height
    from public.photo_assets a
    join public.photo_albums alb on alb.id = a.album_id
    where (a.id=(select asset_id from event_photo_promotions where event_id=p_event_id) or (alb.event_id=p_event_id and a.promo_role='event_hero'))
      and alb.published = true
      and a.status = 'published'
      and a.visibility = 'public'

    order by (a.id=(select asset_id from event_photo_promotions where event_id=p_event_id)) desc nulls last,a.published_at asc nulls last
    limit 1
  ) ha
  left join lateral (
    select coalesce(jsonb_agg(jsonb_build_object(
      'variant', v.variant,
      'bucket', v.bucket,
      'objectKey', v.object_key,
      'contentType', v.content_type,
      'width', v.width,
      'height', v.height,
      'contentHash', v.content_hash
    ) order by v.variant), '[]'::jsonb) as variants
    from public.photo_asset_variants v
    where v.asset_id = ha.asset_id
      and v.bucket = 'photos-public'
  ) vv on true;

  return jsonb_build_object(
    'albums', coalesce(v_albums, '[]'::jsonb),
    'hero', v_hero
  );
end;
$$;

create function public.snh_photo_cleanup_pending() returns integer language sql security definer set search_path=public,private as $$
 select count(*)::int from private.photo_storage_cleanup c where not exists(select 1 from photo_asset_variants v where v.bucket=c.bucket and v.object_key=c.object_key)
 and not exists(select 1 from photo_assets a where c.bucket='photos-private' and
 (a.original_object_key=c.object_key or (a.upload_mode='browser' and c.object_key in (
 format('%s/%s/%s/%s/staged-%s-web.webp',a.scope_type,a.scope_id,a.album_id,a.id,a.upload_token),
 format('%s/%s/%s/%s/staged-%s-thumb.webp',a.scope_type,a.scope_id,a.album_id,a.id,a.upload_token)))));
$$;
revoke all on function public.snh_photo_cleanup_pending() from public,anon,authenticated;
grant execute on function public.snh_photo_cleanup_pending() to service_role;
