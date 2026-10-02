-- Minute scheduler for the two workers.
--
-- The URL and service role key are not in this file. Insert them once after deploying:
--
--   insert into app_config (key, value) values
--     ('functions_base_url', 'https://<project-ref>.supabase.co/functions/v1'),
--     ('service_role_key',   '<service-role-key>')
--   on conflict (key) do update set value = excluded.value;

create extension if not exists pg_cron;
create extension if not exists pg_net;

create table if not exists app_config (
  key   text primary key,
  value text not null
);
alter table app_config enable row level security;  -- no policies: service role only

create or replace function public.invoke_edge(fn text)
returns void
language plpgsql
security definer
set search_path = public, net
as $$
declare
  v_base text;
  v_key  text;
begin
  select value into v_base from app_config where key = 'functions_base_url';
  select value into v_key  from app_config where key = 'service_role_key';
  if v_base is null or v_key is null then
    return;  -- not configured yet; stay quiet rather than filling the cron log
  end if;

  perform net.http_post(
    url     := v_base || '/' || fn,
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'Authorization', 'Bearer ' || v_key
               ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 55000
  );
end $$;

revoke all on function public.invoke_edge(text) from anon, authenticated;

do $$ begin
  perform cron.unschedule('process-events-every-minute');
exception when others then null; end $$;

do $$ begin
  perform cron.unschedule('send-worker-every-minute');
exception when others then null; end $$;

select cron.schedule(
  'process-events-every-minute', '* * * * *',
  $cron$ select public.invoke_edge('process-events') $cron$
);

select cron.schedule(
  'send-worker-every-minute', '* * * * *',
  $cron$ select public.invoke_edge('send-worker') $cron$
);
