-- Keep the legacy column as a compatibility mirror for existing clients/importers.
alter table public.events add column if not exists external_links jsonb not null default '[]'::jsonb;

create or replace function public.event_links_valid(links jsonb)
returns boolean language plpgsql immutable set search_path = '' as $$
declare item jsonb;
begin
  if links is null or jsonb_typeof(links) <> 'array' then return false; end if;
  for item in select value from jsonb_array_elements(links) loop
    if jsonb_typeof(item) <> 'object'
       or jsonb_typeof(item->'url') is distinct from 'string'
       or btrim(item->>'url') = ''
       or (item ? 'label' and jsonb_typeof(item->'label') is distinct from 'string') then
      return false;
    end if;
  end loop;
  return true;
end;
$$;

-- Preserve existing URLs exactly; the presentation layer validates HTTP(S).
update public.events set external_links = jsonb_build_array(jsonb_build_object('url', external_url))
where external_links = '[]'::jsonb and nullif(btrim(external_url), '') is not null;

alter table public.events drop constraint if exists events_external_links_valid;
alter table public.events add constraint events_external_links_valid check (public.event_links_valid(external_links));

create or replace function public.sync_event_external_links()
returns trigger language plpgsql set search_path = '' as $$
begin
  if TG_OP = 'INSERT' then
    if new.external_links = '[]'::jsonb and nullif(btrim(new.external_url), '') is not null then
      new.external_links := jsonb_build_array(jsonb_build_object('url', new.external_url));
    end if;
  elsif new.external_links is not distinct from old.external_links
        and new.external_url is distinct from old.external_url then
    -- An older writer changed only its one link. Preserve every additional link.
    if old.external_links->0->>'url' = old.external_url then
      new.external_links := old.external_links - 0;
    end if;
    if nullif(btrim(new.external_url), '') is not null then
      new.external_links := jsonb_build_array(jsonb_build_object('url', new.external_url)) || new.external_links;
    end if;
  end if;
  new.external_url := new.external_links->0->>'url';
  return new;
end;
$$;
drop trigger if exists events_sync_external_links on public.events;
create trigger events_sync_external_links before insert or update on public.events
for each row execute function public.sync_event_external_links();
comment on column public.events.external_links is 'Canonical ordered event links: [{"url":"https://…","label":"Optional label"}]. Empty array means no links.';
notify pgrst, 'reload schema';
