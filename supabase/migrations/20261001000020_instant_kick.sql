-- Instant hand-off between workers, fired by the database.
--
-- The edge functions used to wake the next worker with a fire-and-forget fetch (kick). In
-- production that call often never landed, so every step waited for its one-minute cron:
-- webhook -> process-events (up to 60s) -> send-worker (up to 60s), about two minutes per reply.
--
-- Now an insert wakes the worker through pg_net, the same path the cron jobs use (and which is
-- known to work). The request is queued inside the transaction and sent after commit, so the
-- worker always sees the new row. A request already waiting in the pg_net queue for the same
-- worker is enough: a broadcast inserting 2,000 queue rows wakes send-worker once, not 2,000 times.
-- Duplicate wake-ups are harmless anyway; every worker claims its rows atomically.

create or replace function public.kick_edge(fn text)
returns void
language plpgsql
security definer
set search_path = public, net
as $$
begin
  if exists (
    select 1 from net.http_request_queue q
     where q.url like '%/' || fn
  ) then
    return;
  end if;
  perform public.invoke_edge(fn);
end $$;

revoke all on function public.kick_edge(text) from public, anon, authenticated;

create or replace function public.kick_on_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.kick_edge(tg_argv[0]);
  return null;
end $$;

revoke all on function public.kick_on_insert() from public, anon, authenticated;

drop trigger if exists webhook_event_kick on webhook_event;
create trigger webhook_event_kick
  after insert on webhook_event
  for each statement execute function public.kick_on_insert('process-events');

drop trigger if exists send_queue_kick on send_queue;
create trigger send_queue_kick
  after insert on send_queue
  for each statement execute function public.kick_on_insert('send-worker');
