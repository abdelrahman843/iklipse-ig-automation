// Caller checks shared by every function.
//
// Two kinds of caller exist:
//   * the panel (a person)  -> requireMember: a real Supabase session, verified with auth.getUser,
//                              plus the workspace that login belongs to.
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

/** The signed-in person calling a panel endpoint, and the workspace everything they do is scoped to. */
export interface Member {
  userId: string;
  workspaceId: string;
  role: string;
}

/**
 * Panel-only endpoints. Returns the caller's membership, or an error Response to send back.
 * Every query the endpoint makes afterwards must be scoped to member.workspaceId: these
 * functions use the service role, which RLS does not filter.
 */
export async function requireMember(
  req: Request,
  sql: SupabaseClient,
  headers: Record<string, string> = {},
): Promise<Member | Response> {
  const jwt = bearer(req);
  if (!jwt) return json({ error: "Not signed in" }, 401, headers);
  const { data, error } = await sql.auth.getUser(jwt);
  if (error || !data?.user) return json({ error: "Your session expired. Sign in again." }, 401, headers);
  const { data: m } = await sql
    .from("workspace_member")
    .select("workspace_id, role")
    .eq("user_id", data.user.id)
    .maybeSingle();
  if (!m) return json({ error: "This login has no workspace. Ask your admin." }, 403, headers);
  return { userId: data.user.id, workspaceId: m.workspace_id, role: m.role };
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
