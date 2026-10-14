-- Reuse sort_position for atomic photo ordering and append-on-insert.
begin;
create function private.snh_photo_append_order()
returns trigger language plpgsql security definer set search_path=public
as $$ begin
 perform 1 from public.photo_albums where id=new.album_id for update;
 select coalesce(max(sort_position),-1)+1 into new.sort_position
 from public.photo_assets where album_id=new.album_id;
 return new;
end $$;
revoke all on function private.snh_photo_append_order() from public,anon,authenticated;
create trigger photo_asset_append_order before insert on public.photo_assets
for each row execute function private.snh_photo_append_order();

create function public.snh_photo_asset_order_save(p_album_id uuid,p_asset_ids uuid[],p_expected jsonb)
returns void language plpgsql security definer set search_path=public
as $$ declare v_current jsonb; v_expected jsonb; v_count int;
begin
 if not coalesce(public.snh_member_has_photos_access(),false) then
  raise exception 'not authorized' using errcode='42501';
 end if;
 if p_album_id is null or p_expected is null or jsonb_typeof(p_expected)<>'array' then
  raise exception 'album and original photo order required' using errcode='22023';
 end if;
 -- Take table locks before row locks, matching album delete/cascade and upload order.
 -- These short locks serialize the small collection's save against CRUD and upload.
 lock table public.photo_albums in share row exclusive mode;
 lock table public.photo_assets in share row exclusive mode;
 perform 1 from public.photo_albums where id=p_album_id for update;
 if not found then raise exception 'album not found' using errcode='P0002'; end if;
 select count(*),coalesce(jsonb_agg(jsonb_build_object('id',id,'sortPosition',sort_position) order by id::text),'[]'::jsonb)
 into v_count,v_current from public.photo_assets where album_id=p_album_id;
 select coalesce(jsonb_agg(item order by item->>'id'),'[]'::jsonb) into v_expected from jsonb_array_elements(p_expected) item;
 if v_current is distinct from v_expected then
  raise exception 'Photos changed. Cancel and reopen Arrange photos to load the latest order.' using errcode='40001';
 end if;
 if p_asset_ids is null or cardinality(p_asset_ids)<>v_count
  or (select count(distinct id) from unnest(p_asset_ids) id)<>v_count
  or exists(select 1 from unnest(p_asset_ids) requested(id) where requested.id is null or not exists(select 1 from public.photo_assets a where a.album_id=p_album_id and a.id=requested.id)) then
  raise exception 'Photo order must contain every photo in this album exactly once.' using errcode='22023';
 end if;
 update public.photo_assets a set sort_position=s.position::int-1
 from unnest(p_asset_ids) with ordinality s(id,position)
 where a.album_id=p_album_id and a.id=s.id;
 perform private.snh_audit_photo('reorder','photo_album',p_album_id::text,v_current,jsonb_build_object('assetIds',p_asset_ids),'{}'::jsonb);
end $$;
revoke all on function public.snh_photo_asset_order_save(uuid,uuid[],jsonb) from public,anon,authenticated;
grant execute on function public.snh_photo_asset_order_save(uuid,uuid[],jsonb) to authenticated;
-- Feature discovery reuses the existing settings read; older frontends ignore it.
create or replace function public.snh_photo_album_order_settings()
returns jsonb language sql stable security definer set search_path=public
as $$ select jsonb_build_object('mode',mode,'revision',revision,'photoOrderAvailable',true) from private.photo_gallery_order $$;
commit;
