-- Sending safety: what keeps the connected Instagram account clear of Meta's spam systems.
--
-- What gets accounts restricted is not the API, it is behaviour: bursts of automated sends,
-- the same public reply under hundreds of comments when a post goes viral, and retrying through
-- a block. So:
--
-- 1. send_guard: one row with the send limits and the circuit breaker. The limits live here so
--    the claim, the worker and the panel read the same numbers. No policies (service role only);
--    the panel reads it through sending_health().
-- 2. send_queue.proactive + send_class(): which budget a send draws from.
--      reactive       a reply to something the contact just did
--      private_reply  the one DM a comment allows
--      public_reply   a reply posted under a comment
--      proactive      a broadcast or sequence message the contact did not just ask for
-- 3. claim_send_batch(): claims due rows per class, never past that class's per-minute and
--    per-hour limit or a contact's hourly limit. An advisory lock serialises claimers, so
--    overlapping workers cannot spend the same budget twice. Nothing is claimed while the
--    breaker is open.
-- 4. send_guard_tick(): the viral switch. Too many comment automations in an hour turns replies
--    under comments off for a day and drops the queued ones.
-- 5. seen_item: Meta re-delivers a webhook it thinks we missed. Each message and comment is
--    handled once.

-- ---- 1. guard ----------------------------------------------------------------------------------
create table if not exists send_guard (
  id                  int primary key default 1 check (id = 1),
  paused_until        timestamptz,   -- breaker: nothing is sent before this
  pause_reason        text,
  public_paused_until timestamptz,   -- viral switch: no replies under comments before this
  public_pause_reason text,
  limits              jsonb not null default '{
    "reactive":      {"minute": 30, "hour": 600},
    "private_reply": {"minute": 12, "hour": 720},
    "public_reply":  {"minute": 2,  "hour": 30},
    "proactive":     {"minute": 4,  "hour": 200},
    "per_contact_hour": 25,
    "viral_comments_hour": 40,
    "viral_pause_hours": 24
  }'::jsonb,
  updated_at          timestamptz not null default now()
);
insert into send_guard (id) values (1) on conflict (id) do nothing;
alter table send_guard enable row level security;

-- ---- 2. classes ----------------------------------------------------------------------------------
alter table send_queue add column if not exists proactive boolean not null default false;
update send_queue set proactive = true
 where not proactive and (broadcast_id is not null or sequence_step_id is not null);

create or replace function public.send_class(q send_queue)
returns text
language sql
immutable
as $$
  select case
    when q.send_type = 'private_reply' then 'private_reply'
    when q.send_type = 'public_reply'  then 'public_reply'
    when q.proactive                   then 'proactive'
    else 'reactive'
  end
$$;

-- Rows that already cost a call to Meta: delivered, in flight, or failed after trying.
create index if not exists send_queue_used_idx
  on send_queue ((coalesce(sent_at, claimed_at)))
  where status in ('sent', 'sending', 'failed');

create or replace function public.send_used(p_class text, p_window interval)
returns int
language sql
stable
security definer
set search_path = public
as $$
  select count(*)::int
    from send_queue q
   where q.status in ('sent', 'sending', 'failed')
     and coalesce(q.sent_at, q.claimed_at) >= now() - p_window
     and public.send_class(q) = p_class
$$;

-- ---- 3. claim ------------------------------------------------------------------------------------
create or replace function public.claim_send_batch()
returns setof send_queue
language plpgsql
security definer
set search_path = public
as $$
declare
  g           send_guard;
  cls         text;
  lim         jsonb;
  budget      int;
  per_contact int;
begin
  -- One claimer at a time: the budget check and the claim must not interleave.
  perform pg_advisory_xact_lock(hashtext('claim_send_batch'));

  select * into g from send_guard where id = 1;
  if g.paused_until is not null and g.paused_until > now() then
    return;
  end if;
  per_contact := coalesce((g.limits->>'per_contact_hour')::int, 25);

  foreach cls in array array['reactive', 'private_reply', 'public_reply', 'proactive'] loop
    continue when cls = 'public_reply'
              and g.public_paused_until is not null and g.public_paused_until > now();
    lim := g.limits->cls;
    budget := least(
      coalesce((lim->>'minute')::int, 0) - public.send_used(cls, interval '1 minute'),
      coalesce((lim->>'hour')::int, 0) - public.send_used(cls, interval '1 hour')
    );
    continue when budget <= 0;

    return query
      with claimed as (
        update send_queue q
           set status = 'sending', claimed_at = now()
         where q.id in (
           select s.id
             from send_queue s
            where ((s.status = 'pending' and s.next_attempt_at <= now())
                or (s.status = 'sending' and s.claimed_at < now() - interval '5 minutes'))
              and public.send_class(s) = cls
              -- A contact who already got their hourly share waits; a reply under a public
              -- comment is not a message to them.
              and (s.send_type = 'public_reply' or (
                select count(*)
                  from send_queue x
                 where x.contact_id = s.contact_id
                   and x.send_type <> 'public_reply'
                   and x.status in ('sent', 'sending', 'failed')
                   and coalesce(x.sent_at, x.claimed_at) >= now() - interval '1 hour'
              ) < per_contact)
            order by s.created_at
            limit budget
            for update skip locked
         )
        returning q.*
      )
      select * from claimed;
  end loop;
