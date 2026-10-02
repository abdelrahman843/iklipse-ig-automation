// Human takeover send path (Task 3).
//
// A human agent replies from the inbox. The 24-hour window decides how it goes out:
//   OPEN        under 24h   -> a normal DM
//   HUMAN_ONLY  24h to 7d   -> a DM carrying the HUMAN_AGENT tag (the only lawful way after 24h)
//   CLOSED      over 7d      -> refused; nothing can be sent
// Sending pauses automation for this contact (30 minutes unless Settings › Live Chat says
// otherwise) so the bot and the human do not talk over each other. Automated messages never reach
// this path, so they never carry the tag.

import { db, json } from "../_shared/db.ts";
import { kick } from "../_shared/invoke.ts";
import { sendHumanMessage } from "../_shared/meta.ts";
import { requireUser } from "../_shared/auth.ts";
import { withCors } from "../_shared/cors.ts";
import { WINDOW_MS } from "../_shared/types.ts";
import type { FlowGraph, MessageContent } from "../_shared/types.ts";

const HUMAN_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_PAUSE_MINUTES = 30;

const cors = {
  "access-control-allow-headers": "authorization, content-type",
  "access-control-allow-methods": "POST, OPTIONS",
};

function windowState(lastInteractionAt: string | null): "open" | "human_only" | "closed" {
  if (!lastInteractionAt) return "closed";
  const age = Date.now() - new Date(lastInteractionAt).getTime();
  if (age < WINDOW_MS) return "open";
  if (age < HUMAN_WINDOW_MS) return "human_only";
  return "closed";
}

Deno.serve(async (req) => withCors(req, await handle(req)));

async function handle(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405, cors);

  const sql = db();
  const denied = await requireUser(req, sql, cors);
  if (denied) return denied;

  let payload: { contactId?: string; text?: string; content?: MessageContent; flowId?: string };
  try {
    payload = await req.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400, cors);
  }
  if (!payload.contactId) return json({ error: "A contact is required" }, 400, cors);

  const { data: contact } = await sql
    .from("contact")
    .select("id, igsid, last_interaction_at")
    .eq("id", payload.contactId)
    .maybeSingle();
  if (!contact) return json({ error: "Contact not found" }, 404, cors);

  // Path B: trigger a flow for this contact from the inbox (manual run).
  if (payload.flowId) {
    const { data: flow } = await sql
      .from("flow")
      .select("id, graph")
      .eq("id", payload.flowId)
      .is("deleted_at", null)
      .maybeSingle();
    const graph = (flow?.graph ?? {}) as FlowGraph;
    if (!flow || !graph.start) return json({ error: "That flow has no first step." }, 400, cors);
    // Queued as an already-due delay: process-events picks it up on its next pass (kicked now),
    // so the run goes through the one engine path instead of a second copy of it here.
    const { error: runErr } = await sql.from("flow_run").insert({
      flow_id: flow.id,
      contact_id: contact.id,
      status: "waiting_delay",
      resume_at: new Date().toISOString(),
      current_node_id: graph.start,
      state: {},
    });
    if (runErr?.code === "23505") {
      return json({ error: "This contact is already in a flow. Wait for it to finish first." }, 409, cors);
    }
    if (runErr) return json({ error: runErr.message }, 500, cors);
    kick("process-events");
    return json({ triggered: true }, 200, cors);
  }

  // Path A: send a human message (text, or a richer content payload with image/buttons).
  const content: MessageContent = payload.content ?? { text: (payload.text ?? "").trim() };
  const hasBody = Boolean(content.text?.trim() || content.imageUrl || (content.buttons?.length) || content.attachment?.url || content.cards?.length);
  if (!hasBody) return json({ error: "A message is required" }, 400, cors);

  const state = windowState(contact.last_interaction_at);
  if (state === "closed") {
    return json({ error: "This conversation is more than 7 days old. Instagram will not deliver a message." }, 409, cors);
  }

  try {
    const result = await sendHumanMessage(contact.igsid, content, state === "human_only");
    await sql.from("message").insert({
      contact_id: contact.id,
      direction: "out",
      sent_by: "human",
      payload: content,
      meta_message_id: (result.message_id as string) ?? null,
    });
    // Settings › Live Chat decides how long; 0 means a human reply doesn't pause anything.
    const { data: settings } = await sql.from("app_settings").select("human_pause_minutes").eq("id", 1).maybeSingle();
    const minutes = Number(settings?.human_pause_minutes ?? DEFAULT_PAUSE_MINUTES);
    await sql
      .from("contact")
      .update({
        ...(minutes > 0 ? { pause_until: new Date(Date.now() + minutes * 60_000).toISOString() } : {}),
        unread: false,
      })
      .eq("id", contact.id);
    return json({ sent: true, state, tagged: state === "human_only" }, 200, cors);
  } catch (err) {
    console.error("inbox-send failed:", err);
    return json({ error: String(err) }, 502, cors);
  }
}
