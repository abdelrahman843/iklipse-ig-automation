import { SERVICE_ROLE_KEY, SUPABASE_URL } from "./env.ts";

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void } | undefined;

/**
 * Hand work to another worker without waiting for it.
 *
 * The cron jobs still run every minute as the safety net for delays, timeouts and retries.
 * This is what keeps the common path off that one-minute wait.
 */
export function kick(fn: string): void {
  const run = fetch(`${SUPABASE_URL()}/functions/v1/${fn}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${SERVICE_ROLE_KEY()}`,
      "content-type": "application/json",
    },
    body: "{}",
  })
    .then((res) => {
      if (!res.ok) console.error(`${fn} answered ${res.status}`);
    })
    .catch((err) => console.error(`could not reach ${fn}:`, err));

  // waitUntil keeps the runtime alive after the response is already on its way back.
  if (typeof EdgeRuntime !== "undefined" && EdgeRuntime?.waitUntil) EdgeRuntime.waitUntil(run);
}
