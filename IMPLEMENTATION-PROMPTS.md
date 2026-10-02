# Implementation Prompts — Post-MVP Features

Five ready-to-paste prompts for a coding agent, one per roadmap task, in build order.

**How to use these**

1. Paste **Shared Context** first, then **one** task prompt. Never more than one at a time.
2. Do Task 1 before anything else — it is an architecture test as much as a feature.
3. Every prompt ends with acceptance criteria. Do not move on until they pass against a real
   Instagram account, not Meta's test tool.

---

## Shared Context

> Paste this block above whichever task prompt you are running.

```
You are working on an Instagram DM automation platform. The MVP is built and the reference
flow works end to end: a comment triggers a private reply, the user replies, we verify they
follow the account, and we send them a link.

ARCHITECTURE
- Frontend: React + Vite. It is a control panel only; it never talks to Meta.
- Backend: Supabase Edge Functions (Deno/TypeScript). No other server exists.
- Database: Supabase Postgres. Migrations live in the repo via Flyway-style SQL files.
- Storage: Supabase Storage, for outbound images that Meta fetches by public URL.
- Scheduler: pg_cron runs the workers every minute.

COMPONENTS
- ig-webhook       Edge Function. Verifies Meta's X-Hub-Signature-256, persists the raw event
                   to webhook_event, returns 200. It does NO other work, ever.
- process-events   Edge Function. Reads unprocessed webhook_event rows, upserts the contact,
                   matches a trigger, opens a flow_run, and executes the graph.
- send-worker      Edge Function. Drains send_queue within Meta's rate limits, with
                   exponential backoff retries.

TABLES
ig_account, contact, flow, flow_run, message, webhook_event, send_queue, media_asset

The flow graph is a single JSONB document on flow.graph, shaped as:
{ "start": "n1", "nodes": { "n1": { "type": "...", ...,  "next": "n2" } } }

Existing node types: send_message, wait_reply, check_follow, condition, delay, end.
Nodes that pause a run set flow_run.status to waiting_input or waiting_delay.

PLATFORM RULES THAT ARE NOT NEGOTIABLE
- The 24-hour window: automated messages are only allowed within 24h of
  contact.last_interaction_at. Outside it, automation must stop, not fail silently.
- Between 24h and 7 days, only a human agent may reply, and that message must carry the
  HUMAN_AGENT tag. Automated messages may never use that tag.
- A private reply to a comment is exactly ONE message and does NOT open the 24-hour window.
  The window opens when the contact replies or taps a button. A button that opens an
  external website does not count as opting in.
- Private replies on posts and reels: 750 per hour per account. This is the binding limit.
- Instagram contacts have no first or last name. Only a username.
- Never store inbound media. Keep the CDN URL only. This does not apply to our own
  outbound assets.
- The Instagram access token lives in Edge Function secrets and must never reach the client.
```

---

## Task 1 — Remaining Triggers

> **This is an architecture test.** If adding a trigger requires editing the execution
> engine, the abstraction is wrong. Stop and fix it before adding the rest.

```
GOAL
Add seven new trigger types without modifying the execution engine.

Refactor trigger handling into a registry first. Each trigger contributes only:
  - a matcher:   (webhook_event) -> { matches: boolean, contactRef, triggerContext }
  - a config schema for the UI
  - an entry in the registry
The engine keeps executing graphs exactly as it does now.

TRIGGERS TO ADD
1. story_reply     User replies to our story, by text or emoji reaction.
                   Arrives on the `messages` webhook with reply_to.story populated.
                   Not story likes and not story comments.
2. story_mention   User @mentions us in THEIR story.
                   Arrives on `messages` with a story_mention attachment — NOT on the
                   `mentions` field. Only fires when the mentioning profile is public.
3. share_to_dm     User reshares our post or reel to their story. Arrives on `messages`.
4. live_comment    Comment during an active live broadcast, via `live_comments`.
5. default_reply   Fallback when an inbound DM matches no other trigger.
                   Must be scopeable to exclude story replies.
6. ref_url         Click on an ig.me link carrying a ?ref= parameter.
7. Config surfaces: Ice Breakers and Persistent Menu, written via the Messenger Profile API.

TRIGGER-SPECIFIC CONSTRAINTS
- live_comment: the private reply is valid ONLY while the broadcast is live. Do not retry
  after it ends — mark those queue rows `expired`. Fires once per user per session.
- ref_url: the referral arrives on a DIFFERENT webhook field depending on thread state.
  New thread + ice breaker tap -> messaging_postbacks
  New thread + typed message  -> messages
  Existing thread             -> messaging_referral
  Subscribe to all three and handle the ref in each. Ref URLs work on the Instagram mobile
  app only, never on web. The ref value is max 2083 chars, alphanumeric plus - _ = only.
- Ice Breakers: maximum 4 questions. Requires a `default` locale.
- Persistent Menu: `postback` and `web_url` button types only. No nested submenus on
  Instagram. No composer_input_disabled.
- The Messenger Profile API is limited to 10 calls per 10 minutes — queue these writes,
  do not call it on every UI save.
- Existing comment trigger behaviour to preserve: it fires only on a user's FIRST comment
  on a given post. Do not "fix" this; it is Meta's behaviour.

ALSO
Parse the ref value into contact.custom_fields so campaign attribution is queryable.

ACCEPTANCE CRITERIA
- All seven triggers fire against a real account.
- Adding a hypothetical eighth trigger requires only a new matcher file plus one registry
  entry — zero changes to process-events or the node executor. Demonstrate this.
- A live-comment reply queued after the broadcast ends is marked expired, not retried.
- A ref value from an ig.me click lands in custom_fields.

OUT OF SCOPE
Instagram Ads trigger — it requires the Facebook Login integration path, which we do not
have yet. Do not start it.
```

