// The Instagram connect flow (Task 4).
//
// GET  ?code=...   Instagram sends the browser here after the user authorizes. We exchange the
//                  code for a long-lived token, store it server-side in ig_token, and redirect
//                  the browser back to the panel. The code and token never touch the panel's JS.
// GET  ?error=...  The user declined, or Meta rejected. Redirect back with the reason.
// POST start       Issues a one-time `state` for the authorize URL. Requires a panel session.
// POST disconnect  Clears the stored token. Requires a panel session.
// POST resubscribe Re-subscribes the connected account to webhooks. Requires a panel session.
//
// The callback only accepts a `state` this function issued in the last 15 minutes, once. Without
// it, anyone who authorized the app with their own Instagram account could land it here as the
// "connected" account and have every DM go out as them (login CSRF).
//
// Deployed with verify_jwt = false: the GET is a top-level browser redirect from Instagram and
// carries no Supabase JWT. The POST checks the JWT itself.

import { db, json } from "../_shared/db.ts";
import { APP_URL, GRAPH_BASE, IG_APP_ID, IG_APP_SECRET, IG_REDIRECT_URI } from "../_shared/env.ts";
import { credentials } from "../_shared/account.ts";
import { requireUser } from "../_shared/auth.ts";
import { withCors } from "../_shared/cors.ts";

const STATE_TTL_MS = 15 * 60 * 1000;

const SHORT_TOKEN_URL = "https://api.instagram.com/oauth/access_token";
const LONG_TOKEN_URL = "https://graph.instagram.com/access_token";
const ME_URL = "https://graph.instagram.com/me";

const cors = {
  "access-control-allow-headers": "authorization, content-type",
  "access-control-allow-methods": "POST, OPTIONS",
};

