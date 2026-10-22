-- Application version conflicts are permanent until the editor reloads.
-- PostgREST 14 retries 40001 indefinitely; PT409 returns one HTTP conflict.
begin;
do $$
declare f record; definition text;
begin
 for f in select p.oid from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname in ('snh_publishing_write_core','snh_publishing_activity_write')
 loop
  definition:=pg_get_functiondef(f.oid);
  if position('''40001''' in definition)>0 then
   execute replace(definition,'''40001''','''PT409''');
  end if;
 end loop;
end $$;
commit;
