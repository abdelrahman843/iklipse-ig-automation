-- Workflow templates as data (NEW-WORKFLOW-BUILDER-PROMPT, Part D).
--
-- The "New Workflow" modal renders whatever rows live here — it has no per-template code. Adding
-- a template is one INSERT; the "By goal" / "By trigger" filters derive from these rows plus the
-- trigger registry. A template is never mutated: picking one DEEP-CLONES its trigger + graph into
-- a fresh draft flow.
--
-- Also: a "start from scratch" draft is created with NO trigger yet, so drop the NOT NULL on
-- flow.trigger_type. The engine only ever reads LIVE flows, and a flow cannot go live until a
-- trigger is chosen and the graph validates, so a null here is only ever a draft-in-progress.

alter table flow alter column trigger_type drop not null;

create table if not exists flow_template (
  id             text primary key,                    -- stable slug, e.g. 'auto-dm-links'
  name           text not null,
  description    text not null default '',
  goal           text not null,                       -- grow_followers | engage | drive_traffic
  trigger_type   text not null,
  badge          text,                                -- e.g. 'POPULAR', or null
  recommended    boolean not null default false,
  sort           int not null default 100,
  trigger_config jsonb not null default '{}'::jsonb,
  graph          jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now()
);

alter table flow_template enable row level security;
drop policy if exists flow_template_anon_read on flow_template;
create policy flow_template_anon_read on flow_template for select to anon using (true);
drop policy if exists flow_template_auth_read on flow_template;
create policy flow_template_auth_read on flow_template for select to authenticated using (true);

-- Seed the starter templates. Positions are omitted on purpose: the editor auto-lays-out any
-- position-less graph into a readable tree the first time it opens.
insert into flow_template (id, name, description, goal, trigger_type, badge, recommended, sort, trigger_config, graph)
values
  (
    'auto-dm-links',
    'Auto-DM links from comments',
    'Someone comments, you slide the link into their DMs automatically.',
    'drive_traffic',
    'comment',
    'POPULAR',
    true,
    10,
    '{"keywords":["link"],"match":"contains"}'::jsonb,
    '{
      "start":"n1",
      "nodes":{
        "n1":{"type":"send_message","title":"Offer the link","content":{"text":"Thanks for your comment! Want the link?","buttons":[{"title":"Send me the link","payload":"LINK"}]},"next":"n2"},
        "n2":{"type":"send_message","title":"Send the link","content":{"text":"Here you go: https://example.com"},"next":"n3"},
        "n3":{"type":"end"}
      }
    }'::jsonb
  ),
  (
    'grow-followers-comments',
    'Grow followers from comments',
    'Gate the reward behind a follow: reply, check the follow, then deliver.',
    'grow_followers',
    'comment',
    null,
    true,
    20,
    '{"keywords":["link"],"match":"contains"}'::jsonb,
    '{
      "start":"n1",
      "nodes":{
        "n1":{"type":"send_message","title":"Ask them to reply","content":{"text":"Thanks for commenting! Want it? Tap below.","buttons":[{"title":"I want it","payload":"WANT"}]},"next":"n2"},
        "n2":{"type":"wait_reply","title":"Wait for their reply","saveTo":"user_reply","timeoutSeconds":3600,"next":"n3","onTimeout":"n6"},
        "n3":{"type":"check_follow","title":"Do they follow?","onTrue":"n5","onFalse":"n4"},
        "n4":{"type":"send_message","title":"Ask for a follow","content":{"text":"Follow the account first, then reply DONE and I''ll send it."},"next":"n2"},
        "n5":{"type":"send_message","title":"Deliver","content":{"text":"You''re in! Here you go: https://example.com"},"next":"n6"},
        "n6":{"type":"end"}
      }
    }'::jsonb
  ),
  (
    'leads-from-stories',
    'Generate leads with stories',
    'A story reply starts a chat that collects an email for your list.',
    'engage',
    'story_reply',
    null,
    true,
    30,
    '{"keywords":[],"match":"contains"}'::jsonb,
    '{
      "start":"n1",
      "nodes":{
        "n1":{"type":"send_message","title":"Offer the guide","content":{"text":"Love that you replied! Want our free guide?","buttons":[{"title":"Yes please","payload":"YES"}]},"next":"n2"},
        "n2":{"type":"collect","title":"Ask for email","inputType":"email","promptText":"Great! What email should I send it to?","saveTo":"email","quickReplies":[],"retryMessage":"That doesn''t look like an email. Try again?","maxAttempts":3,"timeoutSeconds":3600,"skipEnabled":false,"skipTitle":"Skip","next":"n3","onTimeout":"n4","onFailed":"n4"},
        "n3":{"type":"send_message","title":"Confirm","content":{"text":"Thanks! Check your inbox in a minute."},"next":"n4"},
        "n4":{"type":"end"}
      }
    }'::jsonb
  ),
  (
    'respond-all-dms',
    'Respond to all your DMs',
    'A catch-all reply so no direct message goes unanswered.',
    'engage',
    'default_reply',
    null,
    false,
    40,
    '{"excludeStoryReplies":true}'::jsonb,
    '{
      "start":"n1",
      "nodes":{
        "n1":{"type":"send_message","title":"Auto-reply","content":{"text":"Thanks for your message! We''ll get back to you soon. Meanwhile:","buttons":[{"title":"Visit our site","url":"https://example.com"}]},"next":"n2"},
        "n2":{"type":"end"}
      }
    }'::jsonb
  ),
  (
    'keyword-auto-reply',
    'Auto-reply to keyword in DM',
    'Watch DMs for a keyword like "price" and answer instantly.',
    'drive_traffic',
    'keyword',
    null,
    false,
    50,
    '{"keywords":["price","pricing"],"match":"contains"}'::jsonb,
    '{
      "start":"n1",
      "nodes":{
        "n1":{"type":"send_message","title":"Answer","content":{"text":"Here are our plans and pricing:","buttons":[{"title":"See plans","url":"https://example.com/pricing"}]},"next":"n2"},
        "n2":{"type":"end"}
      }
    }'::jsonb
  )
on conflict (id) do update set
  name = excluded.name,
  description = excluded.description,
  goal = excluded.goal,
  trigger_type = excluded.trigger_type,
  badge = excluded.badge,
  recommended = excluded.recommended,
  sort = excluded.sort,
  trigger_config = excluded.trigger_config,
  graph = excluded.graph;
