-- Turn login back on: undo migration 19 (login_paused).
--
-- Not in migrations/ on purpose. When you want login back:
--   1. npx supabase migration new relock_login
--      then paste this file's contents into the new migration file
--   2. npx supabase db push
--   3. .env: VITE_DISABLE_AUTH=false, restart / rebuild the panel
--   4. npx supabase secrets unset ALLOW_ANON

do $$
declare p record;
begin
  for p in
    select schemaname, tablename, policyname
    from pg_policies
    where schemaname in ('public', 'storage') and policyname like 'paused\_%'
  loop
    execute format('drop policy if exists %I on %I.%I', p.policyname, p.schemaname, p.tablename);
  end loop;
end $$;
