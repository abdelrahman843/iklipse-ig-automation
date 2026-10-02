# Trigger Prompts — One Per Workflow Type

A copy-paste prompt for every remaining ManyChat-style trigger, in build order. You already
have the **Post & Reel Comments** trigger; this covers the other ten.

## How to use

1. Paste the **Shared Context** block once, then **Task 0** (the registry refactor).
   Do not add a single new trigger until Task 0 is done.
2. After that, paste **one trigger prompt at a time**, on top of the Shared Context.
3. Each prompt ends with acceptance criteria. Test against a **real** Instagram account, not
   Meta's webhook test tool — the test tool does not reproduce most of these payloads.

---

## Shared Context

> Paste above every task below.

```
Instagram DM automation platform. The MVP works end to end: a comment triggers a private
reply, the user replies, we verify they follow the account, we send a link.

STACK
- Frontend: React + Vite. Control panel only; it never talks to Meta.
- Backend: Supabase Edge Functions (Deno/TypeScript). No other server.
- Database: Supabase Postgres, migrations in the repo. Storage: Supabase Storage.
- Scheduler: pg_cron runs the workers every minute.

COMPONENTS
- ig-webhook      Verifies X-Hub-Signature-256, persists raw event to webhook_event,
                  returns 200. Does NO other work.
- process-events  Reads unprocessed webhook_event rows, upserts contact, matches a trigger,
                  opens a flow_run, executes the graph.
- send-worker     Drains send_queue within Meta's limits, retries with backoff.

TABLES: ig_account, contact, flow, flow_run, message, webhook_event, send_queue, media_asset
GRAPH:  flow.graph is one JSONB doc: { "start": "n1", "nodes": { "n1": {...} } }
NODES:  send_message, wait_reply, check_follow, condition, delay, end

NON-NEGOTIABLE PLATFORM RULES
- 24-hour window: automated messages only within 24h of contact.last_interaction_at.
  Outside it, automation stops (mark the run blocked_window) — it must not fail silently.
- A private reply to a comment is exactly ONE message and does NOT open the 24h window.
  The window opens when the contact replies or taps a non-URL button.
- Private replies on posts/reels: 750 per hour per account. Binding limit.
- Instagram contacts have no first/last name, only a username.
- Never store inbound media; keep the CDN URL only. This does not apply to our own
  outbound assets.
- The access token lives in Edge Function secrets, never reaches the client.
```

---

## Task 0 — Trigger Registry (do this first)

> The whole point of the next ten prompts is that the engine never changes. Build the seam now.

```
GOAL
Refactor trigger handling into a registry so a new trigger is a new file, not an engine edit.

Each trigger contributes ONLY:
  - webhookFields:  string[]        // which webhook fields it needs subscribed
  - match(event):   { matched: boolean, igsid, username?, triggerContext }
  - configSchema:   for the flow editor
  - registryKey:    the trigger_type value stored on flow.trigger_type

process-events becomes: for each unprocessed event, ask every registered trigger whether it
matches; on a match, upsert the contact, refresh last_interaction_at, open a flow_run for the
matching live flow, and hand off to the UNCHANGED execution engine.

Keep the existing comment trigger working by moving it into this registry as the first entry.

ACCEPTANCE
- The comment trigger still works, now via the registry.
- Adding a no-op eighth trigger requires only a new file + one registry line, with zero edits
  to process-events' core loop or the node executor. Prove it with a throwaway trigger.
```

---

## Trigger 1 — Story Reply

```
GOAL
Fire a flow when a user replies to one of our stories (text or emoji reaction).

WEBHOOK
Arrives on the `messages` field with `reply_to.story` populated:
  message.reply_to.story = { id, url, link_sticker_url? }
This is a reply/reaction, NOT a story like and NOT a story comment.

CONFIG (configSchema)
- scope: "any_story" | "specific_story" (a specific story must be < 24h old)
- optional keyword rules on the reply text (reuse the comment trigger's matcher: is /
  contains / whole word / begins with / doesn't contain)
- optional: auto-react with a heart

MATCH
matched when a message has reply_to.story, the scope matches, and any keyword rule passes.
triggerContext carries the story id and the reply text.

NOTES
- A story reply DOES open the 24-hour window (unlike a comment private reply).
- Cannot target Highlights or Close Friends stories — only normal stories.
- link_sticker_url lets you branch on which link sticker the user tapped; expose it in
  triggerContext so a flow can route on it later.

ACCEPTANCE
- Replying to our story by text fires the flow; replying by emoji fires it too.
- A like on the story does NOT fire it.
- With scope=specific_story, replies to a different story do not fire.
```

---

## Trigger 2 — Story Mention

