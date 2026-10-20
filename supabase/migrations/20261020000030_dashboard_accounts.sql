-- Accounts are created from the Supabase dashboard (Authentication › Users › Add user), not n8n.
--
-- A new auth user gets its own workspace and owner membership automatically:
--   username   the part of the email before "@", cleaned to [a-z0-9._], 3-30 characters
--              (a taken one gets a number on the end)
--   workspace  named after the username; the owner can rename it in Settings › Account
-- The panel signs in with the username alone when the email is <username>@login.iklipse.invalid,
-- or with the full email for any other address.
--
-- admin_set_password(): set a login's password from the SQL editor (there is no email reset).

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  base  text;
  uname text;
  n     int := 0;
  ws    uuid;
begin
  if exists (select 1 from workspace_member where user_id = new.id) then
    return new;
  end if;

  base := lower(split_part(coalesce(new.email, ''), '@', 1));
  base := regexp_replace(base, '[^a-z0-9._]+', '.', 'g');
  base := regexp_replace(base, '^[._]+|[._]+$', '', 'g');
  base := left(base, 26);
  if length(base) < 3 then
    base := 'user' || base;
  end if;

  uname := base;
  while exists (select 1 from workspace_member where username = uname) loop
    n := n + 1;
    uname := base || n;
  end loop;

  insert into workspace (name)
  values (coalesce(nullif(trim(new.raw_user_meta_data ->> 'workspace'), ''), uname))
  returning id into ws;

  insert into workspace_member (workspace_id, user_id, username, role)
  values (ws, new.id, uname, 'owner');

  return new;
end $$;
revoke all on function public.handle_new_user() from public, anon, authenticated;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- select public.admin_set_password('ahmed', 'new-password-here');
create or replace function public.admin_set_password(p_username text, p_password text)
returns text
language plpgsql
security definer
set search_path = public, auth, extensions
as $$
declare
  uid uuid;
begin
  if length(coalesce(p_password, '')) < 10 then
    raise exception 'Use at least 10 characters.';
  end if;
  select user_id into uid from workspace_member where username = lower(trim(p_username));
  if uid is null then
    raise exception 'No login is called "%".', p_username;
  end if;
  update auth.users
     set encrypted_password = crypt(p_password, gen_salt('bf')),
         updated_at = now()
   where id = uid;
  -- Whoever had the old password is signed out.
  delete from auth.sessions where user_id = uid;
  return 'Password changed for ' || lower(trim(p_username));
end $$;
revoke all on function public.admin_set_password(text, text) from public, anon, authenticated, service_role;
