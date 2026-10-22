-- Stale editor snapshots require a reload, not a database transaction retry.
-- Return HTTP 409 through PostgREST without its SQLSTATE 40001 retry loop.
begin;
do $$
declare signature text; definition text;
begin
 foreach signature in array array[
  'public.snh_photo_album_order_save(text,uuid[],bigint)',
  'public.snh_photo_asset_order_save(uuid,uuid[],jsonb)'
 ] loop
  definition:=pg_get_functiondef(signature::regprocedure);
  if position('''40001''' in definition)>0 then
   execute replace(definition,'''40001''','''PT409''');
  end if;
 end loop;
end $$;
commit;
