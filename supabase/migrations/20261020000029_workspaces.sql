-- Workspaces: every account gets its own isolated workspace, like ManyChat.
--
-- Before: one shared set of tables. Anyone signed in (or anon, while login was paused) saw and
-- changed everything, and every send went out as the one connected Instagram account.
-- Now:
--   workspace          one per account; owns everything below
--   workspace_member   which login belongs to which workspace (one workspace per login)
--   workspace_id       on every tenant table, NOT NULL, filled from the signed-in user's
--                      workspace by default (current_workspace_id()), or from the parent row by
--                      a trigger on child tables, so a row can never point into another workspace
--   composite FKs      (workspace_id, x_id) -> parent (workspace_id, id): a flow, contact,
--                      sequence or broadcast from another workspace can't be referenced at all
--   RLS                workspace_id = current_workspace_id() on every tenant table; the anon
--                      ("login paused") policies are gone
--   singletons         app_settings, messenger_profile and send_guard become one row per
--                      workspace; Meta's send limits are per Instagram account, so each
--                      workspace has its own budget, breaker and viral switch
-- Accounts are created only by the admin-accounts function (sign-up is off).
-- Everything that existed before moves into the first workspace, "Iklipse".

-- ---- 1. workspaces --------------------------------------------------------------------------------
create table if not exists workspace (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (length(trim(name)) between 1 and 80),
  created_at timestamptz not null default now()
);

