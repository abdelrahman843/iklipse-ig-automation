# Instagram Automation MVP — Build Plan

A working end-to-end slice: no authentication, no server you operate. All runtime lives in
Supabase; the frontend is a control panel only.

**Stack:** React + Vite · Supabase Postgres · Supabase Edge Functions · Supabase Storage ·
`pg_cron` · Instagram Graph API v26.0

---

## 1. Architecture

Five pieces. Each has exactly one job.

```
Meta  ──►  ig-webhook  ──►  webhook_event  ──►  process-events  ──►  send_queue  ──►  send-worker  ──►  Meta
           (verify +        (raw log)           (match trigger,      (outbound)      (rate-limited,
            persist +                            run the graph)                       retries)
            200 OK)
```

| Component | Type | Responsibility |
|---|---|---|
| `ig-webhook` | Edge Function | Verify Meta's signature, persist the raw event, return `200`. Nothing else. |
| `webhook_event` | Table | Raw event log. Lets you replay and fix without waiting for new traffic. |
| `process-events` | Edge Function | Match trigger → open a run → execute nodes. |
| `send_queue` | Table | Every outbound message lands here first. |
| `send-worker` | Edge Function | Drains the queue within Meta's limits, retries on failure. |
| `pg_cron` | Scheduler | Runs `process-events` and `send-worker` every minute. |

### The rule that cannot be broken

**`ig-webhook` must not execute flows or send messages.** Persist and return `200`
immediately. If you do work before responding, Meta treats you as slow, starts retrying, and
after repeated failures will disable webhook delivery for your account entirely.

### Token handling

The Instagram access token does **not** go in any table the frontend can reach. Put it in
Edge Function secrets so only server-side code sees it. Anyone holding that token can send
DMs as the business — it is the single most sensitive thing in the project.

---

## 2. Database schema

```sql
-- the connected Instagram account (one row for the MVP; token lives in secrets, not here)
create table ig_account (
  id           uuid primary key default gen_random_uuid(),
  ig_user_id   text not null unique,
  username     text,
  connected_at timestamptz not null default now()
);

-- one row per Instagram user who has interacted with us
create table contact (
  id                  uuid primary key default gen_random_uuid(),
  igsid               text not null unique,          -- Instagram-scoped user id
  username            text,                          -- Instagram gives no first/last name
  follows_account     boolean,
  follows_checked_at  timestamptz,
  last_interaction_at timestamptz,                   -- drives the 24-hour window
  custom_fields       jsonb not null default '{}'::jsonb,
  created_at          timestamptz not null default now()
);
create index on contact (last_interaction_at);

-- an automation definition; the whole node graph is one JSONB document
create table flow (
  id             uuid primary key default gen_random_uuid(),
  name           text not null,
  status         text not null default 'draft',      -- draft | live
  trigger_type   text not null,                      -- comment | keyword | story_reply | ...
  trigger_config jsonb not null default '{}'::jsonb, -- post id, keywords, match rules
  graph          jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index on flow (status, trigger_type);

-- one execution session of one flow for one contact
create table flow_run (
  id              uuid primary key default gen_random_uuid(),
  flow_id         uuid not null references flow(id) on delete cascade,
  contact_id      uuid not null references contact(id) on delete cascade,
  current_node_id text,
  state           jsonb not null default '{}'::jsonb, -- variables collected during the run
  status          text not null default 'running',
  -- running | waiting_input | waiting_delay | done | failed | blocked_window
  resume_at       timestamptz,                        -- set by delay nodes
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index on flow_run (status, resume_at);
create index on flow_run (contact_id, status);

-- your own message archive; Meta will not give this history back
create table message (
  id              uuid primary key default gen_random_uuid(),
  contact_id      uuid not null references contact(id) on delete cascade,
  direction       text not null,                      -- in | out
  payload         jsonb not null,
  meta_message_id text,
  flow_run_id     uuid references flow_run(id) on delete set null,
  created_at      timestamptz not null default now()
);
create index on message (contact_id, created_at desc);

-- raw inbound webhooks, logged before any processing
create table webhook_event (
  id           uuid primary key default gen_random_uuid(),
  raw          jsonb not null,
  event_type   text,
  processed_at timestamptz,
  error        text,
  received_at  timestamptz not null default now()
);
create index on webhook_event (processed_at) where processed_at is null;

-- every outbound message, so rate limits are enforced in one place
create table send_queue (
  id              uuid primary key default gen_random_uuid(),
  contact_id      uuid not null references contact(id) on delete cascade,
  flow_run_id     uuid references flow_run(id) on delete set null,
  send_type       text not null,                      -- private_reply | dm
  comment_id      text,                               -- required for private_reply
  payload         jsonb not null,
  status          text not null default 'pending',    -- pending | sent | failed | expired
  attempts        int  not null default 0,
  next_attempt_at timestamptz not null default now(),
  expires_at      timestamptz,                        -- private replies: comment time + 7 days
  error           text,
  created_at      timestamptz not null default now()
);
create index on send_queue (status, next_attempt_at);

-- images a flow sends; Meta fetches these from a public URL
create table media_asset (
  id           uuid primary key default gen_random_uuid(),
  storage_path text not null,
  public_url   text not null,
  created_at   timestamptz not null default now()
);
```