```
GOAL
Fire a flow when a user @mentions our account in THEIR story.

WEBHOOK
Arrives on `messages` with an attachment of type "story_mention":
  message.attachments[0] = { type: "story_mention", payload: { url: "<CDN_URL>" } }
IMPORTANT: this does NOT arrive on the `mentions` webhook field.

CONFIG
- frequency: "every_mention" | "once_per_24h_per_user"
- optional: auto-react with a heart

MATCH
matched when an inbound message carries a story_mention attachment.

HARD CONSTRAINTS
- Only fires when the mentioning profile is PUBLIC. Private accounts produce no event.
- Do NOT download or cache the story media. Store the CDN URL only, render on demand.
  The URL stops working once the story expires (24h) or is deleted.
- Opens the 24-hour window.

ACCEPTANCE
- A public account mentioning us in their story fires the flow.
- We store the CDN URL, never a copy of the media.
- With once_per_24h_per_user, a second mention within 24h does not re-fire.
```

---

## Trigger 3 — Share to DM

```
GOAL
Fire a flow when a user reshares our post or reel to their story.

WEBHOOK
Arrives on `messages` as a share of our own media back to us.

CONFIG
- scope: "specific_post" | "all_posts" | "next_post"

MATCH
matched when the inbound message is a share of media the account owns, within scope.

CONSTRAINTS
- Fires once per automation per user.
- Like a comment private reply, the first message does NOT open the 24h window — the window
  opens only when the user replies or taps a non-URL button. A button that opens an external
  website does not count as opt-in.
- Requires the newer Instagram connection.

ACCEPTANCE
- Resharing our reel to a story fires the flow once.
- A second reshare by the same user in the same automation does not re-fire.
```

---

## Trigger 4 — Live Comments

```
GOAL
Fire a flow when a user comments during our active live broadcast (DM reply only).

WEBHOOK
Arrives on the `live_comments` field.

CONFIG
- keyword rules: any / is / contains / whole word / begins with

MATCH
matched when a live comment passes the keyword rule.

HARD CONSTRAINTS
- The private reply is valid ONLY while the broadcast is live. If a send is attempted after
  the stream ends, mark that send_queue row `expired` — do NOT retry it.
- Any delay node in the flow must resolve before the stream ends, or the message is lost.
- Fires once per user per live session.
- The first reply is a single content block (text or image with buttons/quick replies) —
  no user input, no typing delay, no dynamic content in that first message.
- Co-hosted lives: only the primary host's account receives events.

ACCEPTANCE
- A keyword comment during a live fires a private reply.
- The same user commenting again in the same session does not re-fire.
- A reply queued after the broadcast ends is marked expired, not retried.
```

---

## Trigger 5 — Keyword DM

```
GOAL
Fire a flow when an inbound DM matches a keyword rule. This is the most-used entry point.

WEBHOOK
Arrives on `messages` (plain text messages).

CONFIG
- rules[]: each { mode, value } where mode is one of:
    "is"            exact match, case-insensitive
    "contains"      keyword appears anywhere
    "whole_word"    keyword as a whole word (distinguish "like" from "dislike")
    "begins_with"   message starts with the keyword
    "not_contains"  negative keyword — suppresses the match
- max 10 keywords per rule
- if multiple keyword flows could match, the FIRST live one by priority wins (single match)

MATCH
matched when the DM text satisfies the rule set. No regex — plain string modes only.

NOTES
- Matching is case-insensitive.
- A normal inbound DM opens the 24-hour window.

ACCEPTANCE
- "contains" fires on a substring; "is" does not fire when extra words are present.
- A message hitting a not_contains keyword is suppressed.
- When two keyword flows match, only the higher-priority one runs.
```

---

## Trigger 6 — Default Reply

```
GOAL
Reply to any inbound DM that matched no other trigger, so users always get a response.

WEBHOOK
`messages`. This trigger is the fallback, evaluated only after all others miss.

CONFIG
- frequency: "every_message" | "once_per_24h_per_user"
- scope: option to fire only for direct messages and EXCLUDE story replies

MATCH
matched when an inbound DM reached process-events and no other registered trigger matched.
Implement as a last-resort pass, not as a normal registry matcher, so ordering is explicit.

ACCEPTANCE
- A DM with no keyword match triggers the default reply.
- A DM that matches a keyword flow does NOT also trigger the default reply.
- With the story-reply exclusion on, a story reply does not trigger it.
```

---

## Trigger 7 — Ref URL (ig.me links)

```
GOAL
Fire a flow when a user opens an ig.me link carrying a ?ref= parameter, and capture the ref.

LINK FORMAT
  https://ig.me/m/<USERNAME>?ref=<REF>
  ref: max 2083 chars, allowed characters are alphanumeric plus - _ = only (use base64url,
  never raw base64 with + or /).

WEBHOOK — the ref arrives on a DIFFERENT field depending on thread state:
  New thread, user taps an Ice Breaker  -> messaging_postbacks   (referral attached)
  New thread, user types a message      -> messages              (referral attached)
  Existing thread                       -> messaging_referral
Subscribe to all three and read the ref in each path.

CONFIG
- optional: map named ref values to specific flows
- store the raw ref into contact.custom_fields for campaign attribution

CONSTRAINTS
- Works on the Instagram mobile app only, never on Instagram web.
- Ice Breakers must be enabled for the parameter to be delivered on the new-thread case.
- The referral object is { ref, source: "SHORTLINKS", type: "OPEN_THREAD" }.

ACCEPTANCE
- Opening an ig.me?ref=promo123 link as a NEW thread captures ref=promo123 and fires the
  mapped flow.
- The same for an EXISTING thread (via messaging_referral).
- The ref value is stored on the contact.
```

