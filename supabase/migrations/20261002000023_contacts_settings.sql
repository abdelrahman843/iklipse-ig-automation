-- Contacts (ManyChat's Audience page) and the Settings tabs.
--
-- Contacts: one SQL definition of "who matches these conditions", used by the Contacts page, its
-- saved segments and the broadcast worker, so a filter means the same thing everywhere. Bulk
-- actions are set-based functions instead of one request per contact.
-- Settings: General (time zone), Live Chat (how long a human reply pauses automation), Team,
-- Fields and Tags.

-- ---- settings ----------------------------------------------------------------------------------
create table if not exists app_settings (
  id                  int primary key default 1 check (id = 1),
  timezone            text,                                -- null = the browser's own time zone
  human_pause_minutes int  not null default 30 check (human_pause_minutes between 0 and 10080),
  updated_at          timestamptz not null default now()
);
insert into app_settings (id) values (1) on conflict (id) do nothing;

alter table app_settings enable row level security;
drop policy if exists app_settings_auth_read on app_settings;
create policy app_settings_auth_read on app_settings for select to authenticated using (true);
drop policy if exists app_settings_auth_write on app_settings;
create policy app_settings_auth_write on app_settings for update to authenticated using (true) with check (true);

-- ---- saved segments ------------------------------------------------------------------------------
create table if not exists contact_segment (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  conditions jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

alter table contact_segment enable row level security;
drop policy if exists contact_segment_auth_all on contact_segment;
create policy contact_segment_auth_all on contact_segment for all to authenticated using (true) with check (true);

-- Contacts can be deleted from the panel (messages, runs, notes and subscriptions cascade).
drop policy if exists contact_auth_delete on contact;
create policy contact_auth_delete on contact for delete to authenticated using (true);

-- Login is paused (migration 19): mirror the new policies for anon. relock-login.sql drops every
-- paused_* policy.
drop policy if exists paused_app_settings_auth_read on app_settings;
create policy paused_app_settings_auth_read on app_settings for select to anon using (true);
drop policy if exists paused_app_settings_auth_write on app_settings;
create policy paused_app_settings_auth_write on app_settings for update to anon using (true) with check (true);
drop policy if exists paused_contact_segment_auth_all on contact_segment;
create policy paused_contact_segment_auth_all on contact_segment for all to anon using (true) with check (true);
drop policy if exists paused_contact_auth_delete on contact;
create policy paused_contact_auth_delete on contact for delete to anon using (true);

-- ---- conditions ----------------------------------------------------------------------------------
-- One condition is {field, op, value} (plus key for custom fields). All of them must hold.
--   tag        is | is_not                       value = tag name
--   custom     is | is_not | contains | empty | not_empty   key = field key
--   subscribed is                                value = yes | no   (opted out of broadcasts)
--   last_seen  within | older                    value = days
--   created    within | older                    value = days
--   assigned   is | is_not                       value = team member, '' = nobody
--   status     is                                value = open | done
--   follows    is                                value = yes | no | unknown
-- Unknown fields and half-filled conditions are ignored rather than matching nobody.
create or replace function public.contact_matches(c contact, p_conditions jsonb)
returns boolean
language plpgsql
stable
as $$
declare
  cond jsonb;
  f    text;
  op   text;
  v    text;
  cur  text;
  ts   timestamptz;
begin
  for cond in select value from jsonb_array_elements(coalesce(p_conditions, '[]'::jsonb)) loop
    f  := cond->>'field';
    op := coalesce(cond->>'op', 'is');
    v  := coalesce(cond->>'value', '');

    if f = 'tag' then
      continue when v = '';
      if op = 'is_not' then
        if v = any(c.tags) then return false; end if;
      elsif not (v = any(c.tags)) then
        return false;
      end if;

    elsif f = 'custom' then
      continue when coalesce(cond->>'key', '') = '';
      cur := coalesce(c.custom_fields ->> (cond->>'key'), '');
      if op = 'empty' then
        if cur <> '' then return false; end if;
      elsif op = 'not_empty' then
        if cur = '' then return false; end if;
      elsif op = 'contains' then
        if position(lower(v) in lower(cur)) = 0 then return false; end if;
      elsif op = 'is_not' then
        if lower(cur) = lower(v) then return false; end if;
      elsif lower(cur) <> lower(v) then
        return false;
      end if;

    elsif f = 'subscribed' then
      if (v = 'yes') <> (c.opted_out_at is null) then return false; end if;

    elsif f in ('last_seen', 'created') then
      continue when v !~ '^\d{1,5}$';
      ts := case when f = 'last_seen' then c.last_interaction_at else c.created_at end;
      if op = 'older' then
        if ts is not null and ts >= now() - make_interval(days => v::int) then return false; end if;
      elsif ts is null or ts < now() - make_interval(days => v::int) then
        return false;
      end if;

    elsif f = 'assigned' then
      if op = 'is_not' then
        if coalesce(c.assigned_to, '') = v then return false; end if;
      elsif coalesce(c.assigned_to, '') <> v then
        return false;
      end if;

    elsif f = 'status' then
      if (case when c.status = 'done' then 'done' else 'open' end) <> v then return false; end if;

    elsif f = 'follows' then
      if v = 'unknown' then
        if c.follows_account is not null then return false; end if;
      elsif c.follows_account is distinct from (v = 'yes') then
        return false;
      end if;
    end if;
  end loop;
  return true;
end $$;

-- Contacts matching the conditions and a free-text search (name, username or Instagram id).
-- Returns contact rows, so callers can still filter, order, page and count through PostgREST.
create or replace function public.match_contacts(p_conditions jsonb default '[]'::jsonb, p_search text default '')
returns setof contact
language sql
stable
as $$
  select c.*
    from contact c
   where public.contact_matches(c, p_conditions)
     and (
       coalesce(trim(p_search), '') = ''
       or position(lower(trim(p_search)) in lower(coalesce(c.name, '') || ' ' || coalesce(c.username, '') || ' ' || c.igsid)) > 0
     );
$$;

-- ---- bulk actions --------------------------------------------------------------------------------
create or replace function public.bulk_tag(p_ids uuid[], p_tag text, p_add boolean)
returns int
language plpgsql
as $$
declare n int;
begin
  if p_add then
    insert into tag (name) values (p_tag) on conflict (name) do nothing;
    update contact set tags = array_append(tags, p_tag) where id = any(p_ids) and not (p_tag = any(tags));
  else
    update contact set tags = array_remove(tags, p_tag) where id = any(p_ids) and p_tag = any(tags);
  end if;
  get diagnostics n = row_count;
  return n;
end $$;

-- p_value null clears the field.
create or replace function public.bulk_set_field(p_ids uuid[], p_key text, p_value text)
returns int
language plpgsql
as $$
declare n int;
begin
  if p_value is null then
    update contact set custom_fields = custom_fields - p_key where id = any(p_ids) and custom_fields ? p_key;
  else
    insert into custom_field (key) values (p_key) on conflict (key) do nothing;
    update contact
       set custom_fields = coalesce(custom_fields, '{}'::jsonb) || jsonb_build_object(p_key, p_value)
     where id = any(p_ids);
  end if;
  get diagnostics n = row_count;
  return n;
end $$;

-- ---- tags ----------------------------------------------------------------------------------------
-- Every tag with how many contacts carry it, including tags on contacts that never reached the
-- registry.
create or replace function public.tag_counts()
returns table (name text, contacts bigint)
language sql
stable
as $$
  select coalesce(t.name, u.name), coalesce(u.n, 0)
    from tag t
    full join (select x as name, count(*) as n from contact, unnest(tags) x group by x) u on u.name = t.name;
$$;

-- Renames on contacts, the registry, broadcast audiences and saved segments. Automations are
-- rewritten by the panel, which owns the graph format. Renaming onto an existing tag merges them.
create or replace function public.rename_tag(p_old text, p_new text)
returns void
language plpgsql
as $$
begin
  if coalesce(trim(p_new), '') = '' or p_old = p_new then return; end if;
  update contact
     set tags = array(select distinct x from unnest(array_replace(tags, p_old, p_new)) x)
   where p_old = any(tags);
  insert into tag (name) values (p_new) on conflict (name) do nothing;
  delete from tag where name = p_old;

  update broadcast
     set audience = (
       select jsonb_agg(case when e->>'field' = 'tag' and e->>'value' = p_old then jsonb_set(e, '{value}', to_jsonb(p_new)) else e end)
         from jsonb_array_elements(audience) e)
   where audience @> jsonb_build_array(jsonb_build_object('field', 'tag', 'value', p_old));
  update broadcast set segment_tag = p_new where segment_tag = p_old;

  update contact_segment
     set conditions = (
       select jsonb_agg(case when e->>'field' = 'tag' and e->>'value' = p_old then jsonb_set(e, '{value}', to_jsonb(p_new)) else e end)
         from jsonb_array_elements(conditions) e)
   where conditions @> jsonb_build_array(jsonb_build_object('field', 'tag', 'value', p_old));
end $$;

-- Removes the tag from every contact and the registry. Conditions that name it are left alone:
-- dropping "tag is VIP" from a broadcast would widen it to everyone.
create or replace function public.delete_tag(p_name text)
returns void
language sql
as $$
  update contact set tags = array_remove(tags, p_name) where p_name = any(tags);
  delete from tag where name = p_name;
$$;

-- ---- custom fields -------------------------------------------------------------------------------
create or replace function public.field_counts()
returns table (key text, contacts bigint)
language sql
stable
as $$
  select e.key, count(*)
    from contact c, jsonb_each_text(c.custom_fields) e
   where coalesce(e.value, '') <> ''
   group by e.key;
$$;

create or replace function public.delete_custom_field(p_key text)
returns void
language sql
as $$
  update contact set custom_fields = custom_fields - p_key where custom_fields ? p_key;
  delete from custom_field where key = p_key;
$$;