---

## Task 2 — Data Collection Nodes

> The highest-value item on the roadmap. This is what turns a reply bot into a lead tool.

```
GOAL
Extend wait_reply into a typed, validated data collection node.

NODE SHAPE
{
  "type": "collect",
  "inputType": "email" | "phone" | "text" | "number" | "url" | "choice",
  "prompt": { "text": "...", "quickReplies": [...] },
  "saveTo": "email",                  // system field or custom field key
  "validation": { "retryMessage": "...", "maxAttempts": 3 },
  "timeoutSeconds": 3600,
  "skipButton": { "enabled": true, "title": "Skip" },
  "next": "n5",
  "onTimeout": "n9",
  "onFailed": "n9"
}

VALIDATION RULES
- email:  format check. On success optionally set an email opt-in flag with a timestamp,
          for consent tracking.
- phone:  validate shape including country code, then store digits only. Store phone values
          as text — a numeric column rejects the leading +.
- number: numeric only.
- url:    well-formed http(s).
- choice: must match one of the offered quick replies.

BEHAVIOUR
- On invalid input, send retryMessage and stay on the same node. After maxAttempts, follow
  onFailed.
- On timeout, follow onTimeout.
- Persist collected values to contact.custom_fields, typed. Register the key in a
  custom_field definitions table so the UI can list and filter on them.
- Every attempt still passes through the 24-hour window check before sending.

INSTAGRAM CONSTRAINTS
- Quick replies: maximum 13 per message, 20 characters each. The skip button counts toward
  that budget, so 12 options plus skip.
- Message text: 1000 bytes UTF-8, and 640 characters when the message carries buttons.
- Maximum 3 buttons per message on Instagram.
- Input prefills do not render on Instagram. Never rely on them.
- There is no first/last name from Instagram. If a flow wants a name, it must ask for it.

UI
Add the collect node to the flow editor, with a field picker that creates a new custom field
inline. Show collected values on the contact record.

ACCEPTANCE CRITERIA
- A flow collects an email and a phone number, rejects malformed input with a retry, and
  gives up cleanly after maxAttempts.
- Values appear on the contact and are filterable.
- A flow whose collect node has 13 quick replies plus a skip button is rejected at save time
  with a clear message, not at send time.
```

---

## Task 3 — Inbox

> Not a convenience feature. It is the only lawful way to message anyone after 24 hours.

```
GOAL
Build a conversation inbox with human takeover.

FEATURES
- Conversation list: contact username, last message preview, unread state, window state.
- Thread view: full message history from our `message` table, newest last.
- Composer: a human agent sends a reply.
- Assignment: assign a conversation to a team member; filter by assignee and by unassigned.
- Internal notes on a conversation, not sent to the contact.
- Search by username.

WINDOW HANDLING — THE CORE OF THIS TASK
Compute a window state per conversation from contact.last_interaction_at and surface it
prominently in the UI:
  OPEN         under 24h  -> automation and human replies both allowed
  HUMAN_ONLY   24h to 7d  -> human replies only, sent with the HUMAN_AGENT tag
  CLOSED       over 7d    -> nothing can be sent; disable the composer and say why

Rules:
- Messages sent from the inbox by a human are tagged HUMAN_AGENT.
- Automated messages must NEVER carry that tag. Enforce this in the send path itself, not
  only in the UI, so a future bug cannot violate it.
- In CLOSED state the composer is disabled with an explanation, not a silent failure.

AUTOMATION PAUSE
When an agent sends a message, pause automation for that contact for 30 minutes
(configurable). Store pause_until on the contact and have the engine respect it.

DELIVERY
Poll a Supabase Edge Function every few seconds for new messages. Do not connect the
frontend directly to Supabase Realtime — keep all Meta-facing logic server-side.

ACCEPTANCE CRITERIA
- An agent replies to a conversation that is 3 days old and it delivers, tagged HUMAN_AGENT.
- An automated flow attempting to send at 3 days is blocked and the run is marked
  blocked_window.
- A conversation older than 7 days shows a disabled composer with a reason.
- After an agent replies, an in-flight automation for that contact does not send for 30 min.
```

