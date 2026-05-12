-- Photos foundation: tables, scope columns, helpers, RLS, and audit shim.
-- Implements the data + access model for the dynamic photo gallery as
-- described in docs/photos-foundation.md.
--
-- Buckets and storage policies live in 20260512110000_photos_storage_buckets.sql.
-- RPCs live in 20260512120000_photos_rpcs.sql.

create extension if not exists pgcrypto;

create schema if not exists private;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table if not exists public.photo_albums (
  id uuid primary key default gen_random_uuid(),
  scope_type text not null default 'club',
  scope_id text not null default 'snh',
  slug text not null,
  title text not null,
  description text,
  sort_position integer not null default 0,
  published boolean not null default false,
  cover_asset_id uuid,
  created_by uuid references public.members(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint photo_albums_scope_type_format check (scope_type ~ '^[a-z][a-z0-9_]*$'),
  constraint photo_albums_scope_id_format check (length(scope_id) between 1 and 80),
  constraint photo_albums_slug_format check (slug ~ '^[a-z0-9][a-z0-9_-]{0,80}$'),
  constraint photo_albums_title_len check (length(title) between 1 and 200),
  constraint photo_albums_scope_slug_unique unique (scope_type, scope_id, slug)
);

comment on table public.photo_albums is
  'Logical groupings of photo assets. Tenant-safe: scope_type+scope_id will become tenant_id-equivalent.';

create index if not exists photo_albums_scope_idx
  on public.photo_albums (scope_type, scope_id);
create index if not exists photo_albums_published_idx
  on public.photo_albums (published);
create index if not exists photo_albums_sort_idx
  on public.photo_albums (scope_type, scope_id, sort_position);


create table if not exists public.photo_assets (
  id uuid primary key default gen_random_uuid(),
  album_id uuid not null references public.photo_albums(id) on delete cascade,
  scope_type text not null default 'club',
  scope_id text not null default 'snh',
  status text not null default 'pending',
  visibility text not null default 'public',
  caption text,
  alt_text text,
  sort_position integer not null default 0,
  original_object_key text,
  original_content_type text,
  original_byte_size bigint,
  original_content_hash text,
  original_width integer,
  original_height integer,
  original_filename text,
  published_at timestamptz,
  unpublished_at timestamptz,
  created_by uuid references public.members(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint photo_assets_status_chk check (status in ('pending','uploaded','published','unpublished')),
  constraint photo_assets_visibility_chk check (visibility in ('public','private')),
  constraint photo_assets_caption_len check (caption is null or length(caption) <= 1000),
  constraint photo_assets_alt_len check (alt_text is null or length(alt_text) <= 500),
  constraint photo_assets_byte_size_chk check (original_byte_size is null or original_byte_size between 0 and 50 * 1024 * 1024),
  constraint photo_assets_content_type_chk check (
    original_content_type is null
    or original_content_type in ('image/jpeg','image/png')
  ),
  constraint photo_assets_scope_type_format check (scope_type ~ '^[a-z][a-z0-9_]*$')
);

comment on table public.photo_assets is
  'A single uploaded photo. Originals live in storage bucket photos-private under <scope_type>/<scope_id>/<album_id>/<asset_id>/.';

create index if not exists photo_assets_album_idx on public.photo_assets (album_id);
create index if not exists photo_assets_scope_idx on public.photo_assets (scope_type, scope_id);
create index if not exists photo_assets_status_idx on public.photo_assets (status);
create index if not exists photo_assets_published_idx on public.photo_assets (album_id, status) where status = 'published';
create index if not exists photo_assets_sort_idx on public.photo_assets (album_id, sort_position);

-- Soft FK from photo_albums.cover_asset_id -> photo_assets.id (added after both
-- tables exist; on delete set null so we can delete an asset that doubles as
-- the album cover).
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'photo_albums_cover_asset_fk'
  ) then
    alter table public.photo_albums
      add constraint photo_albums_cover_asset_fk
      foreign key (cover_asset_id) references public.photo_assets(id) on delete set null;
  end if;
end $$;


create table if not exists public.photo_asset_variants (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null references public.photo_assets(id) on delete cascade,
  variant text not null,
  bucket text not null,
  object_key text not null,
  content_type text not null,
  byte_size bigint,
  width integer,
  height integer,
  content_hash text,
  created_at timestamptz not null default now(),
  constraint photo_asset_variants_variant_chk check (variant in ('web','thumb')),
  constraint photo_asset_variants_bucket_chk check (bucket in ('photos-public','photos-private')),
  constraint photo_asset_variants_unique unique (asset_id, variant)
);

comment on table public.photo_asset_variants is
  'Server-generated derivatives (web, thumb). Public derivatives live in photos-public; nothing else is publicly readable.';

create index if not exists photo_asset_variants_asset_idx on public.photo_asset_variants (asset_id);

-- ---------------------------------------------------------------------------
-- updated_at triggers (reuse the games-catalog setter)
-- ---------------------------------------------------------------------------

drop trigger if exists trg_photo_albums_set_updated_at on public.photo_albums;
create trigger trg_photo_albums_set_updated_at
before update on public.photo_albums
for each row execute function public.set_games_catalog_updated_at();

drop trigger if exists trg_photo_assets_set_updated_at on public.photo_assets;
create trigger trg_photo_assets_set_updated_at
before update on public.photo_assets
for each row execute function public.set_games_catalog_updated_at();

-- ---------------------------------------------------------------------------
-- Access helpers
-- ---------------------------------------------------------------------------

create or replace function public.snh_member_has_photos_access()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.member_roles mr
    join public.members m on m.id = mr.member_id
    where m.user_id = auth.uid()
      and mr.role_slug in ('photos_editor', 'photos_admin', 'club_admin')
  );
$$;

