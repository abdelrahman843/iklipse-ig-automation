-- Row level security.
--
-- WARNING: this MVP has no authentication by design (plan section 8). These policies grant the
-- anon key full control of flows and read access to conversations. Anyone who has the project
-- URL and the anon key can read and edit your automations. Keep the panel off the public
-- internet, or replace `to anon` with `to authenticated` once you add auth.
--
-- The Instagram access token is NOT in any of these tables. It lives in Edge Function secrets.
-- webhook_event and send_queue writes stay server-side only (service role bypasses RLS).

alter table ig_account    enable row level security;
alter table contact       enable row level security;
alter table flow          enable row level security;
alter table flow_run      enable row level security;
alter table message       enable row level security;
alter table webhook_event enable row level security;
alter table send_queue    enable row level security;
alter table media_asset   enable row level security;

-- control panel: full control of automations
drop policy if exists flow_anon_all on flow;
create policy flow_anon_all on flow for all to anon using (true) with check (true);

drop policy if exists media_anon_all on media_asset;
create policy media_anon_all on media_asset for all to anon using (true) with check (true);

drop policy if exists ig_account_anon_all on ig_account;
create policy ig_account_anon_all on ig_account for all to anon using (true) with check (true);

-- control panel: read-only on everything the engine writes
drop policy if exists contact_anon_read on contact;
create policy contact_anon_read on contact for select to anon using (true);

drop policy if exists message_anon_read on message;
create policy message_anon_read on message for select to anon using (true);

drop policy if exists flow_run_anon_read on flow_run;
create policy flow_run_anon_read on flow_run for select to anon using (true);

drop policy if exists send_queue_anon_read on send_queue;
create policy send_queue_anon_read on send_queue for select to anon using (true);

-- webhook_event: no anon policy at all. Raw payloads stay server-side.
