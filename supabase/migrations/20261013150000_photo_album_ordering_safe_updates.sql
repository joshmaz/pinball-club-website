-- Explicit singleton predicates for hosted UPDATE safety checks.
begin;
create or replace function private.snh_photo_order_revision()
returns trigger language plpgsql security definer set search_path=public
as $$ begin
 if TG_OP='UPDATE' and new.sort_position is not distinct from old.sort_position then return null; end if;
 update private.photo_gallery_order set revision=revision+1 where singleton=true;
 return null;
end $$;
create or replace function public.snh_photo_album_order_save(p_mode text,p_album_ids uuid[],p_revision bigint)
returns jsonb language plpgsql security definer set search_path=public
as $$ declare v_settings private.photo_gallery_order%rowtype; v_count int;
begin
 if not coalesce(public.snh_member_has_photos_access(),false) then
  raise exception 'not authorized' using errcode='42501';
 end if;
 if p_mode is null or p_mode not in ('custom','newest') then
  raise exception 'invalid album ordering mode' using errcode='22023';
 end if;
 -- Lock the table first to match album CRUD lock order and serialize concurrent edits.
 lock table public.photo_albums in share row exclusive mode;
 select * into v_settings from private.photo_gallery_order for update;
 if p_revision is distinct from v_settings.revision then
  raise exception 'Album order changed. Cancel and reopen the sorter to load the latest albums.' using errcode='40001';
 end if;
 if p_mode='custom' then
  select count(*) into v_count from public.photo_albums;
  if p_album_ids is null or cardinality(p_album_ids)<>v_count
   or (select count(distinct id) from unnest(p_album_ids) id)<>v_count
   or exists(select 1 from unnest(p_album_ids) requested(id) where requested.id is null or not exists(select 1 from public.photo_albums a where a.id=requested.id)) then
   raise exception 'Custom order must contain every album exactly once.' using errcode='22023';
  end if;
  update public.photo_albums a set sort_position=s.position::int
   from unnest(p_album_ids) with ordinality s(id,position) where a.id=s.id;
 end if;
 update private.photo_gallery_order set mode=p_mode,revision=revision+1 where singleton=true;
 perform private.snh_audit_photo('reorder','photo_gallery','club',jsonb_build_object('mode',v_settings.mode),jsonb_build_object('mode',p_mode,'albumIds',p_album_ids),'{}'::jsonb);
 return public.snh_photo_album_order_settings();
end $$;
commit;
