-- Broadcasts, Sequences and Instagram settings, brought in line with how ManyChat works.
--
-- Broadcasts: a draft holds either its own message blocks (content.blocks) or an existing
-- automation to run (flow_id); the audience is a list of conditions ANDed together.
-- Sequences: every message can be switched off on its own, can be an automation, and can be held
-- to a time window ("send between 08:00 and 22:00, Monday to Friday").
-- Stats: send_queue rows remember which broadcast / sequence message produced them, so the panel
-- can show Sent / Delivered / Failed per broadcast and per message.
-- Instagram settings: on/off switches for conversation starters and the menu, and the Opt-in /
-- Opt-out system keywords (an opted-out contact gets no broadcasts and no sequence messages).

-- ---- broadcasts ------------------------------------------------------------------------------
alter table broadcast
  add column if not exists flow_id    uuid references flow(id) on delete set null,
  add column if not exists audience   jsonb not null default '[]'::jsonb,  -- [{field:'tag', op:'is'|'is_not', value}]
  add column if not exists updated_at timestamptz not null default now();

-- The single segment tag becomes the first audience condition.
update broadcast
   set audience = jsonb_build_array(jsonb_build_object('field', 'tag', 'op', 'is', 'value', segment_tag))
 where segment_tag is not null and audience = '[]'::jsonb;

drop trigger if exists broadcast_updated_at on broadcast;
create trigger broadcast_updated_at before update on broadcast
  for each row execute function set_updated_at();

-- ---- sequences -------------------------------------------------------------------------------
alter table sequence_step
  add column if not exists flow_id     uuid references flow(id) on delete set null,
  add column if not exists active      boolean not null default true,
  add column if not exists send_window jsonb;  -- null = any time; else {from:'08:00', to:'22:00', days:[1..7], tz}

-- A sequence is now "on" while any of its messages is on (ManyChat's rule). A paused sequence
-- keeps that meaning by switching its messages off, then the sequence itself stays active.
update sequence_step set active = false
 where sequence_id in (select id from sequence where status = 'paused');
update sequence set status = 'active' where status = 'paused';

-- ---- delivery stats --------------------------------------------------------------------------
alter table send_queue
  add column if not exists broadcast_id     uuid references broadcast(id) on delete set null,
  add column if not exists sequence_step_id uuid references sequence_step(id) on delete set null;
create index if not exists send_queue_broadcast_idx on send_queue (broadcast_id) where broadcast_id is not null;
create index if not exists send_queue_step_idx on send_queue (sequence_step_id) where sequence_step_id is not null;

-- One row per broadcast / message: how many sends were queued, delivered, and failed. Runs as the
-- caller, so it only sees what RLS lets the panel read anyway.
create or replace function public.broadcast_stats()
returns table (broadcast_id uuid, queued bigint, delivered bigint, failed bigint)
language sql stable security invoker set search_path = public as $$
  select q.broadcast_id,
         count(*),
         count(*) filter (where q.status = 'sent'),
         count(*) filter (where q.status in ('failed', 'expired'))
    from send_queue q
   where q.broadcast_id is not null
   group by q.broadcast_id
$$;

create or replace function public.sequence_step_stats()
returns table (sequence_step_id uuid, queued bigint, delivered bigint, failed bigint)
language sql stable security invoker set search_path = public as $$
  select q.sequence_step_id,
         count(*),
         count(*) filter (where q.status = 'sent'),
         count(*) filter (where q.status in ('failed', 'expired'))
    from send_queue q
   where q.sequence_step_id is not null
   group by q.sequence_step_id
$$;

-- ---- opt-in / opt-out ------------------------------------------------------------------------
alter table contact add column if not exists opted_out_at timestamptz;

alter table messenger_profile
  add column if not exists ice_enabled  boolean not null default true,
  add column if not exists menu_enabled boolean not null default true,
  add column if not exists opt_out jsonb not null default
    '{"enabled": true, "keywords": ["stop", "unsubscribe"], "reply": "You''re unsubscribed. You won''t get any more updates from us. Send START anytime to subscribe again."}'::jsonb,
  add column if not exists opt_in jsonb not null default
    '{"enabled": true, "keywords": ["start", "subscribe"], "reply": "You''re subscribed again. Thanks for coming back!"}'::jsonb;
