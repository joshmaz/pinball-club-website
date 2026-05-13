-- Album–event link + promo flags (schema only).
-- Multiple albums may share one event; photos editors link in RPC layer.

alter table public.photo_albums
  add column if not exists event_id uuid references public.events(id) on delete set null,
  add column if not exists display_at timestamptz;

create index if not exists photo_albums_event_id_idx
  on public.photo_albums (event_id)
  where event_id is not null;

alter table public.photo_assets
  add column if not exists exclude_from_slideshow boolean not null default false,
  add column if not exists promo_role text;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'photo_assets_promo_role_chk'
      and conrelid = 'public.photo_assets'::regclass
  ) then
    alter table public.photo_assets
      add constraint photo_assets_promo_role_chk check (
        promo_role is null
        or promo_role in ('event_hero', 'event_branding')
      );
  end if;
end $$;

comment on column public.photo_albums.event_id is
  'Optional link to a club event. Multiple albums may reference the same event.';
comment on column public.photo_albums.display_at is
  'Optional display or sort date for the album.';
comment on column public.photo_assets.exclude_from_slideshow is
  'When true, public home highlights mosaic skips this asset.';
comment on column public.photo_assets.promo_role is
  'event_hero: at most one per event across linked albums; event_branding: optional.';

-- Postgres does not allow CREATE OR REPLACE VIEW to insert new columns before
-- existing output columns (it would reinterpret column names). Drop and
-- recreate the public read views; they only reference base tables (not each
-- other), so order is safe. photo_asset_variants_public_v1 is unchanged.
drop view if exists public.photo_assets_public_v1 cascade;
drop view if exists public.photo_albums_public_v1 cascade;

create view public.photo_albums_public_v1 as
select
  alb.id,
  alb.slug,
  alb.title,
  alb.description,
  alb.sort_position,
  alb.cover_asset_id,
  alb.event_id,
  alb.display_at,
  alb.created_at,
  alb.updated_at
from public.photo_albums alb
where alb.published = true;

comment on view public.photo_albums_public_v1 is
  'Stable public surface for published albums; no scope columns leaked.';

create view public.photo_assets_public_v1 as
select
  a.id,
  a.album_id,
  a.caption,
  a.alt_text,
  a.sort_position,
  a.original_width,
  a.original_height,
  a.published_at,
  a.exclude_from_slideshow,
  a.promo_role
from public.photo_assets a
join public.photo_albums alb on alb.id = a.album_id
where a.status = 'published'
  and a.visibility = 'public'
  and alb.published = true;

comment on view public.photo_assets_public_v1 is
  'Stable public surface for published photo assets; pair with photo_asset_variants_public_v1 for URLs.';

grant select on public.photo_albums_public_v1 to anon, authenticated;
grant select on public.photo_assets_public_v1 to anon, authenticated;