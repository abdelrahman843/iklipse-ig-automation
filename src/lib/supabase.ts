import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  throw new Error(
    "Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in .env, then restart the dev server.",
  );
}

/**
 * A request to an unreachable project never settles on its own, which leaves every screen
 * on "Loading…" with nothing to read. Give each one a deadline so failures surface.
 */
const REQUEST_TIMEOUT_MS = 15_000;

function timedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const deadline = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const signal = init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline;
  return fetch(input, { ...init, signal });
}

export const supabase = createClient(url, anonKey, {
  auth: {
    // Keep the session across reloads, refresh it before expiry, and pick up the recovery
    // token that a password-reset link carries back in the URL.
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
  global: { fetch: timedFetch },
});

/** Supabase rejects with plain objects as often as with Errors. Read either one. */
export function errorText(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object" && "message" in err) return String(err.message);
  return String(err);
}
