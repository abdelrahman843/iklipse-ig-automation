// Walks each active sequence subscription through its messages. Runs every minute from pg_cron.
//
// For every subscription whose next_send_at has passed:
//   - a message that is switched off is skipped;
//   - a message with a send window ("between 08:00 and 22:00, Mon-Fri") waits for the window;
//   - otherwise it is sent (only if the 24-hour messaging window is open — Instagram forbids DMs
//     outside it), as its own blocks or by starting its automation;
// then the subscription moves to the next message, or is marked done when the messages run out.
// A contact who opted out is taken off the sequence.

import { db, json } from "../_shared/db.ts";
import { WINDOW_MS } from "../_shared/types.ts";
import { requireService } from "../_shared/auth.ts";
import {
  bubbles,
  nextOpening,
  queueFlowRun,
  type SendWindow,
  type StoredContent,
  wakeEngine,
} from "../_shared/content.ts";

type Row = Record<string, any>;
const sql = db();

const BATCH = 100;
/** A contact busy inside another automation is retried this much later. */
const BUSY_RETRY_MS = 10 * 60 * 1000;

function windowOpen(contact: Row): boolean {
  if (!contact?.last_interaction_at) return false;
  return Date.now() - new Date(contact.last_interaction_at).getTime() < WINDOW_MS;
}

Deno.serve(async (req) => {
  const denied = requireService(req);
  if (denied) return denied;
  try {
    const nowIso = new Date().toISOString();
    const { data: due, error } = await sql
      .from("sequence_subscription")
      .select("*")
      .eq("status", "active")
      .lte("next_send_at", nowIso)
      .limit(BATCH);
    if (error) throw error;

    const counts = { sent: 0, skipped: 0, waiting: 0, finished: 0, flows: 0 };

    // A deleted sequence leaves its subscribers where they are (the cascade removes them).
    const seqIds = [...new Set((due ?? []).map((s: Row) => s.sequence_id))];
    const { data: seqs } = seqIds.length
      ? await sql.from("sequence").select("id, status").in("id", seqIds)
      : { data: [] as Row[] };
    const running = new Set((seqs ?? []).filter((q: Row) => q.status === "active").map((q: Row) => q.id));

    const stepsBySeq = new Map<string, Row[]>();
    async function stepsOf(sequenceId: string): Promise<Row[]> {
      if (!stepsBySeq.has(sequenceId)) {
        const { data } = await sql
          .from("sequence_step")
          .select("*")
          .eq("sequence_id", sequenceId)
          .order("sort", { ascending: true });
        stepsBySeq.set(sequenceId, data ?? []);
      }
      return stepsBySeq.get(sequenceId)!;
    }

    for (const sub of due ?? []) {
      if (!running.has(sub.sequence_id)) continue;
      const list = await stepsOf(sub.sequence_id);
      const step = list[sub.step];
      if (!step) {
        await sql.from("sequence_subscription").update({ status: "done" }).eq("id", sub.id);
        counts.finished++;
        continue;
      }

      // Hold a message until its send window opens; nothing advances meanwhile.
      if (step.active && step.send_window) {
        const opens = nextOpening(step.send_window as SendWindow, new Date());
        if (opens.getTime() > Date.now() + 60_000) {
          await sql
            .from("sequence_subscription")
            .update({ next_send_at: opens.toISOString() })
            .eq("id", sub.id)
            .eq("step", sub.step);
          counts.waiting++;
          continue;
        }
      }

      // Claim this message before sending: advance only if nobody else already did, so
      // overlapping runs (cron + a slow previous tick) can't both send it.
      const nextIndex = sub.step + 1;
      const nextStep = list[nextIndex];
      const { data: claimed } = await sql
        .from("sequence_subscription")
        .update(
          nextStep
            ? {
                step: nextIndex,
                next_send_at: new Date(Date.now() + (nextStep.delay_seconds ?? 86400) * 1000).toISOString(),
              }
            : { status: "done", step: nextIndex },
        )
        .eq("id", sub.id)
        .eq("step", sub.step)
        .eq("status", "active")
        .select("id");
      if (!claimed?.length) continue;
      if (!nextStep) counts.finished++;

      if (!step.active) {
        counts.skipped++;
        continue;
      }

      const { data: contact } = await sql.from("contact").select("*").eq("id", sub.contact_id).single();
      if (!contact) continue;
      if (contact.opted_out_at) {
        await sql.from("sequence_subscription").update({ status: "cancelled" }).eq("id", sub.id);
        continue;
      }
      // Outside the window the message is skipped but the drip keeps its schedule.
      if (!windowOpen(contact)) {
        counts.skipped++;
        continue;
      }

      if (step.flow_id) {
        const { data: flow } = await sql
          .from("flow")
          .select("id, graph")
          .eq("id", step.flow_id)
          .is("deleted_at", null)
          .maybeSingle();
        const started = flow ? await queueFlowRun(sql, flow, contact.id, { sequence_step_id: step.id }) : false;
        if (started) {
          counts.flows++;
        } else if (flow) {
          // Busy in another automation: put this message back and try again shortly.
          await sql
            .from("sequence_subscription")
            .update({ step: sub.step, status: "active", next_send_at: new Date(Date.now() + BUSY_RETRY_MS).toISOString() })
            .eq("id", sub.id)
            .eq("step", nextIndex);
        }
        continue;
      }

      const expires = new Date(new Date(contact.last_interaction_at).getTime() + WINDOW_MS).toISOString();
      for (const payload of bubbles(step.content as StoredContent)) {
        const { error: qErr } = await sql.from("send_queue").insert({
          contact_id: contact.id,
          flow_run_id: null,
          send_type: "dm",
          comment_id: null,
          payload,
          sequence_step_id: step.id,
          expires_at: expires,
        });
        if (qErr) {
          console.error(`sequence step ${step.id}: send_queue insert failed:`, qErr.message);
          break;
        }
      }
      counts.sent++;
    }

    if (counts.flows > 0) await wakeEngine(sql);
    return json({ ...counts, due: due?.length ?? 0 });
  } catch (err) {
    console.error("sequence-worker failed:", err);
    return json({ error: String(err) }, 500);
  }
});
