-- Repair malformed event URLs that are exactly the same absolute URL concatenated twice.
-- This is intentionally narrow: only an exact repeated http(s) string is changed.
with repaired as (
  select
    e.id,
    jsonb_agg(
      case
        when length(item->>'url') % 2 = 0
         and left(item->>'url', length(item->>'url') / 2) = right(item->>'url', length(item->>'url') / 2)
         and left(item->>'url', length(item->>'url') / 2) ~* '^https?://'
        then jsonb_set(item, '{url}', to_jsonb(left(item->>'url', length(item->>'url') / 2)), false)
        else item
      end
      order by ord
    ) as external_links
  from public.events e
  cross join lateral jsonb_array_elements(e.external_links) with ordinality as links(item, ord)
  group by e.id
)
update public.events e
set external_links = repaired.external_links
from repaired
where e.id = repaired.id
  and e.external_links is distinct from repaired.external_links;
