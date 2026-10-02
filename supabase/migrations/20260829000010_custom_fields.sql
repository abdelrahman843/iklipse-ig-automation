-- Custom field definitions (Task 2). A collect node writes its value into contact.custom_fields
-- (a jsonb bag that already exists); this table registers each key so the panel can list and
-- filter on them without scanning every contact. The engine upserts a row when it collects; the
-- editor upserts one when a flow with a collect node is saved.

create table if not exists custom_field (
  key        text primary key,
  label      text,
  type       text not null default 'text',  -- email | phone | text | number | url | choice
  created_at timestamptz not null default now()
);

alter table custom_field enable row level security;

-- Same access shape as flow: the control panel manages these directly.
drop policy if exists custom_field_anon_all on custom_field;
create policy custom_field_anon_all on custom_field for all to anon using (true) with check (true);

drop policy if exists custom_field_auth_all on custom_field;
create policy custom_field_auth_all on custom_field for all to authenticated using (true) with check (true);
