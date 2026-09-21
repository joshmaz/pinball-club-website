-- Keep audit history for 12 months. This job is owned by the migration role;
-- browser/API roles still have no direct delete access to public.audit_log.
-- A bounded daily batch avoids a large delete if old rows accumulate.

select cron.schedule(
  'snh-audit-retention-daily',
  '15 3 * * *',
  $$
    delete from public.audit_log
    where id in (
      select id
      from public.audit_log
      where created_at < now() - interval '12 months'
      order by created_at, id
      limit 5000
    );
  $$
);
