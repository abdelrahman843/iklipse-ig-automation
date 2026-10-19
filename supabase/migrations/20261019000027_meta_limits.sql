-- Send limits at Meta's published numbers, 5% under.
--
-- Meta's rate limits (developers.facebook.com/docs/graph-api/overview/rate-limiting, Instagram):
--   Send API          100 calls a second per account (text, links, reactions, stickers)
--   Private Replies   750 calls an hour per account (comments on posts and reels)
--   Public replies    no fixed number: they fall under the business use case limit,
--                     4800 x impressions per 24 hours, which the worker already watches through
--                     Meta's usage headers (it stops at 80%).
-- So:
--   reactive, proactive   95 a second   -> 5700 a minute, 342000 an hour
--   private_reply         712 an hour, spread evenly: 12 a minute (750 / 60 = 12.5)
--   public_reply          one per commenter at most, so the same as private replies
--   per contact           Meta gives no number ("too many messages to a single thread"); kept at 25
--   viral switch          only once comments pass what Meta lets you answer in an hour
--   batch                 most rows one claim takes; the worker hands back what it can't send in time

alter table send_guard alter column limits set default '{
  "reactive":      {"minute": 5700, "hour": 342000},
  "private_reply": {"minute": 12,   "hour": 712},
  "public_reply":  {"minute": 12,   "hour": 712},
  "proactive":     {"minute": 5700, "hour": 342000},
  "per_contact_hour": 25,
  "viral_comments_hour": 712,
  "viral_pause_hours": 24,
  "batch": 100
}'::jsonb;

update send_guard
   set limits = '{
         "reactive":      {"minute": 5700, "hour": 342000},
         "private_reply": {"minute": 12,   "hour": 712},
         "public_reply":  {"minute": 12,   "hour": 712},
         "proactive":     {"minute": 5700, "hour": 342000},
         "per_contact_hour": 25,
         "viral_comments_hour": 712,
         "viral_pause_hours": 24,
         "batch": 100
       }'::jsonb,
       updated_at = now()
 where id = 1;

-- Same claim as migration 24, plus a cap on how many rows one claim takes across all classes.
-- With limits this high, a minute's budget is far more than one worker run can send.
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
  batch       int;
  taken       int := 0;
  got         int;
begin
  -- One claimer at a time: the budget check and the claim must not interleave.
  perform pg_advisory_xact_lock(hashtext('claim_send_batch'));

  select * into g from send_guard where id = 1;
  if g.paused_until is not null and g.paused_until > now() then
    return;
  end if;
  per_contact := coalesce((g.limits->>'per_contact_hour')::int, 25);
  batch := coalesce((g.limits->>'batch')::int, 100);

  foreach cls in array array['reactive', 'private_reply', 'public_reply', 'proactive'] loop
    continue when cls = 'public_reply'
              and g.public_paused_until is not null and g.public_paused_until > now();
    lim := g.limits->cls;
    budget := least(
      coalesce((lim->>'minute')::int, 0) - public.send_used(cls, interval '1 minute'),
      coalesce((lim->>'hour')::int, 0) - public.send_used(cls, interval '1 hour'),
      batch - taken
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
    get diagnostics got = row_count;
    taken := taken + got;
  end loop;
end $$;

revoke all on function public.claim_send_batch() from public, anon, authenticated;
