-- A webhook event that fails is retried instead of dropped.
--
-- Before: claim_webhook_events set processed_at when it claimed a row, and nothing looked at the
-- row again. A brief database error, or the engine being cut off mid-batch, meant those comments
-- and DMs were never answered.
-- Now:
--   processed_at  when the row was last claimed
--   done_at       set by process-events once every item in it was handled
--   attempts      how many times it was claimed; a row is given up on after 5
-- A row claimed more than 5 minutes ago and still not done is claimed again.
--
-- seen_item remembers which event recorded each message and comment, so a retry of that same
-- event still handles them (a re-delivery by Meta, a different event, is still skipped).

alter table webhook_event add column if not exists done_at  timestamptz;
alter table webhook_event add column if not exists attempts int not null default 0;

-- Everything claimed before this migration counts as done.
update webhook_event set done_at = processed_at where processed_at is not null and done_at is null;

create index if not exists webhook_event_pending_idx
  on webhook_event (received_at) where done_at is null;

alter table seen_item add column if not exists event_id uuid;

create or replace function public.claim_webhook_events(batch_size int default 50)
returns setof webhook_event
language sql
security definer
set search_path = public
as $$
  update webhook_event
     set processed_at = now(),
         attempts = attempts + 1
   where id in (
     select id from webhook_event
      where done_at is null
        and attempts < 5
        and (processed_at is null or processed_at < now() - interval '5 minutes')
      order by received_at
      for update skip locked
      limit batch_size
   )
  returning *;
$$;

revoke all on function public.claim_webhook_events(int) from public, anon, authenticated;
