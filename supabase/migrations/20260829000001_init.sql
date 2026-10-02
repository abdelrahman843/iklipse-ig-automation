-- Instagram Automation MVP — core schema
-- Eight tables. The flow graph is a JSONB document on purpose (node types will keep moving).

create extension if not exists pgcrypto;

-- the connected Instagram account (one row for the MVP; the token lives in Edge Function
-- secrets, never here)
create table if not exists ig_account (
  id           uuid primary key default gen_random_uuid(),
  ig_user_id   text not null unique,
  username     text,
  connected_at timestamptz not null default now()
);

-- one row per Instagram user who has interacted with us
create table if not exists contact (
  id                  uuid primary key default gen_random_uuid(),
  igsid               text not null unique,          -- Instagram-scoped user id
  username            text,                          -- Instagram gives no first/last name
  follows_account     boolean,
  follows_checked_at  timestamptz,
  last_interaction_at timestamptz,                   -- drives the 24-hour window
  custom_fields       jsonb not null default '{}'::jsonb,
  created_at          timestamptz not null default now()
);
create index if not exists contact_last_interaction_idx on contact (last_interaction_at);

-- an automation definition; the whole node graph is one JSONB document
create table if not exists flow (
  id             uuid primary key default gen_random_uuid(),
  name           text not null,
  status         text not null default 'draft',      -- draft | live
  trigger_type   text not null,                      -- comment | keyword
  trigger_config jsonb not null default '{}'::jsonb, -- media_id, keywords, match rule
  graph          jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists flow_status_trigger_idx on flow (status, trigger_type);

-- one execution session of one flow for one contact
create table if not exists flow_run (
  id              uuid primary key default gen_random_uuid(),
  flow_id         uuid not null references flow(id) on delete cascade,
  contact_id      uuid not null references contact(id) on delete cascade,
  current_node_id text,
  state           jsonb not null default '{}'::jsonb, -- variables collected during the run
  status          text not null default 'running',
  -- running | waiting_input | waiting_delay | done | failed | blocked_window
  resume_at       timestamptz,                        -- delay nodes and reply timeouts
  error           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists flow_run_status_resume_idx on flow_run (status, resume_at);
create index if not exists flow_run_contact_status_idx on flow_run (contact_id, status);

-- our own message archive; Meta will not give this history back
create table if not exists message (
  id              uuid primary key default gen_random_uuid(),
  contact_id      uuid not null references contact(id) on delete cascade,
  direction       text not null,                      -- in | out
  payload         jsonb not null,
  meta_message_id text,
  flow_run_id     uuid references flow_run(id) on delete set null,
  created_at      timestamptz not null default now()
);
create index if not exists message_contact_created_idx on message (contact_id, created_at desc);

-- raw inbound webhooks, logged before any processing
create table if not exists webhook_event (
  id           uuid primary key default gen_random_uuid(),
  raw          jsonb not null,
  event_type   text,
  processed_at timestamptz,
  error        text,
  received_at  timestamptz not null default now()
);
create index if not exists webhook_event_unprocessed_idx
  on webhook_event (received_at) where processed_at is null;

-- every outbound message, so rate limits are enforced in one place
create table if not exists send_queue (
  id              uuid primary key default gen_random_uuid(),
  contact_id      uuid not null references contact(id) on delete cascade,
  flow_run_id     uuid references flow_run(id) on delete set null,
  send_type       text not null,                      -- private_reply | dm
  comment_id      text,                               -- required for private_reply
  payload         jsonb not null,
  status          text not null default 'pending',    -- pending | sent | failed | expired
  attempts        int  not null default 0,
  next_attempt_at timestamptz not null default now(),
  expires_at      timestamptz,                        -- private replies: comment time + 7 days
  sent_at         timestamptz,                        -- feeds the hourly private-reply counter
  meta_message_id text,
  error           text,
  created_at      timestamptz not null default now()
);
create index if not exists send_queue_drain_idx on send_queue (status, next_attempt_at);
create index if not exists send_queue_rate_idx on send_queue (send_type, status, sent_at);

-- images a flow sends; Meta fetches these from a public URL
create table if not exists media_asset (
  id           uuid primary key default gen_random_uuid(),
  storage_path text not null,
  public_url   text not null,
  created_at   timestamptz not null default now()
);

-- keep flow.updated_at honest
create or replace function set_updated_at() returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists flow_updated_at on flow;
create trigger flow_updated_at before update on flow
  for each row execute function set_updated_at();

drop trigger if exists flow_run_updated_at on flow_run;
create trigger flow_run_updated_at before update on flow_run
  for each row execute function set_updated_at();