end $$;

-- The old claim had no limits. Nothing calls it any more.
drop function if exists public.claim_send_queue(int);

-- Breaker: stop every send for p_minutes. Never shortens a pause already running.
create or replace function public.pause_sending(p_minutes int, p_reason text)
returns void
language sql
security definer
set search_path = public
as $$
  update send_guard
     set paused_until = greatest(coalesce(paused_until, now()), now() + make_interval(mins => p_minutes)),
         pause_reason = p_reason,
         updated_at = now()
   where id = 1;
$$;

-- ---- 4. viral switch -------------------------------------------------------------------------------
create or replace function public.send_guard_tick()
returns send_guard
language plpgsql
security definer
set search_path = public
as $$
declare
  g        send_guard;
  comments int;
begin
  select * into g from send_guard where id = 1 for update;

  -- Every comment that started an automation queued exactly one private reply.
  select count(*) into comments
    from send_queue
   where send_type = 'private_reply'
     and created_at >= now() - interval '1 hour';

  if comments > coalesce((g.limits->>'viral_comments_hour')::int, 40)
     and (g.public_paused_until is null or g.public_paused_until < now()) then
    update send_guard
       set public_paused_until = now() + make_interval(hours => coalesce((g.limits->>'viral_pause_hours')::int, 24)),
           public_pause_reason = format('%s comments started automations in one hour', comments),
           updated_at = now()
     where id = 1
    returning * into g;
  end if;

  if g.public_paused_until is not null and g.public_paused_until > now() then
    update send_queue
       set status = 'expired',
           error = 'Skipped: replies under comments are paused (' || coalesce(g.public_pause_reason, 'safety') || ')'
     where send_type = 'public_reply'
       and status = 'pending';
  end if;

  return g;
end $$;

-- ---- panel view ------------------------------------------------------------------------------------
create index if not exists webhook_event_received_idx on webhook_event (received_at desc);

create or replace function public.sending_health()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'paused_until',        case when g.paused_until > now() then g.paused_until end,
    'pause_reason',        case when g.paused_until > now() then g.pause_reason end,
    'public_paused_until', case when g.public_paused_until > now() then g.public_paused_until end,
    'public_pause_reason', case when g.public_paused_until > now() then g.public_pause_reason end,
    'limits',              g.limits,
    'last_event_at',       (select max(received_at) from webhook_event),
    'sent_last_hour',      (select count(*) from send_queue
                             where status = 'sent' and sent_at >= now() - interval '1 hour')
  )
  from send_guard g
  where g.id = 1
$$;

revoke all on function public.send_used(text, interval) from public, anon, authenticated;
revoke all on function public.claim_send_batch() from public, anon, authenticated;
revoke all on function public.pause_sending(int, text) from public, anon, authenticated;
revoke all on function public.send_guard_tick() from public, anon, authenticated;
revoke all on function public.sending_health() from public, anon, authenticated;
grant execute on function public.sending_health() to authenticated;
-- Login is paused (migration 19): the panel runs as anon. relock-login.sql revokes this.
grant execute on function public.sending_health() to anon;

-- ---- 5. webhook dedupe -------------------------------------------------------------------------------
create table if not exists seen_item (
  key     text primary key,   -- m:<message mid> or c:<field>:<comment id>
  seen_at timestamptz not null default now()
);
alter table seen_item enable row level security;

do $$ begin
  perform cron.unschedule('seen-item-cleanup');
exception when others then null; end $$;

-- Meta retries for hours, not weeks; two weeks of keys is plenty.
select cron.schedule(
  'seen-item-cleanup', '17 4 * * *',
  $cron$ delete from public.seen_item where seen_at < now() - interval '14 days' $cron$
);