### Two decisions that will save you weeks

**Store the flow graph as JSONB, not normalized tables.** You will be reshaping node types
constantly during the MVP. A schema migration per node-type change will kill your velocity.

**`last_interaction_at` is a stored column, not a computed value.** Update it on every
inbound event. Every send decision reads it.

---

## 3. Flow graph format

```json
{
  "start": "n1",
  "nodes": {
    "n1": {
      "type": "send_message",
      "content": { "text": "Hey! Want the link?", "buttons": [{ "title": "Yes", "payload": "YES" }] },
      "next": "n2"
    },
    "n2": {
      "type": "wait_reply",
      "saveTo": "user_reply",
      "timeoutSeconds": 3600,
      "next": "n3",
      "onTimeout": "n6"
    },
    "n3": { "type": "check_follow", "onTrue": "n5", "onFalse": "n4" },
    "n4": {
      "type": "send_message",
      "content": { "text": "Follow us first, then reply DONE" },
      "next": "n2"
    },
    "n5": { "type": "send_message", "content": { "text": "Here you go: https://..." }, "next": "n6" },
    "n6": { "type": "end" }
  }
}
```

### Node types (six is enough for the MVP)

| Type | Behaviour | Pauses the run? |
|---|---|---|
| `send_message` | Enqueue a message, continue | No |
| `wait_reply` | Wait for the contact's reply, save it to a variable | **Yes** → `waiting_input` |
| `check_follow` | Ask Meta whether the contact follows the account, then branch | No |
| `condition` | Branch on a value in `state` or a field on the contact | No |
| `delay` | Set `resume_at` and stop | **Yes** → `waiting_delay` |
| `end` | Close the run | Terminal |

---

## 4. Execution engine

One loop. Resist making it clever.

1. Load the run, read `current_node_id`.
2. Execute the node by type.
3. If the node does not pause, move to the next and repeat.
4. If it pauses, persist status (and `resume_at`) and exit.
5. On `end`, close the run.

### Check the window before every send

Has it been under 24 hours since `last_interaction_at`? If not, do not send — mark the run
`blocked_window` and stop. A delay that pushes past the window means the message silently
goes nowhere with no error. Have the engine reject that case up front rather than discovering
it in testing.

### The first reply to a comment is a special case

A private reply to a comment is **exactly one message**, and it does **not** open the
24-hour window. The window opens only when the contact replies or taps a button — and a
button that opens an external website does not count. So the first message must contain a
button or a question, never just the link.

---

## 5. Sending and rate limits

| Operation | Meta limit | What it means for you |
|---|---|---|
| Private reply (posts & reels) | **750 / hour** per account | Your binding constraint. Keep an hourly counter and stop draining the queue when it is hit. |
| Send API — text & links | 100 / second | Will not constrain you. |
| Send API — audio & video | 10 / second | Same queue is fine. |
| Private reply window | 7 days from the comment | Expire anything that sits in the queue longer. |
| Private reply on a live comment | during the broadcast only | No retry after the stream ends. |

`send-worker` runs every minute, takes a small batch, and on failure increments `attempts`
and pushes `next_attempt_at` out with exponential backoff.

---

## 6. Reference flow — build this first

**Comment → private reply → follow check → send link**

Someone comments a keyword on a post. They get a private reply with a button. When they tap
it or reply, the window opens, so we ask Meta whether they follow the account. If they do,
send the link. If not, ask them to follow and reply `DONE`, then check again.

