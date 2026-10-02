-- Authentication gate (Task 4, step 1: login).
--
-- The MVP granted the `anon` role full control so a browser with the anon key could run the
-- panel with no login. Now that Supabase Auth guards the app, a signed-in browser sends the
-- user's JWT, so PostgREST runs its queries as `authenticated`, not `anon`. Move every policy
-- to `authenticated` and drop the `anon` grants, so reaching the data now requires a login.
--
-- This step does NOT yet scope rows to their owner (that is the per-user ownership work later
-- in Task 4). Any signed-in user still sees every row. The gain here is: no login, no access.
--
-- Edge Functions are unaffected: they use the service role, which bypasses RLS entirely.

-- ---- tables: full control of automations -------------------------------------------------
drop policy if exists flow_anon_all on flow;
drop policy if exists flow_auth_all on flow;
create policy flow_auth_all on flow for all to authenticated using (true) with check (true);

drop policy if exists media_anon_all on media_asset;
drop policy if exists media_auth_all on media_asset;
create policy media_auth_all on media_asset for all to authenticated using (true) with check (true);

drop policy if exists ig_account_anon_all on ig_account;
drop policy if exists ig_account_auth_all on ig_account;
create policy ig_account_auth_all on ig_account for all to authenticated using (true) with check (true);

-- ---- tables: read-only on everything the engine writes -----------------------------------
drop policy if exists contact_anon_read on contact;
drop policy if exists contact_auth_read on contact;
create policy contact_auth_read on contact for select to authenticated using (true);

drop policy if exists message_anon_read on message;
drop policy if exists message_auth_read on message;
create policy message_auth_read on message for select to authenticated using (true);

drop policy if exists flow_run_anon_read on flow_run;
drop policy if exists flow_run_auth_read on flow_run;
create policy flow_run_auth_read on flow_run for select to authenticated using (true);

drop policy if exists send_queue_anon_read on send_queue;
drop policy if exists send_queue_auth_read on send_queue;
create policy send_queue_auth_read on send_queue for select to authenticated using (true);

-- webhook_event: still no client policy at all. Raw payloads stay server-side.

-- ---- storage: outbound media -------------------------------------------------------------
-- Public read stays (Meta fetches by URL). Upload/delete move to authenticated.
drop policy if exists media_anon_upload on storage.objects;
drop policy if exists media_auth_upload on storage.objects;
create policy media_auth_upload on storage.objects
  for insert to authenticated with check (bucket_id = 'media');

drop policy if exists media_anon_delete on storage.objects;
drop policy if exists media_auth_delete on storage.objects;
create policy media_auth_delete on storage.objects
  for delete to authenticated using (bucket_id = 'media');