revoke all on function public.snh_member_has_photos_access() from public;
grant execute on function public.snh_member_has_photos_access() to authenticated;


create or replace function public.snh_member_has_photos_admin_access()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.member_roles mr
    join public.members m on m.id = mr.member_id
    where m.user_id = auth.uid()
      and mr.role_slug in ('photos_admin', 'club_admin')
  );
$$;

revoke all on function public.snh_member_has_photos_admin_access() from public;
grant execute on function public.snh_member_has_photos_admin_access() to authenticated;

-- ---------------------------------------------------------------------------
-- Audit shim (writes to the shared public.audit_log table)
-- ---------------------------------------------------------------------------

create or replace function private.snh_audit_photo(
  p_action text,
  p_entity_type text,
  p_entity_id text,
  p_old jsonb,
  p_new jsonb,
  p_meta jsonb default '{}'::jsonb
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.audit_log (
    module, action, actor_user_id, entity_type, entity_id, old_data, new_data, metadata
  ) values (
    'photos',
    p_action,
    auth.uid(),
    p_entity_type,
    p_entity_id,
    coalesce(p_old, '{}'::jsonb),
    coalesce(p_new, '{}'::jsonb),
    coalesce(p_meta, '{}'::jsonb)
  );
end;
$$;

revoke all on function private.snh_audit_photo(text, text, text, jsonb, jsonb, jsonb) from public;

-- ---------------------------------------------------------------------------
-- RLS: enable + policies
-- ---------------------------------------------------------------------------

alter table public.photo_albums enable row level security;
alter table public.photo_assets enable row level security;
alter table public.photo_asset_variants enable row level security;

-- Public can read published albums.
drop policy if exists photo_albums_public_read on public.photo_albums;
create policy photo_albums_public_read
  on public.photo_albums
  for select
  to anon, authenticated
  using (published = true);

-- Editors can read all albums (published + unpublished).
drop policy if exists photo_albums_editors_read on public.photo_albums;
create policy photo_albums_editors_read
  on public.photo_albums
  for select
  to authenticated
  using (coalesce(public.snh_member_has_photos_access(), false));

-- All writes to photo_albums go through SECURITY DEFINER RPCs; no direct
-- INSERT / UPDATE / DELETE policy for authenticated clients.

-- Public can read published assets in published albums; private/unpublished
-- assets are only readable by editors. Variants follow the parent asset.
drop policy if exists photo_assets_public_read on public.photo_assets;
create policy photo_assets_public_read
  on public.photo_assets
  for select
  to anon, authenticated
  using (
    status = 'published'
    and visibility = 'public'
    and exists (
      select 1
      from public.photo_albums a
      where a.id = photo_assets.album_id
        and a.published = true
    )
  );

drop policy if exists photo_assets_editors_read on public.photo_assets;
create policy photo_assets_editors_read
  on public.photo_assets
  for select
  to authenticated
  using (coalesce(public.snh_member_has_photos_access(), false));

-- Variants public read: only when parent asset is public-readable.
drop policy if exists photo_asset_variants_public_read on public.photo_asset_variants;
create policy photo_asset_variants_public_read
  on public.photo_asset_variants
  for select
  to anon, authenticated
  using (
    bucket = 'photos-public'
    and exists (
      select 1
      from public.photo_assets a
      join public.photo_albums alb on alb.id = a.album_id
      where a.id = photo_asset_variants.asset_id
        and a.status = 'published'
        and a.visibility = 'public'
        and alb.published = true
    )
  );

drop policy if exists photo_asset_variants_editors_read on public.photo_asset_variants;
create policy photo_asset_variants_editors_read
  on public.photo_asset_variants
  for select
  to authenticated
  using (coalesce(public.snh_member_has_photos_access(), false));

-- No direct INSERT / UPDATE / DELETE on assets or variants for any client
-- role; everything goes through SECURITY DEFINER RPCs and the photo Edge
-- Functions running as service_role.

-- ---------------------------------------------------------------------------
-- Public read view: keeps the public surface narrow and stable.
-- ---------------------------------------------------------------------------

create or replace view public.photo_albums_public_v1 as
select
  alb.id,
  alb.slug,
  alb.title,
  alb.description,
  alb.sort_position,
  alb.cover_asset_id,
  alb.created_at,
  alb.updated_at
from public.photo_albums alb
where alb.published = true;

comment on view public.photo_albums_public_v1 is
  'Stable public surface for published albums; no scope columns leaked.';

create or replace view public.photo_assets_public_v1 as
select
  a.id,
  a.album_id,
  a.caption,
  a.alt_text,
  a.sort_position,
  a.original_width,
  a.original_height,
  a.published_at
from public.photo_assets a
join public.photo_albums alb on alb.id = a.album_id
where a.status = 'published'
  and a.visibility = 'public'
  and alb.published = true;

comment on view public.photo_assets_public_v1 is
  'Stable public surface for published photo assets; pair with photo_asset_variants_public_v1 for URLs.';

create or replace view public.photo_asset_variants_public_v1 as
select
  v.id,
  v.asset_id,
  v.variant,
  v.bucket,
  v.object_key,
  v.content_type,
  v.width,
  v.height,
  v.content_hash
from public.photo_asset_variants v
join public.photo_assets a on a.id = v.asset_id
join public.photo_albums alb on alb.id = a.album_id
where v.bucket = 'photos-public'
  and a.status = 'published'
  and a.visibility = 'public'
  and alb.published = true;

comment on view public.photo_asset_variants_public_v1 is
  'Stable public surface for derivative URLs; only photos-public variants of published assets.';

grant select on public.photo_albums_public_v1 to anon, authenticated;
grant select on public.photo_assets_public_v1 to anon, authenticated;
grant select on public.photo_asset_variants_public_v1 to anon, authenticated;