---

## Task 4 — Connect Screen and Authentication

> The gate before any real customer. Not a sellable feature, but nothing ships without it.

```
GOAL
Replace the hand-pasted token with a real OAuth connect flow, and add user accounts.

INSTAGRAM OAUTH — Instagram Login path
Scopes: instagram_business_basic, instagram_business_manage_messages,
        instagram_business_manage_comments
Flow:
1. Redirect the user to Meta's authorization dialog.
2. Exchange the code for a short-lived token server-side, in an Edge Function.
3. Exchange that for a long-lived token and store it encrypted, server-side only.
4. Schedule refresh before expiry via pg_cron. Alert on refresh failure.
5. Store ig_user_id and username on ig_account.

The token must never be returned to the client in any API response. Audit for this.

CONNECT UX
- A connect screen showing status: connected, needs reconnection, or disconnected.
- A preflight check that warns if "Allow access to messages" is disabled in the Instagram
  app. This setting silently breaks everything and users will not find it themselves.
  Detect the failure mode and show a step-by-step fix.
- A disconnect action that revokes and clears the stored token.

AUTHENTICATION
Use Supabase Auth: email and password, plus password reset.

TURN ON ROW LEVEL SECURITY
RLS was off for the MVP. Enable it on every table now:
- Each row is owned by a user (later a workspace — see Task 5).
- Frontend uses the anon key and reads only its own rows.
- Edge Functions use the service role key and remain the only path to Meta.
Write an explicit test proving user A cannot read user B's contacts, flows, or messages.

ACCEPTANCE CRITERIA
- A brand-new user signs up, connects an Instagram account via OAuth, and runs a flow.
- No API response anywhere contains the access token. Verified by grepping network traffic.
- The RLS isolation test passes.
- Disabling "Allow access to messages" produces a clear diagnostic, not silence.
```

---

## Task 5 — Multi-Account Workspaces

> The competitive differentiator. ManyChat charges a separate subscription per Instagram
> account; an agency with ten clients pays ten times. Get this right and it becomes the
> reason people switch.

```
GOAL
One login, one subscription, many Instagram accounts.

DATA MODEL
  workspace          id, name, created_at
  workspace_member   workspace_id, user_id, role (owner | admin | editor | agent)
  ig_account         add workspace_id  -- many accounts per workspace

Add workspace_id to: contact, flow, flow_run, message, send_queue, media_asset,
webhook_event. Backfill existing rows into a default workspace as part of the migration.

SCOPING
- Every query filters by workspace_id AND by ig_account_id where relevant.
- RLS policies key off workspace membership, not user id.
- Inbound webhooks resolve to an account via ig_user_id, then to its workspace. Never
  assume a single account anywhere in the codebase.

UI
- Account switcher in the header; the whole app scopes to the selected account.
- Workspace-level view: all accounts with basic health per account — connected state, token
  expiry, messages sent today, rate-limit headroom.
- Copy a flow from one account to another within a workspace. This is the agency workflow:
  build once, deploy to every client.

ROLES
  owner   billing, members, everything
  admin   everything except billing
  editor  build and edit flows, no member management
  agent   inbox only, cannot edit flows

RATE LIMITS ARE PER ACCOUNT
Meta's 750 private replies per hour is per Instagram account, not per workspace. The
send-worker's hourly counter must be keyed by ig_account_id. Verify this explicitly — a
workspace-level counter would throttle every client whenever one goes viral.

ACCEPTANCE CRITERIA
- One login manages three Instagram accounts and switches between them.
- A flow copied to a second account runs there with its own triggers and contacts.
- Isolation test: workspace A cannot read any row belonging to workspace B.
- Rate-limit test: saturating account A's hourly cap does not slow sending on account B.
```

---

## Sequencing note

Tasks 1 and 2 are worth roughly two weeks together and make the product genuinely sellable.
Task 3 unlocks the 7-day window and is required before any customer runs this on real
traffic. Tasks 4 and 5 are the gate to onboarding anyone but you.

Start Meta's App Review, Business Verification and Tech Provider verification **now**, in
parallel with Task 1. They consume calendar time rather than engineering time, and they
cannot be compressed later.