function back(params: Record<string, string>): Response {
  // Relative, so a panel hosted under a path (GitHub Pages: /repo/) keeps it.
  const url = new URL("connect", APP_URL().replace(/\/*$/, "/"));
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return new Response(null, { status: 302, headers: { location: url.toString() } });
}

async function exchange(code: string): Promise<{ token: string; expiresIn: number }> {
  // 1. code -> short-lived token
  const form = new URLSearchParams({
    client_id: IG_APP_ID(),
    client_secret: IG_APP_SECRET(),
    grant_type: "authorization_code",
    redirect_uri: IG_REDIRECT_URI(),
    code,
  });
  const shortRes = await fetch(SHORT_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  const shortBody = await shortRes.json().catch(() => ({}));
  if (!shortRes.ok) {
    throw new Error(shortBody.error_message ?? `Token exchange failed (${shortRes.status})`);
  }
  // Instagram has returned this both flat and wrapped in a data array over time.
  const shortToken: string = shortBody.access_token ?? shortBody.data?.[0]?.access_token;
  if (!shortToken) throw new Error("No short-lived token in the response");

  // 2. short-lived -> long-lived (~60 days)
  const longUrl = new URL(LONG_TOKEN_URL);
  longUrl.searchParams.set("grant_type", "ig_exchange_token");
  longUrl.searchParams.set("client_secret", IG_APP_SECRET());
  longUrl.searchParams.set("access_token", shortToken);
  const longRes = await fetch(longUrl);
  const longBody = await longRes.json().catch(() => ({}));
  if (!longRes.ok || !longBody.access_token) {
    throw new Error(longBody.error?.message ?? `Long-lived exchange failed (${longRes.status})`);
  }
  return { token: longBody.access_token, expiresIn: Number(longBody.expires_in ?? 0) };
}

async function profile(token: string): Promise<{ userId: string; username?: string }> {
  const url = new URL(ME_URL);
  url.searchParams.set("fields", "user_id,username");
  url.searchParams.set("access_token", token);
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.user_id) {
    throw new Error(body.error?.message ?? "Could not read the account profile");
  }
  return { userId: String(body.user_id), username: body.username };
}

async function store(token: string, expiresIn: number, userId: string, username?: string) {
  const sql = db();
  const expiresAt = expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : null;
  const now = new Date().toISOString();

  const { data: acct, error } = await sql
    .from("ig_account")
    .upsert(
      {
        ig_user_id: userId,
        username: username ?? null,
        status: "connected",
        connected_at: now,
        token_expires_at: expiresAt,
        last_refreshed_at: now,
      },
      { onConflict: "ig_user_id" },
    )
    .select("id")
    .single();
  if (error) throw new Error(`ig_account upsert failed: ${error.message}`);

  const { error: tokErr } = await sql
    .from("ig_token")
    .upsert({ ig_account_id: acct.id, access_token: token, expires_at: expiresAt, updated_at: now });
  if (tokErr) throw new Error(`ig_token upsert failed: ${tokErr.message}`);
}

// Every event a trigger listens to. Without this subscription Meta never calls ig-webhook for the
// account, even though the app-level webhook is verified ("Webhook Subscription: Off").
const WEBHOOK_FIELDS = "messages,messaging_postbacks,messaging_referral,comments,live_comments";

/** Subscribe the account to the app's webhooks. Throws with Meta's reason on failure. */
async function subscribe(token: string): Promise<void> {
  const url = new URL(`${GRAPH_BASE()}/me/subscribed_apps`);
  url.searchParams.set("subscribed_fields", WEBHOOK_FIELDS);
  url.searchParams.set("access_token", token);
  const res = await fetch(url, { method: "POST" });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.success === false) {
    throw new Error(`Connected, but webhook subscription failed: ${body.error?.message ?? res.status}`);
  }
}

/** Re-run the webhook subscription for the connected account with its stored token. */
async function resubscribe(): Promise<Response> {
  const { token } = await credentials();
  await subscribe(token);
  return json({ subscribed: true }, 200, cors);
}

/** A fresh random state, stored server-side so the callback can prove the flow started here. */
async function start(): Promise<Response> {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const state = Array.from(bytes, (x) => x.toString(16).padStart(2, "0")).join("");
  const sql = db();
  // Old, never-used states are just clutter; sweep them while we are here.
  await sql.from("oauth_state").delete().lt("created_at", new Date(Date.now() - STATE_TTL_MS).toISOString());
  const { error } = await sql.from("oauth_state").insert({ state });
  if (error) return json({ error: `Could not start the connection: ${error.message}` }, 500, cors);
  return json({ state }, 200, cors);
}

/** Consume a state: true only if it exists, is fresh, and has not been used before. */
async function consumeState(state: string | null): Promise<boolean> {
  if (!state) return false;
  const { data } = await db()
    .from("oauth_state")
    .delete()
    .eq("state", state)
    .gte("created_at", new Date(Date.now() - STATE_TTL_MS).toISOString())
    .select("state");
  return Boolean(data?.length);
}

async function disconnect(): Promise<Response> {
  const sql = db();
  // Clear every stored token and mark accounts disconnected. Meta revocation is user-side.
  const { data: accts } = await sql.from("ig_account").select("id");
  for (const a of accts ?? []) await sql.from("ig_token").delete().eq("ig_account_id", a.id);
  await sql.from("ig_account").update({ status: "disconnected", token_expires_at: null }).neq("id", "00000000-0000-0000-0000-000000000000");

  return json({ disconnected: true }, 200, cors);
}

Deno.serve(async (req) => withCors(req, await handle(req)));

async function handle(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });

  if (req.method === "POST") {
    try {
      const denied = await requireUser(req, db(), cors);
      if (denied) return denied;
      const body = await req.json().catch(() => ({}));
      if (body?.action === "start") return await start();
      if (body?.action === "resubscribe") return await resubscribe();
      return await disconnect();
    } catch (err) {
      return json({ error: String(err) }, 500, cors);
    }
  }

  const url = new URL(req.url);
  const error = url.searchParams.get("error_description") ?? url.searchParams.get("error");
  if (error) return back({ ig: "error", reason: error });

  const code = url.searchParams.get("code");
  if (!code) return back({ ig: "error", reason: "No code returned" });
  if (!(await consumeState(url.searchParams.get("state")))) {
    return back({ ig: "error", reason: "This connect link expired or was not started from the panel. Try again." });
  }

  try {
    const { token, expiresIn } = await exchange(code);
    const { userId, username } = await profile(token);
    await store(token, expiresIn, userId, username);
    await subscribe(token);
    return back({ ig: "connected", username: username ?? "" });
  } catch (err) {
    console.error("ig-oauth failed:", err);
    return back({ ig: "error", reason: String(err).slice(0, 200) });
  }
}
