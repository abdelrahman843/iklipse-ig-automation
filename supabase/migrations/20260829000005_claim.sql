-- Events are now processed the moment they arrive, so two workers can be in flight at once.
-- Claiming rows atomically is what stops the same comment from being answered twice.

create or replace function public.claim_webhook_events(batch_size int default 50)
returns setof webhook_event
language sql
security definer
set search_path = public
as $$
  update webhook_event
  set processed_at = now()
  where id in (
    select id from webhook_event
    where processed_at is null
    order by received_at
    for update skip locked
    limit batch_size
  )
  returning *;
$$;

revoke all on function public.claim_webhook_events(int) from anon, authenticated;
