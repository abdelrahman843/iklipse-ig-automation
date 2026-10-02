-- Security + reliability pass.
--
-- 1. Lock the data behind login again. Migration 9 re-opened every table to `anon` while the
--    login gate was off; the anon key ships inside the browser bundle, so that meant anyone on
--    the internet could read contacts and messages, publish a flow, or queue a broadcast.
--    After this migration the panel needs a signed-in user (VITE_DISABLE_AUTH=false).
-- 2. send_queue rows are claimed atomically, so overlapping send-worker runs (cron + kick) can
--    never deliver the same DM twice.
-- 3. At most one active run per contact, enforced by the database instead of a racy read.
-- 4. oauth_state: one-time values that prove an Instagram connect was started from the panel.

-- ---- 1. drop every anon policy -----------------------------------------------------------
do $$
declare p record;
begin
  for p in
    select schemaname, tablename, policyname
    from pg_policies
    where schemaname = 'public' and 'anon' = any(roles)
  loop
    execute format('drop policy if exists %I on %I.%I', p.policyname, p.schemaname, p.tablename);
  end loop;
end $$;

drop policy if exists media_anon_upload on storage.objects;
drop policy if exists media_anon_delete on storage.objects;

-- ---- 2. atomic send claim ----------------------------------------------------------------
alter table send_queue add column if not exists claimed_at timestamptz;

-- Claims due rows by flipping them to 'sending'. A row stuck in 'sending' for 5 minutes (a
-- worker that died mid-batch) becomes claimable again. SKIP LOCKED lets two workers split a
-- batch instead of both taking it.
create or replace function public.claim_send_queue(batch_size int default 40)
returns setof send_queue
language sql
security definer
set search_path = public
as $$
  update send_queue q
     set status = 'sending', claimed_at = now()
   where q.id in (
     select id from send_queue
      where (status = 'pending' and next_attempt_at <= now())
         or (status = 'sending' and claimed_at < now() - interval '5 minutes')
      order by created_at
      limit batch_size
      for update skip locked
   )
  returning q.*;
$$;

revoke all on function public.claim_send_queue(int) from public, anon, authenticated;

-- ---- 3. one active run per contact -------------------------------------------------------
-- Retire older duplicates first so the index can be built on existing data.
update flow_run r
   set status = 'failed', error = 'Superseded: another run was active for this contact'
 where r.status in ('running', 'waiting_input', 'waiting_delay')
   and exists (
     select 1 from flow_run n
      where n.contact_id = r.contact_id
        and n.status in ('running', 'waiting_input', 'waiting_delay')
        and (n.created_at, n.id) > (r.created_at, r.id)
   );

create unique index if not exists flow_run_one_active_per_contact
  on flow_run (contact_id)
  where status in ('running', 'waiting_input', 'waiting_delay');

-- ---- 4. OAuth state ----------------------------------------------------------------------
create table if not exists oauth_state (
  state      text primary key,
  created_at timestamptz not null default now()
);
alter table oauth_state enable row level security;  -- no policy: Edge Functions only
