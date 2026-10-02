-- Login paused (temporary, on request).
--
-- With the login gate off (VITE_DISABLE_AUTH=true) the browser has no user session, so PostgREST
-- runs as `anon`, and migration 18 removed every anon policy. This mirrors each `authenticated`
-- policy as an `anon` one with the same command and conditions, so the panel works exactly as a
-- signed-in user would. Tables with no client policy (app_config, ig_token, webhook_event,
-- oauth_state) stay closed.
--
-- SECURITY: while these exist, anyone with the site URL (the anon key ships in the bundle) can
-- read and edit contacts, messages, automations and broadcasts.
--
-- To turn login back on: run supabase/relock-login.sql as a new migration (it drops every
-- policy named paused_*), set VITE_DISABLE_AUTH=false, and unset the ALLOW_ANON function secret.

do $$
declare
  p record;
  stmt text;
begin
  for p in
    select tablename, policyname, cmd, qual, with_check
    from pg_policies
    where schemaname = 'public' and 'authenticated' = any(roles)
  loop
    stmt := format('create policy %I on public.%I for %s to anon',
                   left('paused_' || p.policyname, 63), p.tablename, p.cmd);
    if p.qual is not null then stmt := stmt || format(' using (%s)', p.qual); end if;
    if p.with_check is not null then stmt := stmt || format(' with check (%s)', p.with_check); end if;
    execute format('drop policy if exists %I on public.%I', left('paused_' || p.policyname, 63), p.tablename);
    execute stmt;
  end loop;
end $$;

-- Outbound media upload/delete (public read already exists).
drop policy if exists paused_media_upload on storage.objects;
create policy paused_media_upload on storage.objects
  for insert to anon with check (bucket_id = 'media');

drop policy if exists paused_media_delete on storage.objects;
create policy paused_media_delete on storage.objects
  for delete to anon using (bucket_id = 'media');
