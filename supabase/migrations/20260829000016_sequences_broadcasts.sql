-- Sequences (drip campaigns) and Broadcasts (one-off sends to a segment).
--
-- Sequence: an ordered list of steps, each a message sent after a delay. A contact is subscribed
-- (by an Action node or the inbox) and a per-minute worker walks each subscription through the
-- steps, enqueuing a send when a step comes due. Broadcast: compose once, pick a segment (all or
-- a tag), send now or at a scheduled time; a worker fans it out to matching contacts.

-- ---- sequences --------------------------------------------------------------
create table if not exists sequence (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  status     text not null default 'active',   -- active | paused
  created_at timestamptz not null default now()
);

create table if not exists sequence_step (
  id            uuid primary key default gen_random_uuid(),
  sequence_id   uuid not null references sequence(id) on delete cascade,
  sort          int  not null default 0,
  delay_seconds int  not null default 86400,   -- wait before THIS step (from the previous one)
  content       jsonb not null default '{}'::jsonb,  -- MessageContent
  created_at    timestamptz not null default now()
);
create index if not exists sequence_step_seq_idx on sequence_step (sequence_id, sort);

create table if not exists sequence_subscription (
  id           uuid primary key default gen_random_uuid(),
  sequence_id  uuid not null references sequence(id) on delete cascade,
  contact_id   uuid not null references contact(id) on delete cascade,
  step         int  not null default 0,          -- next step index to send
  next_send_at timestamptz not null default now(),
  status       text not null default 'active',    -- active | done | cancelled
  created_at   timestamptz not null default now(),
  unique (sequence_id, contact_id)
);
create index if not exists sequence_sub_due_idx on sequence_subscription (status, next_send_at);

-- ---- broadcasts -------------------------------------------------------------
create table if not exists broadcast (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  segment_tag  text,                              -- null = everyone; else contacts with this tag
  content      jsonb not null default '{}'::jsonb, -- MessageContent
  status       text not null default 'draft',     -- draft | scheduled | sending | sent
  scheduled_at timestamptz,                        -- null = send as soon as it leaves draft
  sent_count   int not null default 0,
  created_at   timestamptz not null default now(),
  sent_at      timestamptz
);
create index if not exists broadcast_due_idx on broadcast (status, scheduled_at);

-- ---- RLS (same shape as flow: the panel manages these directly) -------------
do $$
declare t text;
begin
  foreach t in array array['sequence','sequence_step','sequence_subscription','broadcast'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists %I_anon_all on %I', t, t);
    execute format('create policy %I_anon_all on %I for all to anon using (true) with check (true)', t, t);
    execute format('drop policy if exists %I_auth_all on %I', t, t);
    execute format('create policy %I_auth_all on %I for all to authenticated using (true) with check (true)', t, t);
  end loop;
end $$;

-- ---- cron: one minute tick for each worker ----------------------------------
do $$ begin perform cron.unschedule('sequence-worker-every-minute'); exception when others then null; end $$;
do $$ begin perform cron.unschedule('broadcast-worker-every-minute'); exception when others then null; end $$;

select cron.schedule(
  'sequence-worker-every-minute', '* * * * *',
  $cron$ select public.invoke_edge('sequence-worker') $cron$
);
select cron.schedule(
  'broadcast-worker-every-minute', '* * * * *',
  $cron$ select public.invoke_edge('broadcast-worker') $cron$
);
