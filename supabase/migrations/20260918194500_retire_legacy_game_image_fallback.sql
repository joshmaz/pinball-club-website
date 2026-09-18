-- The repo-hosted machine photos were migrated to Supabase Storage and
-- verified in production. Retire their compatibility filenames and remove the
-- one-time service-role migration RPC. Normalized game_images rows remain the
-- sole public image source.

update public.games g
set image_filename = null
where nullif(trim(g.image_filename), '') is not null
  and exists (
    select 1
    from public.game_images i
    where i.game_id = g.id
      and i.source_type = 'club'
      and i.location_type = 'remote_url'
      and i.metadata->>'storageBucket' = 'game-images'
      and i.metadata->>'migratedFromLegacyPath' =
        'assets/images/machines/' || trim(g.image_filename)
  );

drop function if exists public.snh_game_images_migrate_legacy(uuid, text, text, text, jsonb);

comment on column public.games.image_filename is
  'Deprecated compatibility field retained for old imports; public rendering uses game_images.primaryImage only.';

comment on table public.game_images is
  'Authoritative game image associations. Uploaded club photos use remote_url plus storageBucket/storagePath metadata; reference_only rows are never public.';