create table if not exists workspace_member (
  workspace_id uuid not null references workspace(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  username     text not null check (username ~ '^[a-z0-9][a-z0-9._]{2,29}$'),
  role         text not null default 'owner' check (role in ('owner', 'admin', 'member')),
  created_at   timestamptz not null default now(),
  primary key (workspace_id, user_id)
);
create unique index if not exists workspace_member_one_per_user on workspace_member (user_id);
create unique index if not exists workspace_member_username on workspace_member (username);

alter table workspace enable row level security;
alter table workspace_member enable row level security;

-- The signed-in user's workspace. NULL for the service role and for anyone without one.
create or replace function public.current_workspace_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select workspace_id from workspace_member where user_id = auth.uid()
$$;
revoke all on function public.current_workspace_id() from public, anon;
grant execute on function public.current_workspace_id() to authenticated, service_role;

insert into workspace (id, name) values ('a1c0f3e2-5b7d-4c19-8e2a-6f4d9b0c7e11', 'Iklipse')
on conflict (id) do nothing;

-- ---- 2. workspace_id on every tenant table ---------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array[
    'agent', 'app_settings', 'bot_field', 'broadcast', 'contact', 'contact_note', 'contact_segment',
    'conversion_event', 'custom_field', 'flow', 'flow_folder', 'flow_run', 'ig_account', 'media_asset',
    'message', 'messenger_profile', 'node_stat', 'saved_reply', 'send_guard', 'send_queue', 'sequence',
    'sequence_step', 'sequence_subscription', 'tag'
  ] loop
    execute format('alter table %I add column if not exists workspace_id uuid references workspace(id) on delete cascade', t);
    execute format('update %I set workspace_id = %L where workspace_id is null', t, 'a1c0f3e2-5b7d-4c19-8e2a-6f4d9b0c7e11');
    execute format('alter table %I alter column workspace_id set default public.current_workspace_id()', t);
    execute format('alter table %I alter column workspace_id set not null', t);
    execute format('create index if not exists %I on %I (workspace_id)', t || '_workspace_idx', t);
  end loop;
end $$;

-- Webhook events are matched to a workspace while they are processed (by the account they are for).
alter table webhook_event add column if not exists workspace_id uuid references workspace(id) on delete set null;
create index if not exists webhook_event_workspace_idx on webhook_event (workspace_id, received_at desc);

-- A connect flow remembers which workspace started it.
delete from oauth_state;
alter table oauth_state add column if not exists workspace_id uuid not null references workspace(id) on delete cascade;
alter table oauth_state add column if not exists user_id uuid;

-- ---- 3. singletons become one row per workspace -----------------------------------------------------
alter table app_settings drop constraint if exists app_settings_pkey;
alter table app_settings drop column if exists id;
alter table app_settings add primary key (workspace_id);

alter table messenger_profile drop constraint if exists messenger_profile_pkey;
alter table messenger_profile drop column if exists id;
alter table messenger_profile add primary key (workspace_id);

alter table send_guard drop constraint if exists send_guard_pkey;
alter table send_guard drop column if exists id cascade;
alter table send_guard drop column if exists waiting_until;
alter table send_guard add primary key (workspace_id);

-- The send-worker's "one waiting worker" lease is about the worker, not an account.
create table if not exists worker_lease (
  name  text primary key,
  until timestamptz
);
alter table worker_lease enable row level security;
insert into worker_lease (name) values ('send-worker') on conflict do nothing;

-- A new workspace starts with its settings rows.
create or replace function public.workspace_bootstrap()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into app_settings (workspace_id) values (new.id) on conflict do nothing;
  insert into messenger_profile (workspace_id) values (new.id) on conflict do nothing;
  insert into send_guard (workspace_id) values (new.id) on conflict do nothing;
  return new;
end $$;
revoke all on function public.workspace_bootstrap() from public, anon, authenticated;

drop trigger if exists workspace_bootstrap on workspace;
create trigger workspace_bootstrap after insert on workspace
  for each row execute function public.workspace_bootstrap();

-- ---- 4. names unique per workspace, not globally ------------------------------------------------------
alter table contact drop constraint if exists contact_igsid_key;
alter table contact add constraint contact_workspace_igsid_key unique (workspace_id, igsid);

alter table tag drop constraint if exists tag_pkey;
alter table tag add primary key (workspace_id, name);

alter table custom_field drop constraint if exists custom_field_pkey;
alter table custom_field add primary key (workspace_id, key);

alter table bot_field drop constraint if exists bot_field_pkey;
alter table bot_field add primary key (workspace_id, key);

alter table agent drop constraint if exists agent_name_key;
alter table agent add constraint agent_workspace_name_key unique (workspace_id, name);

-- An Instagram account belongs to one workspace (ig_user_id stays globally unique), and a
-- workspace has at most one account that is not disconnected.
create unique index if not exists ig_account_one_live_per_workspace
  on ig_account (workspace_id) where status <> 'disconnected';

-- ---- 5. references can't cross workspaces ------------------------------------------------------------
alter table contact       add constraint contact_ws_id_key       unique (workspace_id, id);
alter table flow          add constraint flow_ws_id_key          unique (workspace_id, id);
alter table flow_folder   add constraint flow_folder_ws_id_key   unique (workspace_id, id);
alter table flow_run      add constraint flow_run_ws_id_key      unique (workspace_id, id);
alter table sequence      add constraint sequence_ws_id_key      unique (workspace_id, id);
alter table sequence_step add constraint sequence_step_ws_id_key unique (workspace_id, id);
alter table broadcast     add constraint broadcast_ws_id_key     unique (workspace_id, id);

alter table broadcast drop constraint if exists broadcast_flow_id_fkey;
alter table broadcast add constraint broadcast_flow_fk
  foreign key (workspace_id, flow_id) references flow (workspace_id, id) on delete set null (flow_id);

alter table contact_note drop constraint if exists contact_note_contact_id_fkey;
alter table contact_note add constraint contact_note_contact_fk
  foreign key (workspace_id, contact_id) references contact (workspace_id, id) on delete cascade;

alter table conversion_event drop constraint if exists conversion_event_contact_id_fkey;
alter table conversion_event drop constraint if exists conversion_event_flow_id_fkey;
alter table conversion_event add constraint conversion_event_contact_fk
  foreign key (workspace_id, contact_id) references contact (workspace_id, id) on delete set null (contact_id);
alter table conversion_event add constraint conversion_event_flow_fk
  foreign key (workspace_id, flow_id) references flow (workspace_id, id) on delete set null (flow_id);

alter table flow drop constraint if exists flow_folder_id_fkey;
alter table flow add constraint flow_folder_fk
  foreign key (workspace_id, folder_id) references flow_folder (workspace_id, id) on delete set null (folder_id);

alter table flow_folder drop constraint if exists flow_folder_parent_id_fkey;
alter table flow_folder add constraint flow_folder_parent_fk
  foreign key (workspace_id, parent_id) references flow_folder (workspace_id, id) on delete cascade;

alter table flow_run drop constraint if exists flow_run_contact_id_fkey;
alter table flow_run drop constraint if exists flow_run_flow_id_fkey;
alter table flow_run add constraint flow_run_contact_fk
  foreign key (workspace_id, contact_id) references contact (workspace_id, id) on delete cascade;
alter table flow_run add constraint flow_run_flow_fk
  foreign key (workspace_id, flow_id) references flow (workspace_id, id) on delete cascade;

alter table message drop constraint if exists message_contact_id_fkey;
alter table message drop constraint if exists message_flow_run_id_fkey;
alter table message add constraint message_contact_fk
  foreign key (workspace_id, contact_id) references contact (workspace_id, id) on delete cascade;
alter table message add constraint message_flow_run_fk
  foreign key (workspace_id, flow_run_id) references flow_run (workspace_id, id) on delete set null (flow_run_id);

alter table node_stat drop constraint if exists node_stat_flow_id_fkey;
alter table node_stat add constraint node_stat_flow_fk
  foreign key (workspace_id, flow_id) references flow (workspace_id, id) on delete cascade;

alter table send_queue drop constraint if exists send_queue_contact_id_fkey;
alter table send_queue drop constraint if exists send_queue_flow_run_id_fkey;
alter table send_queue drop constraint if exists send_queue_broadcast_id_fkey;
alter table send_queue drop constraint if exists send_queue_sequence_step_id_fkey;
alter table send_queue add constraint send_queue_contact_fk
  foreign key (workspace_id, contact_id) references contact (workspace_id, id) on delete cascade;
alter table send_queue add constraint send_queue_flow_run_fk
  foreign key (workspace_id, flow_run_id) references flow_run (workspace_id, id) on delete set null (flow_run_id);
alter table send_queue add constraint send_queue_broadcast_fk
  foreign key (workspace_id, broadcast_id) references broadcast (workspace_id, id) on delete set null (broadcast_id);
alter table send_queue add constraint send_queue_sequence_step_fk
  foreign key (workspace_id, sequence_step_id) references sequence_step (workspace_id, id) on delete set null (sequence_step_id);

alter table sequence_step drop constraint if exists sequence_step_sequence_id_fkey;
alter table sequence_step drop constraint if exists sequence_step_flow_id_fkey;
alter table sequence_step add constraint sequence_step_sequence_fk
  foreign key (workspace_id, sequence_id) references sequence (workspace_id, id) on delete cascade;
alter table sequence_step add constraint sequence_step_flow_fk
  foreign key (workspace_id, flow_id) references flow (workspace_id, id) on delete set null (flow_id);

alter table sequence_subscription drop constraint if exists sequence_subscription_sequence_id_fkey;
alter table sequence_subscription drop constraint if exists sequence_subscription_contact_id_fkey;
alter table sequence_subscription add constraint sequence_subscription_sequence_fk
  foreign key (workspace_id, sequence_id) references sequence (workspace_id, id) on delete cascade;
alter table sequence_subscription add constraint sequence_subscription_contact_fk
  foreign key (workspace_id, contact_id) references contact (workspace_id, id) on delete cascade;

-- Child rows take their workspace from their parent, always: whatever the caller sent is
-- overwritten, so RLS's check (workspace_id = mine) rejects a row hung on someone else's parent.
create or replace function public.inherit_workspace()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  ref uuid := (to_jsonb(new) ->> tg_argv[1])::uuid;
  ws  uuid;
begin
  if ref is not null then
    execute format('select workspace_id from public.%I where id = $1', tg_argv[0]) into ws using ref;
    if ws is not null then
      new.workspace_id := ws;
    end if;
  end if;
  if new.workspace_id is null then
    new.workspace_id := public.current_workspace_id();
  end if;
  return new;
end $$;
revoke all on function public.inherit_workspace() from public, anon, authenticated;

-- Top-level rows: a bulk insert from the panel sends workspace_id as an explicit NULL (the column
-- default only covers a column left out), so fill it here too. Never overrides a value.
create or replace function public.fill_workspace()
returns trigger
language plpgsql
as $$
begin
  if new.workspace_id is null then
    new.workspace_id := public.current_workspace_id();
  end if;
  return new;
end $$;

do $$
declare
  t text;
begin
  foreach t in array array[
    'agent', 'bot_field', 'broadcast', 'contact', 'contact_segment', 'custom_field', 'flow',
    'flow_folder', 'media_asset', 'saved_reply', 'sequence', 'tag'
  ] loop
    execute format('drop trigger if exists %I on %I', t || '_fill_workspace', t);
    execute format('create trigger %I before insert on %I for each row execute function public.fill_workspace()', t || '_fill_workspace', t);
  end loop;
end $$;

do $$
declare
  r record;
begin
  for r in
    select * from (values
      ('contact_note', 'contact', 'contact_id'),
      ('message', 'contact', 'contact_id'),
      ('flow_run', 'contact', 'contact_id'),
      ('send_queue', 'contact', 'contact_id'),
      ('sequence_subscription', 'contact', 'contact_id'),
      ('conversion_event', 'contact', 'contact_id'),
      ('sequence_step', 'sequence', 'sequence_id'),
      ('node_stat', 'flow', 'flow_id')
    ) v(child, parent, col)
  loop
    execute format('drop trigger if exists %I on %I', r.child || '_workspace', r.child);
    execute format(
      'create trigger %I before insert or update of %I, workspace_id on %I for each row execute function public.inherit_workspace(%L, %L)',
      r.child || '_workspace', r.col, r.child, r.parent, r.col
    );
  end loop;
end $$;

-- ---- 6. row level security ------------------------------------------------------------------------------
-- Drop every policy on the tenant tables (including the paused_* anon ones), then grant each
-- workspace its own rows only, with the same verbs as before.
do $$
declare
  p record;
begin
  for p in
    select tablename, policyname from pg_policies
     where schemaname = 'public'
       and tablename in (
         'agent', 'app_settings', 'bot_field', 'broadcast', 'contact', 'contact_note', 'contact_segment',
         'conversion_event', 'custom_field', 'flow', 'flow_folder', 'flow_run', 'flow_template',
         'ig_account', 'media_asset', 'message', 'messenger_profile', 'node_stat', 'saved_reply',
         'send_guard', 'send_queue', 'sequence', 'sequence_step', 'sequence_subscription', 'tag',
         'webhook_event', 'oauth_state', 'seen_item', 'app_config', 'ig_token'
       )
  loop
    execute format('drop policy %I on %I', p.policyname, p.tablename);
  end loop;
end $$;

do $$
declare
  r record;
  verb text;
begin
  for r in
    select * from (values
      ('agent',                 'select,insert,update,delete'),
      ('bot_field',             'select,insert,update,delete'),
      ('broadcast',             'select,insert,update,delete'),
      ('contact_note',          'select,insert,update,delete'),
      ('contact_segment',       'select,insert,update,delete'),
      ('custom_field',          'select,insert,update,delete'),
      ('flow',                  'select,insert,update,delete'),
      ('flow_folder',           'select,insert,update,delete'),
      ('media_asset',           'select,insert,update,delete'),
      ('saved_reply',           'select,insert,update,delete'),
      ('sequence',              'select,insert,update,delete'),
      ('sequence_step',         'select,insert,update,delete'),
      ('sequence_subscription', 'select,insert,update,delete'),
      ('tag',                   'select,insert,update,delete'),
      ('contact',               'select,update,delete'),
      ('app_settings',          'select,update'),
      ('messenger_profile',     'select'),
      ('conversion_event',      'select'),
      ('flow_run',              'select'),
      ('message',               'select'),
      ('node_stat',             'select'),
      ('send_queue',            'select'),
      ('ig_account',            'select')
    ) v(tbl, verbs)
  loop
    foreach verb in array string_to_array(r.verbs, ',') loop
      if verb = 'select' or verb = 'delete' then
        execute format(
          'create policy %I on %I for %s to authenticated using (workspace_id = (select public.current_workspace_id()))',
          r.tbl || '_ws_' || verb, r.tbl, verb);
      elsif verb = 'insert' then
        execute format(
          'create policy %I on %I for insert to authenticated with check (workspace_id = (select public.current_workspace_id()))',
          r.tbl || '_ws_' || verb, r.tbl);
      else
        execute format(
          'create policy %I on %I for update to authenticated using (workspace_id = (select public.current_workspace_id())) with check (workspace_id = (select public.current_workspace_id()))',
          r.tbl || '_ws_' || verb, r.tbl);
      end if;
    end loop;
  end loop;
end $$;

create policy flow_template_read on flow_template for select to authenticated using (true);

create policy workspace_read on workspace for select to authenticated
  using (id = (select public.current_workspace_id()));
create policy workspace_rename on workspace for update to authenticated
  using (id = (select public.current_workspace_id())
         and exists (select 1 from workspace_member m where m.user_id = auth.uid() and m.role in ('owner', 'admin')))
  with check (id = (select public.current_workspace_id()));
create policy workspace_member_read on workspace_member for select to authenticated
  using (workspace_id = (select public.current_workspace_id()));

-- Uploads: each workspace writes under its own folder (<workspace id>/file). Reading stays public:
-- Instagram fetches images by URL.
drop policy if exists paused_media_upload on storage.objects;
drop policy if exists paused_media_delete on storage.objects;
drop policy if exists media_auth_upload on storage.objects;
drop policy if exists media_auth_delete on storage.objects;
create policy media_ws_upload on storage.objects for insert to authenticated
  with check (bucket_id = 'media' and (storage.foldername(name))[1] = (select public.current_workspace_id())::text);
create policy media_ws_delete on storage.objects for delete to authenticated
  using (bucket_id = 'media' and (storage.foldername(name))[1] = (select public.current_workspace_id())::text);

-- ---- 7. functions the panel calls: scoped to the caller's workspace ----------------------------------
create or replace function public.add_contact_tag(p_contact uuid, p_tag text)
returns void
language plpgsql
as $$
begin
  insert into tag (workspace_id, name)
  select c.workspace_id, p_tag from contact c where c.id = p_contact
  on conflict (workspace_id, name) do nothing;
  update contact
     set tags = (select array(select distinct unnest(tags || array[p_tag])))
   where id = p_contact;
end $$;

create or replace function public.bulk_tag(p_ids uuid[], p_tag text, p_add boolean)
returns integer
language plpgsql
as $$
declare n int;
begin
  if p_add then
    insert into tag (name) values (p_tag) on conflict (workspace_id, name) do nothing;
    update contact set tags = array_append(tags, p_tag)
     where id = any(p_ids) and workspace_id = public.current_workspace_id() and not (p_tag = any(tags));
  else
    update contact set tags = array_remove(tags, p_tag)
     where id = any(p_ids) and workspace_id = public.current_workspace_id() and p_tag = any(tags);
  end if;
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function public.bulk_set_field(p_ids uuid[], p_key text, p_value text)
returns integer
language plpgsql
as $$
declare n int;
begin
  if p_value is null then
    update contact set custom_fields = custom_fields - p_key
     where id = any(p_ids) and workspace_id = public.current_workspace_id() and custom_fields ? p_key;
  else
    insert into custom_field (key) values (p_key) on conflict (workspace_id, key) do nothing;
    update contact
       set custom_fields = coalesce(custom_fields, '{}'::jsonb) || jsonb_build_object(p_key, p_value)
     where id = any(p_ids) and workspace_id = public.current_workspace_id();
  end if;
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function public.delete_custom_field(p_key text)
returns void
language sql
as $$
  update contact set custom_fields = custom_fields - p_key
   where workspace_id = public.current_workspace_id() and custom_fields ? p_key;
  delete from custom_field where workspace_id = public.current_workspace_id() and key = p_key;
$$;

create or replace function public.delete_tag(p_name text)
returns void
language sql
as $$
  update contact set tags = array_remove(tags, p_name)
   where workspace_id = public.current_workspace_id() and p_name = any(tags);
  delete from tag where workspace_id = public.current_workspace_id() and name = p_name;
$$;

create or replace function public.rename_tag(p_old text, p_new text)
returns void
language plpgsql
as $$
declare ws uuid := public.current_workspace_id();
begin
  if ws is null or coalesce(trim(p_new), '') = '' or p_old = p_new then return; end if;
  update contact
     set tags = array(select distinct x from unnest(array_replace(tags, p_old, p_new)) x)
   where workspace_id = ws and p_old = any(tags);
  insert into tag (workspace_id, name) values (ws, p_new) on conflict (workspace_id, name) do nothing;
  delete from tag where workspace_id = ws and name = p_old;

  update broadcast
     set audience = (
       select jsonb_agg(case when e->>'field' = 'tag' and e->>'value' = p_old then jsonb_set(e, '{value}', to_jsonb(p_new)) else e end)
         from jsonb_array_elements(audience) e)
   where workspace_id = ws
     and audience @> jsonb_build_array(jsonb_build_object('field', 'tag', 'value', p_old));
  update broadcast set segment_tag = p_new where workspace_id = ws and segment_tag = p_old;

  update contact_segment
     set conditions = (
       select jsonb_agg(case when e->>'field' = 'tag' and e->>'value' = p_old then jsonb_set(e, '{value}', to_jsonb(p_new)) else e end)
         from jsonb_array_elements(conditions) e)
   where workspace_id = ws
     and conditions @> jsonb_build_array(jsonb_build_object('field', 'tag', 'value', p_old));
end $$;

create or replace function public.tag_counts()
returns table(name text, contacts bigint)
language sql
stable
as $$
  select coalesce(t.name, u.name), coalesce(u.n, 0)
    from (select tg.name from tag tg where tg.workspace_id = public.current_workspace_id()) t
    full join (
      select x as name, count(*) as n
        from contact, unnest(tags) x
       where contact.workspace_id = public.current_workspace_id()
       group by x
    ) u on u.name = t.name;
$$;

create or replace function public.field_counts()
returns table(key text, contacts bigint)
language sql
stable
as $$
  select e.key, count(*)
    from contact c, jsonb_each_text(c.custom_fields) e
   where c.workspace_id = public.current_workspace_id()
     and coalesce(e.value, '') <> ''
   group by e.key;
$$;

create or replace function public.flow_run_counts()
returns table(flow_id uuid, runs bigint)
language sql
stable
as $$
  select r.flow_id, count(*) from flow_run r
   where r.workspace_id = public.current_workspace_id()
   group by r.flow_id;
$$;

create or replace function public.flow_conversion_counts()
returns table(flow_id uuid, conversions bigint, total numeric)
language sql
stable
set search_path = public
as $$
  select e.flow_id, count(*), coalesce(sum(e.value), 0)
    from conversion_event e
   where e.workspace_id = public.current_workspace_id() and e.flow_id is not null
   group by e.flow_id
$$;

create or replace function public.broadcast_stats()
returns table(broadcast_id uuid, queued bigint, delivered bigint, failed bigint)
language sql
stable
set search_path = public
as $$
  select q.broadcast_id,
         count(*),
         count(*) filter (where q.status = 'sent'),
         count(*) filter (where q.status in ('failed', 'expired'))
    from send_queue q
   where q.workspace_id = public.current_workspace_id() and q.broadcast_id is not null
   group by q.broadcast_id
$$;

create or replace function public.sequence_step_stats()
returns table(sequence_step_id uuid, queued bigint, delivered bigint, failed bigint)
language sql
stable
set search_path = public
as $$
  select q.sequence_step_id,
         count(*),
         count(*) filter (where q.status = 'sent'),
         count(*) filter (where q.status in ('failed', 'expired'))
    from send_queue q
   where q.workspace_id = public.current_workspace_id() and q.sequence_step_id is not null
   group by q.sequence_step_id
$$;

-- The one condition evaluator. The panel gets its own workspace; the broadcast worker (service
-- role, no user) must say which workspace it means.
drop function if exists public.match_contacts(jsonb, text);
create or replace function public.match_contacts(
  p_conditions jsonb default '[]'::jsonb,
  p_search text default '',
  p_workspace uuid default null
)
returns setof contact
language sql
stable
as $$
  select c.*
    from contact c
   where c.workspace_id = coalesce(p_workspace, public.current_workspace_id())
     and public.contact_matches(c, p_conditions)
     and (
       coalesce(trim(p_search), '') = ''
       or position(lower(trim(p_search)) in lower(coalesce(c.name, '') || ' ' || coalesce(c.username, '') || ' ' || c.igsid)) > 0
     );
$$;

-- ---- 8. sending: limits, breaker and viral switch per workspace -------------------------------------
drop index if exists send_queue_used_idx;
create index if not exists send_queue_used_idx
  on send_queue (workspace_id, (coalesce(sent_at, claimed_at)))
  where status in ('sent', 'sending', 'failed');
create index if not exists send_queue_ws_drain_idx on send_queue (workspace_id, status, next_attempt_at);

drop function if exists public.send_used(text, interval);
create or replace function public.send_used(p_workspace uuid, p_class text, p_window interval)
returns int
language sql
stable
security definer
set search_path = public
as $$
  select count(*)::int
    from send_queue q
   where q.workspace_id = p_workspace
     and q.status in ('sent', 'sending', 'failed')
     and coalesce(q.sent_at, q.claimed_at) >= now() - p_window
     and public.send_class(q) = p_class
$$;

-- Same rules as migration 27, applied per workspace. Workspaces with due rows share one claim's
-- batch, so a big broadcast in one workspace can't hold up replies in another.
create or replace function public.claim_send_batch()
returns setof send_queue
language plpgsql
security definer
set search_path = public
as $$
declare
  g           send_guard;
  cls         text;
  lim         jsonb;
  budget      int;
  per_contact int;
  batch       int := 100;
  share       int;
  ready       int;
  taken       int := 0;
  ws_taken    int;
  got         int;
begin
  perform pg_advisory_xact_lock(hashtext('claim_send_batch'));

  select count(*) into ready
    from send_guard sg
   where (sg.paused_until is null or sg.paused_until <= now())
     and exists (
       select 1 from send_queue s
        where s.workspace_id = sg.workspace_id
          and ((s.status = 'pending' and s.next_attempt_at <= now())
            or (s.status = 'sending' and s.claimed_at < now() - interval '5 minutes')));
  if ready = 0 then return; end if;
  share := greatest(10, ceil(batch::numeric / ready)::int);

  for g in
    select sg.*
      from send_guard sg
     where (sg.paused_until is null or sg.paused_until <= now())
       and exists (
         select 1 from send_queue s
          where s.workspace_id = sg.workspace_id
            and ((s.status = 'pending' and s.next_attempt_at <= now())
              or (s.status = 'sending' and s.claimed_at < now() - interval '5 minutes')))
     order by (select min(s.next_attempt_at) from send_queue s
                where s.workspace_id = sg.workspace_id and s.status = 'pending')
  loop
    exit when taken >= batch;
    ws_taken := 0;
    per_contact := coalesce((g.limits->>'per_contact_hour')::int, 25);

    foreach cls in array array['reactive', 'private_reply', 'public_reply', 'proactive'] loop
      continue when cls = 'public_reply'
                and g.public_paused_until is not null and g.public_paused_until > now();
      lim := g.limits->cls;
      budget := least(
        coalesce((lim->>'minute')::int, 0) - public.send_used(g.workspace_id, cls, interval '1 minute'),
        coalesce((lim->>'hour')::int, 0) - public.send_used(g.workspace_id, cls, interval '1 hour'),
        least(coalesce((g.limits->>'batch')::int, batch), share) - ws_taken,
        batch - taken
      );
      continue when budget <= 0;

      return query
        with claimed as (
          update send_queue q
             set status = 'sending', claimed_at = now()
           where q.id in (
             select s.id
               from send_queue s
              where s.workspace_id = g.workspace_id
                and ((s.status = 'pending' and s.next_attempt_at <= now())
                  or (s.status = 'sending' and s.claimed_at < now() - interval '5 minutes'))
                and public.send_class(s) = cls
                and (s.send_type = 'public_reply' or (
                  select count(*)
                    from send_queue x
                   where x.contact_id = s.contact_id
                     and x.send_type <> 'public_reply'
                     and x.status in ('sent', 'sending', 'failed')
                     and coalesce(x.sent_at, x.claimed_at) >= now() - interval '1 hour'
                ) < per_contact)
              order by s.created_at
              limit budget
              for update skip locked
           )
          returning q.*
        )
        select * from claimed;
      get diagnostics got = row_count;
      taken := taken + got;
      ws_taken := ws_taken + got;
    end loop;
  end loop;
end $$;

drop function if exists public.pause_sending(int, text);
create or replace function public.pause_sending(p_workspace uuid, p_minutes int, p_reason text)
returns void
language sql
security definer
set search_path = public
as $$
  update send_guard
     set paused_until = greatest(coalesce(paused_until, now()), now() + make_interval(mins => p_minutes)),
         pause_reason = p_reason,
         updated_at = now()
   where workspace_id = p_workspace;
$$;

drop function if exists public.send_guard_tick();
create or replace function public.send_guard_tick()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  g        send_guard;
  comments int;
begin
  for g in select * from send_guard for update loop
    select count(*) into comments
      from send_queue
     where workspace_id = g.workspace_id
       and send_type = 'private_reply'
       and created_at >= now() - interval '1 hour';

    if comments > coalesce((g.limits->>'viral_comments_hour')::int, 712)
       and (g.public_paused_until is null or g.public_paused_until < now()) then
      update send_guard
         set public_paused_until = now() + make_interval(hours => coalesce((g.limits->>'viral_pause_hours')::int, 24)),
             public_pause_reason = format('%s comments started automations in one hour', comments),
             updated_at = now()
       where workspace_id = g.workspace_id
      returning * into g;
    end if;

    if g.public_paused_until is not null and g.public_paused_until > now() then
      update send_queue
         set status = 'expired',
             error = 'Skipped: replies under comments are paused (' || coalesce(g.public_pause_reason, 'safety') || ')'
       where workspace_id = g.workspace_id
         and send_type = 'public_reply'
         and status = 'pending';
    end if;
  end loop;
end $$;

create or replace function public.sending_health()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'paused_until',        case when g.paused_until > now() then g.paused_until end,
    'pause_reason',        case when g.paused_until > now() then g.pause_reason end,
    'public_paused_until', case when g.public_paused_until > now() then g.public_paused_until end,
    'public_pause_reason', case when g.public_paused_until > now() then g.public_pause_reason end,
    'limits',              g.limits,
    'last_event_at',       (select max(received_at) from webhook_event where workspace_id = g.workspace_id),
    'sent_last_hour',      (select count(*) from send_queue
                             where workspace_id = g.workspace_id
                               and status = 'sent' and sent_at >= now() - interval '1 hour')
  )
  from send_guard g
  where g.workspace_id = public.current_workspace_id()
