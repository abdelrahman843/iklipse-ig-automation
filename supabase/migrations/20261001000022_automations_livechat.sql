-- Automations and Live Chat, brought in line with how ManyChat works.
--
-- Automations: folders (they nest), a Trash that deleted automations go to and can come back
-- from, and unpublished changes: editing a Live automation saves into `draft` until Publish, so
-- contacts never run a half-built flow. Run counts per automation for the list.
-- Live Chat: the contact's Instagram name and picture, and Open / Closed only (snooze is gone).

-- ---- folders -----------------------------------------------------------------------------------
create table if not exists flow_folder (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  parent_id  uuid references flow_folder(id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table flow_folder enable row level security;
drop policy if exists flow_folder_auth_all on flow_folder;
create policy flow_folder_auth_all on flow_folder for all to authenticated using (true) with check (true);
-- Login is paused (migration 19): mirror it for anon. relock-login.sql drops every paused_* policy.
drop policy if exists paused_flow_folder_auth_all on flow_folder;
create policy paused_flow_folder_auth_all on flow_folder for all to anon using (true) with check (true);

-- ---- automations -------------------------------------------------------------------------------
alter table flow
  add column if not exists folder_id  uuid references flow_folder(id) on delete set null,
  add column if not exists deleted_at timestamptz,  -- in Trash since
  add column if not exists draft      jsonb;        -- {trigger_type, trigger_config, graph} not yet published

create index if not exists flow_folder_id_idx on flow (folder_id);

-- Moving an automation to Trash stops it: back to draft, and contacts waiting inside it are let go.
-- Security definer because the panel can read flow_run but not write it.
create or replace function public.flow_trashed() returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.deleted_at is not null and old.deleted_at is null then
    new.status := 'draft';
    update flow_run
       set status = 'cancelled', resume_at = null
     where flow_id = new.id
       and status in ('waiting_input', 'waiting_delay');
  end if;
  return new;
end $$;

drop trigger if exists flow_trashed on flow;
create trigger flow_trashed before update of deleted_at on flow
  for each row execute function public.flow_trashed();

-- Total runs per automation (the list's Runs column).
create or replace function public.flow_run_counts()
returns table (flow_id uuid, runs bigint)
language sql
stable
security invoker
as $$
  select r.flow_id, count(*) from flow_run r group by r.flow_id;
$$;

-- ---- live chat ---------------------------------------------------------------------------------
alter table contact
  add column if not exists name               text,
  add column if not exists profile_pic        text,
  add column if not exists profile_checked_at timestamptz;

-- Status is now open | done (shown as Open / Closed). Snoozed conversations reopen.
update contact set status = 'open', snooze_until = null where status = 'snoozed';
