-- Ice Breakers + Persistent Menu (Triggers 8 & 9). Config surfaces written to the Messenger
-- Profile API. We keep a copy here so the panel can show the current config without calling
-- Meta on every render. Single row (dev = one account); a workspace key arrives with Task 5.

create table if not exists messenger_profile (
  id              int primary key default 1,
  ice_breakers    jsonb not null default '[]'::jsonb,   -- [{question,payload}]
  persistent_menu jsonb not null default '[]'::jsonb,   -- [{title, type, payload|url}]
  updated_at      timestamptz not null default now(),
  constraint messenger_profile_singleton check (id = 1)
);

insert into messenger_profile (id) values (1) on conflict (id) do nothing;

alter table messenger_profile enable row level security;

drop policy if exists messenger_profile_anon_all on messenger_profile;
create policy messenger_profile_anon_all on messenger_profile for all to anon using (true) with check (true);

drop policy if exists messenger_profile_auth_all on messenger_profile;
create policy messenger_profile_auth_all on messenger_profile for all to authenticated using (true) with check (true);