This single path exercises every component: webhook receipt, persistence, trigger matching,
the engine, private replies, the 24-hour window, follow verification, the queue, and rate
limiting. Once it works, every other trigger is configuration rather than new architecture.

---

## 7. Task plan

Roughly two and a half weeks for one focused person. Estimates are approximate; Phase 2 is
the longest and the one whose design will shift most while you build it.

### Phase 0 — Setup (1 day)

- [ ] Create the Supabase project; note the keys and pick the region closest to Meta
- [ ] Apply all eight tables as migration files in the repo (not via the dashboard)
- [ ] Create a test Instagram **professional** account
- [ ] Enable **Allow access to messages** in Instagram settings
- [ ] Create the Meta developer app with messaging + comments permissions
- [ ] Store the Instagram token in Edge Function secrets

### Phase 1 — Ingest (1.5 days)

- [ ] `ig-webhook`: handle Meta's `GET` verification challenge
- [ ] Verify the `X-Hub-Signature-256` header on every `POST`
- [ ] Persist the raw event and return `200` with zero processing
- [ ] Subscribe to the `messages` and `comments` webhook fields
- [ ] Trigger a real event and confirm it lands in `webhook_event`

### Phase 2 — Engine (3 days)

- [ ] `process-events` worker: read unprocessed rows, mark them when done
- [ ] Upsert the contact and refresh `last_interaction_at`
- [ ] Trigger matching for comments and keywords only
- [ ] Open a `flow_run`
- [ ] Execution loop covering all six node types
- [ ] Window check before every send
- [ ] `check_follow` via the User Profile API, caching the result and its timestamp

### Phase 3 — Sending (2 days)

- [ ] `send-worker` handling both private replies and normal DMs
- [ ] Hourly counter enforcing the 750/hour private-reply cap
- [ ] Exponential backoff retries, and expiry for stale rows
- [ ] `pg_cron` job every minute for the queue and due delays
- [ ] Log every outbound message to `message`

### Phase 4 — Frontend (4 days)

- [ ] React + Vite project wired to Supabase
- [ ] Flow list screen: create, activate, deactivate
- [ ] Flow editor — **start with a vertical step list, not a drag-and-drop canvas**; same
      result in a quarter of the time
- [ ] Trigger configuration: pick the post, set keywords
- [ ] Conversation view (read-only for now)
- [ ] Image upload returning a public URL

### Phase 5 — End-to-end testing (2 days)

- [ ] Run the reference flow start to finish
- [ ] Test from a second real account, not Meta's test tool
- [ ] Test both branches: a follower and a non-follower
- [ ] Test outside the window and confirm it fails legibly, not silently
- [ ] Fire many comments at once and confirm the queue holds

---

## 8. Out of scope

Written down so it does not get reopened.

| Item | Reason |
|---|---|
| Authentication and accounts | Deliberate. One account for now. |
| Instagram connect screen | Pasting the token by hand is far faster for this build. |
| The other seven triggers | Configuration, not architecture. Add them later. |
| Tags and segments | Not needed to prove the concept. |
| AI features | After the engine is stable. |
| Analytics | Simple counters are enough for now. |
| Sequences / drip campaigns | **Blocked** — cannot work on Instagram past the 24-hour window. |
| Broadcasts | **Blocked** — Meta does not offer this on Instagram. |
| Follow-to-DM (new follower trigger) | **Blocked** — requires a private arrangement with Meta. |

---

## 9. Gotchas

The specific things that trip people up on this project.

- **"Allow access to messages" in Instagram.** If it is off, the connection succeeds and
  automations never fire, with no error anywhere. This is the single biggest time-waster.
- **Responding slowly to webhooks.** Causes retries, then delivery gets disabled for your
  account.
- **A delay that crosses the 24-hour window.** The message vanishes with no error. Reject it
  in the engine.
- **Comment triggers fire once per user per post.** Retesting with the same account on the
  same post does nothing — you will think you have a bug.
- **Follow checks fail before the contact has messaged you.** Meta returns an error. The
  check must come *after* their first reply, never before.
- **Instagram contacts have no name**, only a username. Design the schema accordingly.
- **Do not store inbound media.** Meta's policy allows keeping the CDN URL only. This does
  not apply to your own outbound assets.

---

*Based on official Meta and ManyChat documentation, researched August 2026. Meta changes
limits and messaging policy frequently — re-verify the rate limits and window rules before
committing architecture to them.*