$$;

-- ---- 9. who may call what ------------------------------------------------------------------------------
revoke all on function public.send_used(uuid, text, interval) from public, anon, authenticated;
revoke all on function public.claim_send_batch() from public, anon, authenticated;
revoke all on function public.pause_sending(uuid, int, text) from public, anon, authenticated;
revoke all on function public.send_guard_tick() from public, anon, authenticated;
revoke all on function public.sending_health() from public, anon;
grant execute on function public.sending_health() to authenticated;
revoke all on function public.invoke_edge(text) from public, anon, authenticated;
revoke all on function public.kick_edge(text) from public, anon, authenticated;
grant execute on function public.kick_edge(text) to service_role;
grant execute on function public.invoke_edge(text) to service_role;

-- Panel functions: signed-in users only (RLS scopes them; anon has no rows anyway).
do $$
declare
  f text;
begin
  foreach f in array array[
    'add_contact_tag(uuid, text)', 'remove_contact_tag(uuid, text)', 'bulk_tag(uuid[], text, boolean)',
    'bulk_set_field(uuid[], text, text)', 'delete_custom_field(text)', 'delete_tag(text)',
    'rename_tag(text, text)', 'tag_counts()', 'field_counts()', 'flow_run_counts()',
    'flow_conversion_counts()', 'broadcast_stats()', 'sequence_step_stats()',
    'match_contacts(jsonb, text, uuid)', 'bump_node(uuid, text)'
  ] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated, service_role', f);
  end loop;
end $$;

-- ---- 10. sign a login out everywhere (password reset, disable) -----------------------------------------
-- Deleting the sessions kills their refresh tokens; an access token already issued lapses within
-- the hour (jwt_exp).
create or replace function public.revoke_sessions(p_user uuid)
returns void
language sql
security definer
set search_path = public, auth
as $$
  delete from auth.sessions where user_id = p_user;
$$;
revoke all on function public.revoke_sessions(uuid) from public, anon, authenticated;
grant execute on function public.revoke_sessions(uuid) to service_role;
