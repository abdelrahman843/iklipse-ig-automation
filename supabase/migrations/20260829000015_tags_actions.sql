-- Tags, conversation status, and the tag registry (Automations parity pass).
--
-- Tags are the backbone of ManyChat-style automation: an Action node adds/removes them, a
-- Condition branches on them, the inbox filters by them, and (later) broadcasts segment on them.
-- We store them as a text[] on the contact for O(1) read with the row, plus a registry table so
-- the panel can list every tag that exists without scanning every contact.

alter table contact
  add column if not exists tags         text[] not null default '{}',
  add column if not exists status       text   not null default 'open',  -- open | done | snoozed
  add column if not exists snooze_until timestamptz;

-- Fast membership filtering (contact where tags @> '{vip}').
create index if not exists contact_tags_idx on contact using gin (tags);

-- The tag registry: one row per tag name that has ever been used, so pickers and filters can
-- enumerate them. The Action-node editor upserts here on save; the engine upserts on add_tag.
create table if not exists tag (
  name       text primary key,
  created_at timestamptz not null default now()
);

alter table tag enable row level security;

drop policy if exists tag_anon_all on tag;
create policy tag_anon_all on tag for all to anon using (true) with check (true);

drop policy if exists tag_auth_all on tag;
create policy tag_auth_all on tag for all to authenticated using (true) with check (true);

-- Add or remove a tag on a contact atomically, keeping the array distinct, and register the name.
-- Used by the Action node in the engine and by the inbox tag editor.
create or replace function add_contact_tag(p_contact uuid, p_tag text) returns void
language plpgsql as $$
begin
  insert into tag(name) values (p_tag) on conflict (name) do nothing;
  update contact
    set tags = (select array(select distinct unnest(tags || array[p_tag])))
    where id = p_contact;
end;
$$;

create or replace function remove_contact_tag(p_contact uuid, p_tag text) returns void
language sql as $$
  update contact set tags = array_remove(tags, p_tag) where id = p_contact;
$$;
