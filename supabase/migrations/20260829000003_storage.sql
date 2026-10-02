-- Public bucket for outbound images. Meta fetches these by URL, so they must be public.
-- Inbound media is never stored here: Meta's policy allows keeping the CDN URL only.

insert into storage.buckets (id, name, public)
values ('media', 'media', true)
on conflict (id) do update set public = true;

drop policy if exists media_public_read on storage.objects;
create policy media_public_read on storage.objects
  for select using (bucket_id = 'media');

drop policy if exists media_anon_upload on storage.objects;
create policy media_anon_upload on storage.objects
  for insert to anon with check (bucket_id = 'media');

drop policy if exists media_anon_delete on storage.objects;
create policy media_anon_delete on storage.objects
  for delete to anon using (bucket_id = 'media');
