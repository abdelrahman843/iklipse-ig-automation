// Caller checks shared by every function.
//
// Two kinds of caller exist:
//   * the panel (a person)  -> requireUser: a real Supabase session, verified with auth.getUser.
//   * cron / other workers  -> requireService: the service-role JWT. These functions run with
//                              verify_jwt = true, so the gateway has already checked the
//                              signature and reading the role claim is safe.
//
// The old check decoded the JWT's role claim WITHOUT verifying it, so any hand-made token
// saying role:"anon" was let through. Never trust a claim the gateway has not verified.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { json } from "./db.ts";

function bearer(req: Request): string {
  return req.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim() ?? "";
}

function claims(jwt: string): Record<string, unknown> | null {
  try {
    const part = jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(part));
  } catch {
    return null;
  }
}

/**
 * Panel-only endpoints. Returns an error Response to send back, or null when the caller is a
 * signed-in user.
 *
 * ALLOW_ANON=true (an Edge Function secret) is the explicit escape hatch for running the panel
 * with the login gate off (VITE_DISABLE_AUTH=true). The anon key is public, so in that mode these
 * endpoints are public too — that is the honest cost of turning the gate off.
 */
export async function requireUser(
  req: Request,
  sql: SupabaseClient,
  headers: Record<string, string> = {},
): Promise<Response | null> {
  if (Deno.env.get("ALLOW_ANON") === "true") return null;
  const jwt = bearer(req);
  if (!jwt) return json({ error: "Not signed in" }, 401, headers);
  const { data, error } = await sql.auth.getUser(jwt);
  if (error || !data?.user) return json({ error: "Your session expired. Sign in again." }, 401, headers);
  return null;
}

/** Worker endpoints (cron + kick). Anyone holding the public anon key must not reach them. */
export function requireService(req: Request): Response | null {
  const role = claims(bearer(req))?.role;
  if (role !== "service_role") return json({ error: "Forbidden" }, 403);
  return null;
}

/** Constant-time string compare, for shared secrets like the webhook verify token. */
export function safeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}
