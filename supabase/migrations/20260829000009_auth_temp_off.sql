-- Temporarily re-open anon access (auth disabled on request).
--
-- With the login gate off, the browser has no user JWT, so PostgREST runs as `anon`. Migration
-- 6 dropped the anon policies, so nothing would read. Add them back ALONGSIDE the authenticated
-- ones. Both roles now work: gate on -> authenticated; gate off -> anon.
--
-- SECURITY: while these anon policies exist, anyone with the project URL + anon key can read and
-- edit automations without logging in. To re-secure, set VITE_DISABLE_AUTH=false AND re-run
-- migration 6 (which drops these anon policies again). The token still never sits in a table.

-- full control of automations
drop policy if exists flow_anon_all on flow;
create policy flow_anon_all on flow for all to anon using (true) with check (true);

drop policy if exists media_anon_all on media_asset;
create policy media_anon_all on media_asset for all to anon using (true) with check (true);

drop policy if exists ig_account_anon_all on ig_account;
create policy ig_account_anon_all on ig_account for all to anon using (true) with check (true);

-- read-only on everything the engine writes
drop policy if exists contact_anon_read on contact;
create policy contact_anon_read on contact for select to anon using (true);

drop policy if exists message_anon_read on message;
create policy message_anon_read on message for select to anon using (true);

drop policy if exists flow_run_anon_read on flow_run;
create policy flow_run_anon_read on flow_run for select to anon using (true);

drop policy if exists send_queue_anon_read on send_queue;
create policy send_queue_anon_read on send_queue for select to anon using (true);

-- storage: outbound media upload/delete for anon again (public read already exists)
drop policy if exists media_anon_upload on storage.objects;
create policy media_anon_upload on storage.objects
  for insert to anon with check (bucket_id = 'media');

drop policy if exists media_anon_delete on storage.objects;
create policy media_anon_delete on storage.objects
  for delete to anon using (bucket_id = 'media');
