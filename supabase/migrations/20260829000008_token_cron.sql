-- Daily token refresh (Task 4). Reuses invoke_edge from the scheduler migration.
do $$ begin
  perform cron.unschedule('ig-token-refresh-daily');
exception when others then null; end $$;

select cron.schedule(
  'ig-token-refresh-daily', '0 3 * * *',
  $cron$ select public.invoke_edge('ig-token-refresh') $cron$
);
