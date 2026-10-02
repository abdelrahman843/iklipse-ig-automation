// Drains send_queue without ever sending like a bot. Runs every minute from pg_cron and the moment
// a row is queued.
//
// The limits live in the send_guard row (migration 24) and claim_send_batch() applies them while
// claiming, so a row past its budget is never even picked up:
//   reactive       a reply to something the contact just did      30/min, 600/h
//   private_reply  the one DM a comment allows                     12/min (ManyChat's own cap), 720/h
//   public_reply   a reply posted under a comment                  2/min, 30/h; off for a day when a
//                                                                  post goes viral (send_guard_tick)
//   proactive      broadcasts and sequence messages                4/min, 200/h
//   per contact    25 messages an hour
// Replies to someone waiting go out at once; everything else is spaced a few seconds apart.
//
// Circuit breaker: Meta answering "rate limited" or "blocked", the access token dying, or Meta's
// own usage headers passing 80% stops ALL sending for a while (send_guard.paused_until). Retrying
// through a block is what gets accounts disabled.

import { db, json } from "../_shared/db.ts";
import { MetaError, replyToComment, sendDirectMessage, sendPrivateReply, usagePressure } from "../_shared/meta.ts";
import type { MessageContent } from "../_shared/types.ts";
import { requireService } from "../_shared/auth.ts";

type Row = Record<string, any>;
const sql = db();

const MAX_ATTEMPTS = 6;
const HOUR_MS = 60 * 60 * 1000;
/** How long each breaker reason stops every send. */
const PAUSE_MINUTES = { rate: 60, blocked: 24 * 60, auth: 30 } as const;
/** Meta's usage headers past this share of the quota stop sending before Meta has to. */
const USAGE_PAUSE_PERCENT = 80;

/** 1m, 2m, 4m, 8m, 16m, capped at an hour. */
function backoffMs(attempts: number): number {
  return Math.min(60_000 * 2 ** (attempts - 1), HOUR_MS);
}

/** 1.5 to 4 seconds between sends nobody is waiting on, so a batch never lands as one burst. */
function gapMs(): number {
  return 1500 + Math.random() * 2500;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const isReactive = (row: Row) => row.send_type === "dm" && !row.proactive;

async function expireStale(): Promise<number> {
  const { data } = await sql
    .from("send_queue")
    .update({ status: "expired", error: "Expired before it could be sent" })
    .eq("status", "pending")
    .lt("expires_at", new Date().toISOString())
    .select("id");
  return data?.length ?? 0;
}

async function pause(minutes: number, reason: string): Promise<void> {
  console.warn(`sending paused for ${minutes} min: ${reason}`);
  const { error } = await sql.rpc("pause_sending", { p_minutes: Math.ceil(minutes), p_reason: reason });
  if (error) console.error("pause_sending failed:", error.message);
}

/** Hand claimed rows back untouched; they go out once the pause ends. */
async function release(rows: Row[]): Promise<void> {
  if (!rows.length) return;
  await sql.from("send_queue").update({ status: "pending" }).in("id", rows.map((r) => r.id));
}

function deliver(row: Row, igsid: string | undefined): Promise<Record<string, unknown>> {
  const content = (row.payload ?? {}) as MessageContent;
  if (row.send_type === "private_reply") return sendPrivateReply(row.comment_id, content);
  if (row.send_type === "public_reply") return replyToComment(row.comment_id, String(content.text ?? ""));
  if (!igsid) throw new Error("Contact has no Instagram id");
  return sendDirectMessage(igsid, content);
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

  // A reply under a comment is public, not part of the DM thread.
  if (row.send_type === "public_reply") return;
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
    // A reply under a comment is a side note: the DM conversation goes on without it.
    if (row.flow_run_id && row.send_type !== "public_reply") {
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

const BREAKER_REASON = {
  rate: "Meta rate-limited the account",
  blocked: "Meta blocked the account from this action",
  auth: "Instagram access stopped working; reconnect the account",
} as const;

Deno.serve(async (req) => {
  const denied = requireService(req);
  if (denied) return denied;
  try {
    const expired = await expireStale();

    // Viral switch first, so a claim never picks up a reply under a comment it just turned off.
    const { error: tickErr } = await sql.rpc("send_guard_tick");
    if (tickErr) throw new Error(`send_guard_tick failed: ${tickErr.message}`);

    const { data: claimed, error } = await sql.rpc("claim_send_batch");
    if (error) throw new Error(`claim_send_batch failed: ${error.message}`);
    const claimedRows = (claimed ?? []) as Row[];
    // People waiting on a reply first.
    const rows = [...claimedRows.filter(isReactive), ...claimedRows.filter((r) => !isReactive(r))];

    // The claim returns plain rows; look up each contact's igsid in one read.
    const ids = [...new Set(rows.map((r) => r.contact_id))];
    const { data: contacts } = ids.length
      ? await sql.from("contact").select("id, igsid").in("id", ids)
      : { data: [] as Row[] };
    const igsidOf = new Map((contacts ?? []).map((c: Row) => [c.id, c.igsid]));

    let sent = 0;
    let stopped: string | null = null;

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (i > 0 && !isReactive(row)) await sleep(gapMs());

      try {
        const result = await deliver(row, igsidOf.get(row.contact_id));
        await markSent(row, ((result.message_id ?? result.id) as string) ?? null);
        sent++;
      } catch (err) {
        const breaker = err instanceof MetaError ? err.breaker : null;
        if (breaker) {
          stopped = `${BREAKER_REASON[breaker]}: ${(err as Error).message}`;
          await pause(PAUSE_MINUTES[breaker], stopped);
          if (breaker === "auth") {
            await sql.from("ig_account").update({ status: "needs_reconnect" }).eq("status", "connected");
          }
          await release(rows.slice(i));
          break;
        }
        console.error(`send_queue ${row.id} failed:`, err);
        await markFailure(row, err);
      }

      const pressure = usagePressure();
      if (pressure && pressure.percent >= USAGE_PAUSE_PERCENT) {
        stopped = `Meta reports ${pressure.percent}% of the call quota used`;
        await pause(Math.max(15, pressure.regainMinutes), stopped);
        await release(rows.slice(i + 1));
        break;
      }
    }

    return json({ sent, claimed: rows.length, expired, stopped });
  } catch (err) {
    console.error("send-worker failed:", err);
    return json({ error: String(err) }, 500);
  }
});
