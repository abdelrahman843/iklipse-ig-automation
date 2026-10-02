// Resolves which Instagram account we act as, and its token.
//
// Prefers an account connected through the OAuth flow (token in ig_token, server-only). Falls
// back to the hand-pasted IG_ACCESS_TOKEN/IG_USER_ID env vars, so the pre-OAuth setup keeps
// working until an account is connected. Cached per invocation — the token does not change
// mid-run, and every send would otherwise hit the DB twice.

import { db } from "./db.ts";
import { IG_ACCESS_TOKEN, IG_USER_ID } from "./env.ts";

export interface Credentials {
  token: string;
  igUserId: string;
}

let cache: Credentials | null = null;

export async function credentials(): Promise<Credentials> {
  if (cache) return cache;

  const sql = db();
  const { data: acct } = await sql
    .from("ig_account")
    .select("id, ig_user_id")
    .eq("status", "connected")
    .order("connected_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (acct) {
    const { data: tok } = await sql
      .from("ig_token")
      .select("access_token")
      .eq("ig_account_id", acct.id)
      .maybeSingle();
    if (tok?.access_token) {
      cache = { token: tok.access_token, igUserId: acct.ig_user_id };
      return cache;
    }
  }

  cache = { token: IG_ACCESS_TOKEN(), igUserId: IG_USER_ID() };
  return cache;
}
