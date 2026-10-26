begin;

-- Called only for a row inserted by this catalog transaction. Existing catalog
-- games (including slug conflicts and matching OPDB IDs) keep their curation.
create or replace function private.snh_pinballmap_new_game_images(p_game_id uuid, p_opdb_id text, p_images jsonb)
returns integer language plpgsql set search_path = '' as $$
declare v_row jsonb; v_count integer := 0; v_primary uuid;
begin
 if nullif(btrim(p_opdb_id),'') is null or jsonb_typeof(p_images) is distinct from 'array' then return 0; end if;
 for v_row in select value from jsonb_array_elements(p_images) loop
   if nullif(btrim(v_row->>'sourceKey'),'') is null
      or coalesce(v_row->>'imageUrl','') !~ '^https://'
      or coalesce(v_row->>'sourceUrl','') !~ '^https://' then continue; end if;
   insert into public.game_images(game_id,source_type,source_key,location_type,location_value,
     image_type,alt_text,source_url,attribution_text,attribution_url,license_name,license_url,usage_status,metadata)
   values(p_game_id,'opdb',btrim(v_row->>'sourceKey'),'remote_url',v_row->>'imageUrl',
     nullif(btrim(v_row->>'imageType'),''),nullif(btrim(v_row->>'altText'),''),v_row->>'sourceUrl',
     'Open Pinball Database (OPDB)',v_row->>'sourceUrl',nullif(btrim(v_row->>'licenseName'),''),
     nullif(btrim(v_row->>'licenseUrl'),''),'approved',coalesce(v_row->'metadata','{}'::jsonb)
       ||jsonb_build_object('opdbId',p_opdb_id,'autoApprovedVia','pinballmap_new_game'))
   on conflict(game_id,source_type,source_key) do nothing;
   if found then v_count := v_count+1; end if;
 end loop;
 -- Normalize an explicitly supplied legacy default; the public catalog prefers
 -- normalized approved rows over its legacy filename fallback.
 if v_count>0 then
   insert into public.game_images(game_id,source_type,source_key,location_type,location_value,
     usage_status,is_primary,metadata)
   select g.id,'club','legacy:'||btrim(g.image_filename),'local_asset',btrim(g.image_filename),
     'approved',true,jsonb_build_object('migratedFrom','games.image_filename')
   from public.games g where g.id=p_game_id and nullif(btrim(g.image_filename),'') is not null
     and not exists(select 1 from public.game_images i where i.game_id=p_game_id and i.is_primary)
   on conflict(game_id,source_type,source_key) do nothing;
 end if;
 -- Prefer closeup, then playfield, backglass, and other images regardless of OPDB primary.
 -- An explicitly supplied legacy/default photo always retains priority.
 if not exists(select 1 from public.games where id=p_game_id and nullif(btrim(image_filename),'') is not null)
    and not exists(select 1 from public.game_images where game_id=p_game_id and is_primary)
    and not exists(select 1 from public.game_images where game_id=p_game_id and source_type='club' and usage_status='approved') then
   select id into v_primary from public.game_images
   where game_id=p_game_id and source_type='opdb' and usage_status='approved'
   order by case lower(trim(image_type)) when 'closeup' then 0 when 'playfield' then 1 when 'backglass' then 2 else 3 end,
     case when metadata->'opdbPrimary'='true'::jsonb then 0 else 1 end, source_key,id limit 1;
   if v_primary is not null then update public.game_images set is_primary=true where id=v_primary; end if;
 end if;
 if v_count>0 then
   perform private.snh_audit_game('import','game_images_opdb',p_game_id::text,'{}'::jsonb,
     jsonb_build_object('opdbId',p_opdb_id,'imageCount',v_count,'primaryImageId',v_primary),
     jsonb_build_object('usageStatus','approved','autoApprovedVia','pinballmap_new_game'));
 end if;
 return v_count;
end; $$;
revoke all on function private.snh_pinballmap_new_game_images(uuid,text,jsonb) from public,anon,authenticated,service_role;

commit;
