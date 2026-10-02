// Refreshes long-lived Instagram tokens before they expire (Task 4).
//
// A long-lived token lasts ~60 days and can be refreshed any time after it is 24h old. pg_cron
// runs this daily. An account whose refresh fails is marked needs_reconnect so the connect
// screen can tell the user to reconnect, rather than the token silently dying mid-campaign.

import { db, json } from "../_shared/db.ts";
import { requireService } from "../_shared/auth.ts";

const REFRESH_URL = "https://graph.instagram.com/refresh_access_token";
const RENEW_WITHIN_MS = 7 * 24 * 60 * 60 * 1000; // refresh once inside the last week of life

async function refreshOne(sql: ReturnType<typeof db>, acct: Record<string, any>): Promise<boolean> {
  const { data: tok } = await sql
    .from("ig_token")
    .select("access_token")
    .eq("ig_account_id", acct.id)
    .maybeSingle();
  if (!tok?.access_token) return false;

  const url = new URL(REFRESH_URL);
  url.searchParams.set("grant_type", "ig_refresh_token");
  url.searchParams.set("access_token", tok.access_token);

  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));

  if (!res.ok || !body.access_token) {
    await sql.from("ig_account").update({ status: "needs_reconnect" }).eq("id", acct.id);
    console.error(`refresh failed for ${acct.ig_user_id}:`, body.error?.message ?? res.status);
    return false;
  }

  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + Number(body.expires_in ?? 0) * 1000).toISOString();
  await sql.from("ig_token").update({ access_token: body.access_token, expires_at: expiresAt, updated_at: now })
    .eq("ig_account_id", acct.id);
  await sql.from("ig_account").update({ token_expires_at: expiresAt, last_refreshed_at: now, status: "connected" })
    .eq("id", acct.id);
  return true;
}

Deno.serve(async (req) => {
  const denied = requireService(req);
  if (denied) return denied;
  try {
    const sql = db();
    const cutoff = new Date(Date.now() + RENEW_WITHIN_MS).toISOString();
    const { data: accts } = await sql
      .from("ig_account")
      .select("id, ig_user_id, token_expires_at")
      .neq("status", "disconnected")
      .or(`token_expires_at.is.null,token_expires_at.lte.${cutoff}`);

    let refreshed = 0;
    for (const acct of accts ?? []) if (await refreshOne(sql, acct)) refreshed++;

    return json({ checked: accts?.length ?? 0, refreshed });
  } catch (err) {
    console.error("ig-token-refresh failed:", err);
    return json({ error: String(err) }, 500);
  }
});
