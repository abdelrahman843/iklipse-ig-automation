-- Live Chat extras: saved replies (canned responses) and a team-member roster for assignment.

create table if not exists saved_reply (
  id         uuid primary key default gen_random_uuid(),
  title      text not null,
  body       text not null,
  created_at timestamptz not null default now()
);

create table if not exists agent (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique,
  created_at timestamptz not null default now()
);

do $$
declare t text;
begin
  foreach t in array array['saved_reply','agent'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists %I_anon_all on %I', t, t);
    execute format('create policy %I_anon_all on %I for all to anon using (true) with check (true)', t, t);
    execute format('drop policy if exists %I_auth_all on %I', t, t);
    execute format('create policy %I_auth_all on %I for all to authenticated using (true) with check (true)', t, t);
  end loop;
end $$;
