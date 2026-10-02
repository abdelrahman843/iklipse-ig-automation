# Instagram automation MVP

An end-to-end slice of comment-to-DM automation. All runtime lives in Supabase; the frontend is
a control panel only. Built from [INSTAGRAM-AUTOMATION-MVP-PLAN.md](INSTAGRAM-AUTOMATION-MVP-PLAN.md).

```
Meta ─► ig-webhook ─► webhook_event ─► process-events ─► send_queue ─► send-worker ─► Meta
             └──────── calls ────────────┘                    └──── calls ────┘
```

`ig-webhook` answers Meta first, then hands the event straight to `process-events`; that one
wakes `send-worker` as soon as it queues anything. The `pg_cron` jobs still run every minute,
but only as the safety net for delays, reply timeouts and retries. Waiting for the next cron
tick at each hop cost about a minute per step; the direct calls bring a reply down to a
second or two.

| Path | What it is |
|---|---|
| `supabase/migrations/` | The eight tables, RLS, the storage bucket, the pg_cron jobs, the event claim |
| `supabase/functions/ig-webhook/` | Verifies Meta's signature, persists the raw event, returns 200 |
| `supabase/functions/process-events/` | Trigger matching and the execution engine |
| `supabase/functions/send-worker/` | Drains the queue inside Meta's rate limits |
| `src/` | React + Vite control panel: flows, flow editor, conversations, media |

---

## 1. Credentials you need

Nothing here is in the repo. Collect these before deploying.

### From Supabase (Project settings → API, and the project URL)

| Value | Where it goes | Notes |
|---|---|---|
| Project URL | `.env` as `VITE_SUPABASE_URL`, and `app_config` | e.g. `https://abcd1234.supabase.co` |
| `anon` public key | `.env` as `VITE_SUPABASE_ANON_KEY` | Safe in the browser |
| `service_role` key | Edge Function secret + `app_config` | **Never** put this in `.env` or any frontend file |
| Project ref | `supabase link --project-ref <ref>` | The subdomain of the project URL |
| Database password | `supabase db push` prompt | Set when you created the project |

### From Meta (developers.facebook.com → your app)

| Value | Where it goes | Notes |
|---|---|---|
| App secret | Edge Function secret `META_APP_SECRET` | Signs every webhook as `X-Hub-Signature-256` |
| Instagram access token | Edge Function secret `IG_ACCESS_TOKEN` | Long-lived. Anyone holding it can DM as the business. |
| Instagram user id | Edge Function secret `IG_USER_ID` | The professional account id that owns the conversations |
| Verify token | Edge Function secret `META_VERIFY_TOKEN` + Meta's webhook form | You invent this string. Any random value works, as long as both sides match. |

### Also required, from Instagram itself

- A **professional** (business or creator) Instagram account.
- **Settings → Messages and story replies → Allow access to messages** turned **on**.
  If this is off, everything connects cleanly and no automation ever fires, with no error
  anywhere. It is the single biggest time-waster on this project.
- The app needs `instagram_business_basic`, `instagram_business_manage_messages`, and
  `instagram_business_manage_comments`.

---

## 2. Deploy

```bash
supabase link --project-ref <project-ref>
supabase db push
```

Set the server-side secrets. These never reach the browser:

```bash
supabase secrets set META_APP_SECRET=<app-secret> META_VERIFY_TOKEN=<your-invented-string> IG_ACCESS_TOKEN=<instagram-token> IG_USER_ID=<instagram-user-id>
```

Deploy the functions. `ig-webhook` is public because Meta signs with an app secret, not a JWT:

```bash
supabase functions deploy ig-webhook --no-verify-jwt
```

```bash
supabase functions deploy process-events send-worker
```

Give pg_cron somewhere to call. Run this once in the SQL editor:

```sql
insert into app_config (key, value) values
  ('functions_base_url', 'https://<project-ref>.supabase.co/functions/v1'),
  ('service_role_key',   '<service-role-key>')
on conflict (key) do update set value = excluded.value;
```

In the Meta app dashboard, add the webhook:

- Callback URL: `https://<project-ref>.supabase.co/functions/v1/ig-webhook`
- Verify token: the same string you set as `META_VERIFY_TOKEN`
- Subscribe to the `messages` and `comments` fields

---

## 3. Run the control panel

```bash
npm install
```

Copy `.env.example` to `.env` and fill in the project URL and anon key, then:

```bash
npm run dev
```

---

## 4. Test it

Meta's test tool sends payloads that do not match real traffic. Test from a second real
Instagram account.

1. Create a flow, keep the default comment-to-DM graph, set the post id and a keyword, save,
   take it live.
2. From the second account, comment the keyword on that post.
3. `webhook_event` gets a row within seconds. Within a minute `flow_run` opens and `send_queue`
   holds a `private_reply`.
4. The second account receives the private reply, with the button drawn under it. Tap the
   button — that is what opens the 24-hour window. A button that opens a link does not, which
   is why the editor refuses to take such a flow live.
5. The follow check runs and the flow takes the follower or non-follower path.
6. Repeat from an account that does not follow, to exercise the other branch.
7. To test the closed window: set `contact.last_interaction_at` to two days ago and let a run
   reach a send. It must land on `blocked_window` with a reason, not fail silently.
8. Fire several comments at once and confirm the queue drains instead of dropping messages.

Watch what happened while testing. The CLI has no remote log command, so read the tables the
workers write, or open the function logs in the dashboard:

```sql
select event_type, received_at, processed_at, error from webhook_event order by received_at desc limit 10;
select send_type, status, attempts, sent_at, error from send_queue order by created_at desc limit 10;
select status, current_node_id, error from flow_run order by created_at desc limit 5;
```

---

## 5. Notes on the build

Five things differ from the plan, each on purpose:

- **Buttons are sent as a button template, not quick replies.** Quick replies sit above the
  keyboard, detached from the message they belong to. A button template draws them under the
  message itself. Instagram allows three, and the text can run to 640 characters.
- **Events are claimed atomically** by `claim_webhook_events`. Now that a webhook triggers
  processing immediately, two workers can be in flight at once, and without the claim the
  same comment would be answered twice.
- **A comment does not touch `last_interaction_at`.** The plan says to update it on every
  inbound event, but a comment does not open the messaging window — only a reply or a button
  tap does. Updating it on comments would make the engine think it could DM when it cannot.
- **`send_queue` has a `sent_at` column.** The 750/hour private-reply cap is counted from it.
- **`flow_run` has an `error` column,** so a blocked or failed run can say why in the panel
  instead of only in the logs.

Security, stated plainly: this MVP has no authentication, as the plan specifies. The RLS
policies give the `anon` key full control of flows and read access to conversations, so anyone
with the project URL and the anon key can read and edit your automations. Keep the panel off
the public internet until you add auth. The Instagram token is not affected — it lives only in
Edge Function secrets and is never readable from the browser.
