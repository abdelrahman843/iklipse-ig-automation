// Receives Instagram webhooks. Verifies, persists, returns 200. Nothing else.
//
// Do not add flow execution here. Meta measures how fast this responds; slow responses turn
// into retries, and repeated failures disable webhook delivery for the account. Handing the
// event to process-events happens after the 200 is already on its way, so it costs Meta
// nothing.

import { db, json } from "../_shared/db.ts";
import { META_APP_SECRET, VERIFY_TOKEN } from "../_shared/env.ts";
import { verifySignature } from "../_shared/meta.ts";
import { kick } from "../_shared/invoke.ts";
import { safeEqual } from "../_shared/auth.ts";

function classify(payload: Record<string, unknown>): string {
  const entry = (payload.entry as Array<Record<string, unknown>> | undefined)?.[0];
  if (!entry) return "unknown";
  if (Array.isArray(entry.messaging) && entry.messaging.length > 0) return "message";
  const change = (entry.changes as Array<Record<string, unknown>> | undefined)?.[0];
  if (change) return String(change.field ?? "unknown");
  return "unknown";
}

Deno.serve(async (req) => {
  const url = new URL(req.url);

  // Meta's subscription handshake
  if (req.method === "GET") {
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge") ?? "";

    if (mode === "subscribe" && token !== null && safeEqual(token, VERIFY_TOKEN())) {
      return new Response(challenge, { status: 200, headers: { "content-type": "text/plain" } });
    }
    return new Response("Forbidden", { status: 403 });
  }

  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const rawBody = await req.text();
  const signed = await verifySignature(
    rawBody,
    req.headers.get("x-hub-signature-256"),
    META_APP_SECRET(),
  );
  if (!signed) return new Response("Invalid signature", { status: 401 });

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const { error } = await db().from("webhook_event").insert({
    raw: payload,
    event_type: classify(payload),
  });

  // Still answer 200 on a write failure. Meta's retries are worth less than staying subscribed,
  // and the log line is enough to find the dropped event.
  if (error) console.error("webhook_event insert failed", error.message);
  else kick("process-events");

  return json({ received: true });
});
