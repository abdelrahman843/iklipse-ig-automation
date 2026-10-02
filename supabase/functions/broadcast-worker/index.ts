// Fans a scheduled broadcast out to its audience. Runs every minute from pg_cron.
//
// A broadcast leaves 'draft' as 'scheduled' (send now = scheduled_at in the past). This worker
// picks up due ones, marks them 'sending', works out the audience at that moment (ManyChat does
// the same: recipients are counted at send time, not when it was scheduled), and either queues
// its message blocks or starts its automation for every contact. Only contacts whose 24-hour
// window is open can receive (Instagram will not deliver outside it), and contacts who opted out
// get nothing.

import { db, json } from "../_shared/db.ts";
import { WINDOW_MS } from "../_shared/types.ts";
import { requireService } from "../_shared/auth.ts";
import {
  type AudienceCondition,
  bubbles,
  queueFlowRun,
  type StoredContent,
  wakeEngine,
} from "../_shared/content.ts";

type Row = Record<string, any>;
const sql = db();

const CONTACT_LIMIT = 2000;
const INSERT_CHUNK = 500;

/** Contacts the broadcast can reach right now. */
async function audienceOf(b: Row): Promise<Row[]> {
  const windowStart = new Date(Date.now() - WINDOW_MS).toISOString();
  let conditions = (Array.isArray(b.audience) ? b.audience : []) as AudienceCondition[];
  // Rows written before audience conditions existed only have the single segment tag.
  if (!conditions.length && b.segment_tag) conditions = [{ field: "tag", op: "is", value: b.segment_tag }];
  // The same matching the Contacts page uses, narrowed to who Instagram can still deliver to.
  const { data, error } = await sql
    .rpc("match_contacts", { p_conditions: conditions, p_search: "" })
    .select("id, last_interaction_at")
    .gte("last_interaction_at", windowStart)
    .is("opted_out_at", null)
    .limit(CONTACT_LIMIT);
  if (error) throw error;
  return data ?? [];
}

/** Queue every bubble for every contact. One insert per bubble keeps each contact's order. */
async function queueBlocks(b: Row, contacts: Row[]): Promise<number> {
  const parts = bubbles(b.content as StoredContent);
  if (!parts.length) return 0;
  let reached = 0;
  for (let i = 0; i < contacts.length; i += INSERT_CHUNK) {
    const chunk = contacts.slice(i, i + INSERT_CHUNK);
    let chunkOk = true;
    for (const payload of parts) {
      const { error } = await sql.from("send_queue").insert(
        chunk.map((c) => ({
          contact_id: c.id,
          flow_run_id: null,
          send_type: "dm",
          comment_id: null,
          payload,
          broadcast_id: b.id,
          expires_at: new Date(new Date(c.last_interaction_at).getTime() + WINDOW_MS).toISOString(),
        })),
      );
      if (error) {
        console.error(`broadcast ${b.id}: send_queue insert failed:`, error.message);
        chunkOk = false;
        break;
      }
    }
    if (chunkOk) reached += chunk.length;
  }
  return reached;
}

/** Start the broadcast's automation for every contact not already inside another run. */
async function startFlow(b: Row, contacts: Row[]): Promise<number> {
  const { data: flow } = await sql.from("flow").select("id, graph").eq("id", b.flow_id).is("deleted_at", null).maybeSingle();
  if (!flow) throw new Error("The automation this broadcast sends was deleted or is in Trash");
  let started = 0;
  for (const c of contacts) {
    if (await queueFlowRun(sql, flow, c.id, { broadcast_id: b.id })) started++;
  }
  if (started) await wakeEngine(sql);
  return started;
}

Deno.serve(async (req) => {
  const denied = requireService(req);
  if (denied) return denied;
  try {
    const nowIso = new Date().toISOString();
    const { data: due, error } = await sql
      .from("broadcast")
      .select("*")
      .eq("status", "scheduled")
      .lte("scheduled_at", nowIso)
      .limit(5);
    if (error) throw error;

    let processed = 0;
    let reachedTotal = 0;

    for (const b of due ?? []) {
      // Claim it: only the worker that flips scheduled -> sending fans it out.
      const { data: claimed } = await sql
        .from("broadcast")
        .update({ status: "sending" })
        .eq("id", b.id)
        .eq("status", "scheduled")
        .select("id");
      if (!claimed?.length) continue;

      let reached = 0;
      try {
        const contacts = await audienceOf(b);
        reached = b.flow_id ? await startFlow(b, contacts) : await queueBlocks(b, contacts);
      } catch (err) {
        console.error(`broadcast ${b.id} failed:`, err);
      }

      await sql
        .from("broadcast")
        .update({ status: "sent", sent_count: reached, sent_at: new Date().toISOString() })
        .eq("id", b.id);
      processed++;
      reachedTotal += reached;
    }

    return json({ processed, reached: reachedTotal });
  } catch (err) {
    console.error("broadcast-worker failed:", err);
    return json({ error: String(err) }, 500);
  }
});
