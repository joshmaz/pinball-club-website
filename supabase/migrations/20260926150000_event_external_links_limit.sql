-- Separate from the already-applied links migration. NOT VALID preserves any
-- existing oversized arrays verbatim while enforcing the cap on every new write.
-- Keep shape validation in events_external_links_valid; CASE safely handles
-- malformed non-array JSON regardless of constraint evaluation order.
alter table public.events drop constraint if exists events_external_links_limit;
alter table public.events add constraint events_external_links_limit check (
  case when jsonb_typeof(external_links) = 'array'
    then jsonb_array_length(external_links) <= 5
    else false
  end
) not valid;

-- Mark validated when existing data allows it; never truncate or delete links.
do $$
begin
  if not exists (
    select 1 from public.events where
      case when jsonb_typeof(external_links) = 'array'
        then jsonb_array_length(external_links) > 5
        else true
      end
  ) then
    alter table public.events validate constraint events_external_links_limit;
  end if;
end;
$$;
notify pgrst, 'reload schema';