---

## Trigger 8 — Ice Breakers (Conversation Starters)

```
GOAL
Configure the tappable starter questions shown when a user opens a fresh conversation.

API — Messenger Profile API
  POST https://graph.instagram.com/<VER>/me/messenger_profile
  body: { "platform": "instagram",
          "ice_breakers": [ { "call_to_actions": [ { "question": "...", "payload": "..." } ],
                             "locale": "default" } ] }
  GET  ...?fields=ice_breakers        DELETE with { "fields": ["ice_breakers"] }

CONFIG
- up to 4 questions, each with a question label and a payload
- a `default` locale is mandatory

BEHAVIOUR
- A tap arrives on the `messaging_postbacks` webhook as { mid, title, payload } — subscribe
  to it and route the payload to the mapped flow.
- Ice Breakers only show when there is no active conversation.

CONSTRAINTS
- Max 4 questions. Not shown on desktop.
- The Messenger Profile API is limited to 10 calls per 10 minutes — queue writes, do not
  call it on every UI keystroke or save.

ACCEPTANCE
- Setting 4 starters shows them on a fresh conversation on mobile.
- Tapping a starter fires its mapped flow via messaging_postbacks.
- A 5th starter is rejected in the UI.
```

---

## Trigger 9 — Persistent Menu (Main Menu)

```
GOAL
Configure the always-available menu opened from the icon in the DM thread.

API — Messenger Profile API, field `persistent_menu`
  POST .../me/messenger_profile
  body: { "platform": "instagram",
          "persistent_menu": [ { "locale": "default",
                                 "call_to_actions": [ ... ] } ] }

CONFIG
- menu items, each either a `postback` (routes to a flow) or a `web_url`

INSTAGRAM CONSTRAINTS
- Button types: `postback` and `web_url` ONLY.
- No nested submenus on Instagram (single level).
- `composer_input_disabled` is not available on Instagram.
- Same 10-calls-per-10-minutes limit as Ice Breakers — queue the writes.

ACCEPTANCE
- A menu with a postback item and a web_url item renders in the DM thread.
- Tapping the postback item fires its flow.
- Attempting a nested submenu is rejected at config time with a clear message.
```

---

## Trigger 10 — Instagram Ads (do this last)

> Needs a second, separate integration path. Do not start it until everything above works.

```
GOAL
Fire a flow when a user taps a Click-to-Instagram-Direct ad.

WHY IT IS DIFFERENT
The ad context (ad_id) is only reachable through the FACEBOOK LOGIN integration path — the
Instagram Login path we use everywhere else "cannot access ads or tagging." This trigger
therefore requires standing up the Facebook Login connection in parallel.

WEBHOOK
Arrives on `messaging_referral` with:
  referral = { ref, ad_id, source: "ADS", type: "OPEN_THREAD",
               ads_context_data: { ad_title, photo_url, video_url } }

CONFIG
- map by ad_id (or by ref set in the ad) to a flow

CONSTRAINTS
- Ads are created in Meta Ads Manager, not from boosted posts.
- Campaign objectives: Traffic, Engagement, or Sales only.
- The initial message must contain at least one button or quick reply.
- No variables (first name, custom fields) in the initial message.

ACCEPTANCE
- Tapping a CTD ad opens a thread that fires the mapped flow with ad_id captured.
- ad_title and media from ads_context_data are available to the flow.
```

---

## Not buildable — no prompt exists

| Type | Why |
|---|---|
| Follow to DM (new follower) | No follow webhook, no follower endpoint, no permission. Needs a private arrangement with Meta. |
| Broadcasts | Meta does not offer Instagram DM broadcast; DM Lists allowlisting has been paused since Feb 2024. |
| Sequences / drip past 24h | Cannot deliver automated messages outside the 24-hour window. |

---

## Build order

1. **Task 0** (registry) — mandatory, before anything else.
2. **Keyword DM** and **Story Reply** — two triggers as an architecture test. If either forces
   an engine edit, fix the seam before continuing.
3. **Story Mention, Share to DM, Live Comments, Default Reply, Ref URL** — the rest of the
   real triggers.
4. **Ice Breakers, Persistent Menu** — config surfaces.
5. **Instagram Ads** — last, because it needs the Facebook Login path.

Start Meta's App Review, Business Verification, and Tech Provider verification now, in
parallel — they take calendar time, not engineering time.
