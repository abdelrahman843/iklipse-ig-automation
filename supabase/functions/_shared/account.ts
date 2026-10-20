// Resolves which Instagram account a workspace acts as, and its token.
//
// Every workspace connects its own account through the OAuth flow (token in ig_token,
// server-only). There is deliberately no fallback: a workspace without a connected account
// sends nothing, rather than sending as somebody else's account.
//
// Cached for a minute per workspace, so a batch of sends doesn't read the token for every
// message, while a reconnect or a refreshed token is picked up quickly.

import { db } from "./db.ts";

export interface Credentials {
  workspaceId: string;
  accountId: string;
  igUserId: string;
  token: string;
}

/** The workspace has no connected Instagram account (never connected, or disconnected). */
export class NoAccountError extends Error {
  constructor() {
    super("No Instagram account is connected to this workspace. Connect one in Settings › Instagram.");
    this.name = "NoAccountError";
  }
}

const TTL_MS = 60_000;
const cache = new Map<string, { at: number; creds: Promise<Credentials> }>();

async function load(workspaceId: string): Promise<Credentials> {
  const sql = db();
  const { data: acct } = await sql
    .from("ig_account")
    .select("id, ig_user_id")
    .eq("workspace_id", workspaceId)
    .eq("status", "connected")
    .maybeSingle();
  if (!acct) throw new NoAccountError();

  const { data: tok } = await sql
    .from("ig_token")
    .select("access_token")
    .eq("ig_account_id", acct.id)
    .maybeSingle();
  if (!tok?.access_token) throw new NoAccountError();

  return { workspaceId, accountId: acct.id, igUserId: acct.ig_user_id, token: tok.access_token };
}

export function credentialsFor(workspaceId: string): Promise<Credentials> {
  const hit = cache.get(workspaceId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.creds;
  const creds = load(workspaceId);
  cache.set(workspaceId, { at: Date.now(), creds });
  // A failed read is not cached: the next call tries again.
  creds.catch(() => {
    if (cache.get(workspaceId)?.creds === creds) cache.delete(workspaceId);
  });
  return creds;
}

/** Forget a workspace's token, e.g. after Meta said it no longer works. */
export function forgetCredentials(workspaceId: string): void {
  cache.delete(workspaceId);
}
