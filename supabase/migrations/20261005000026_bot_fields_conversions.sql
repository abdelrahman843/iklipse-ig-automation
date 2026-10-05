-- The two Manychat actions that need storage of their own.
--
-- Bot fields: values shared by every contact (a promo code, today's offer, a counter), set by the
-- "Set bot field" action or in Settings › Fields, read in messages as {{bot.key}} and in
-- conditions as bot.key.
-- Conversions: "Log conversion event" records that a contact reached a goal (bought, booked),
-- with an optional value. The Automations list counts them per automation.

create table if not exists bot_field (
  key        text primary key,
  value      text not null default '',
  updated_at timestamptz not null default now()
);

create table if not exists conversion_event (
  id         uuid primary key default gen_random_uuid(),
  contact_id uuid references contact(id) on delete set null,
  flow_id    uuid references flow(id) on delete set null,
  name       text not null,
  value      numeric,
  created_at timestamptz not null default now()
);
create index if not exists conversion_event_flow_idx on conversion_event (flow_id);

alter table bot_field enable row level security;
alter table conversion_event enable row level security;

drop policy if exists bot_field_auth_all on bot_field;
create policy bot_field_auth_all on bot_field for all to authenticated using (true) with check (true);
drop policy if exists conversion_event_auth_read on conversion_event;
create policy conversion_event_auth_read on conversion_event for select to authenticated using (true);

-- Login is paused (migration 19): mirror for anon. relock-login.sql drops every paused_* policy.
drop policy if exists paused_bot_field_auth_all on bot_field;
create policy paused_bot_field_auth_all on bot_field for all to anon using (true) with check (true);
drop policy if exists paused_conversion_event_auth_read on conversion_event;
create policy paused_conversion_event_auth_read on conversion_event for select to anon using (true);

-- Conversions per automation, for the Automations list. Runs as the caller.
create or replace function public.flow_conversion_counts()
returns table (flow_id uuid, conversions bigint, total numeric)
language sql stable security invoker set search_path = public as $$
  select e.flow_id, count(*), coalesce(sum(e.value), 0)
    from conversion_event e
   where e.flow_id is not null
   group by e.flow_id
$$;
