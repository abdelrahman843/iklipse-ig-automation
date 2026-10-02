// Drains send_queue inside Meta's limits. Runs every minute from pg_cron.
//
// The binding constraint is 750 private replies per hour, per account. Everything else
// (100/s text, 10/s media) is far above what a minute-scheduled worker can reach.

import { db, json } from "../_shared/db.ts";
import { PRIVATE_REPLY_HOURLY_CAP } from "../_shared/env.ts";
import { MetaError, sendDirectMessage, sendPrivateReply } from "../_shared/meta.ts";
import type { MessageContent } from "../_shared/types.ts";
import { requireService } from "../_shared/auth.ts";

type Row = Record<string, any>;
const sql = db();

const BATCH = 40;
const MAX_ATTEMPTS = 6;
const HOUR_MS = 60 * 60 * 1000;

/** 1m, 2m, 4m, 8m, 16m, capped at an hour. */
function backoffMs(attempts: number): number {
  return Math.min(60_000 * 2 ** (attempts - 1), HOUR_MS);
}

async function expireStale(): Promise<number> {
  const { data } = await sql
    .from("send_queue")
    .update({ status: "expired", error: "Expired before it could be sent" })
    .eq("status", "pending")
    .lt("expires_at", new Date().toISOString())
    .select("id");
  return data?.length ?? 0;
}

/** How many private replies are still allowed this hour. */
async function privateRepliesLeft(): Promise<number> {
  const since = new Date(Date.now() - HOUR_MS).toISOString();
  const { count } = await sql
    .from("send_queue")
    .select("id", { count: "exact", head: true })
    .eq("send_type", "private_reply")
    .eq("status", "sent")
    .gte("sent_at", since);
  return Math.max(0, PRIVATE_REPLY_HOURLY_CAP - (count ?? 0));
}

async function markSent(row: Row, metaMessageId: string | null): Promise<void> {
  await sql
    .from("send_queue")
    .update({
      status: "sent",
      sent_at: new Date().toISOString(),
      meta_message_id: metaMessageId,
      error: null,
    })
    .eq("id", row.id);

  await sql.from("message").insert({
    contact_id: row.contact_id,
    direction: "out",
    payload: row.payload,
    meta_message_id: metaMessageId,
    flow_run_id: row.flow_run_id,
  });
}

async function markFailure(row: Row, err: unknown): Promise<void> {
  const attempts = (row.attempts ?? 0) + 1;
  const permanent = err instanceof MetaError && err.permanent;
  const message = err instanceof Error ? err.message : String(err);

  if (permanent || attempts >= MAX_ATTEMPTS) {
    await sql
      .from("send_queue")
      .update({ status: "failed", attempts, error: message })
      .eq("id", row.id);

    // A dead send means the run cannot continue. Say so on the run, not only on the queue row.
    if (row.flow_run_id) {
      await sql
        .from("flow_run")
        .update({ status: "failed", error: `Send failed: ${message}` })
        .eq("id", row.flow_run_id)
        .in("status", ["running", "waiting_input", "waiting_delay"]);
    }
    return;
  }

  await sql
    .from("send_queue")
    .update({
      status: "pending",
      attempts,
      error: message,
      next_attempt_at: new Date(Date.now() + backoffMs(attempts)).toISOString(),
    })
    .eq("id", row.id);
}

Deno.serve(async (req) => {
  const denied = requireService(req);
  if (denied) return denied;
  try {
    const expired = await expireStale();
    let quota = await privateRepliesLeft();

    // Claimed atomically (status -> 'sending'): cron and kick() can overlap, and without the
    // claim both would deliver the same rows.
    const { data: rows, error } = await sql.rpc("claim_send_queue", { batch_size: BATCH });
    if (error) throw new Error(`claim_send_queue failed: ${error.message}`);

    // The claim returns plain rows; look up each contact's igsid in one read.
    const ids = [...new Set((rows ?? []).map((r: Row) => r.contact_id))];
    const { data: contacts } = ids.length
      ? await sql.from("contact").select("id, igsid").in("id", ids)
      : { data: [] as Row[] };
    const igsidOf = new Map((contacts ?? []).map((c: Row) => [c.id, c.igsid]));

    let sent = 0;
    let held = 0;

    for (const row of rows ?? []) {
      if (row.send_type === "private_reply" && quota <= 0) {
        held++; // hourly cap reached: hand it back for the next tick
        await sql.from("send_queue").update({ status: "pending" }).eq("id", row.id);
        continue;
      }

      const content = (row.payload ?? {}) as MessageContent;
      try {
        const result =
          row.send_type === "private_reply"
            ? await sendPrivateReply(row.comment_id, content)
            : await sendDirectMessage(igsidOf.get(row.contact_id), content);

        await markSent(row, (result.message_id as string) ?? null);
        if (row.send_type === "private_reply") quota--;
        sent++;
      } catch (err) {
        console.error(`send_queue ${row.id} failed:`, err);
        await markFailure(row, err);
      }
    }

    return json({ sent, held, expired, private_replies_left: quota });
  } catch (err) {
    console.error("send-worker failed:", err);
    return json({ error: String(err) }, 500);
  }
});
