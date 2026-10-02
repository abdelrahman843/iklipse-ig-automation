// What broadcasts and sequence messages store, and how they turn into sends.
//
// A broadcast or a sequence message holds either its own message blocks (built in the panel's
// basic builder) or an existing automation to run. Blocks go straight to send_queue, one row per
// bubble; an automation starts a flow run that the engine (process-events) walks like any other.

import type { MessageContent } from "./types.ts";

type Db = ReturnType<typeof import("./db.ts").db>;
type Row = Record<string, any>;

/** Stored content: `blocks` is the current shape; older rows are a single MessageContent. */
export interface StoredContent extends MessageContent {
  blocks?: MessageContent[];
}

/**
 * An audience condition. All of a broadcast's conditions must hold (ManyChat's "all of"). The
 * database function contact_matches (migration 23) is the one place they are evaluated.
 */
export interface AudienceCondition {
  field: string;
  op: string;
  value?: string;
  key?: string;
}

export function hasBody(c: MessageContent | null | undefined): boolean {
  return Boolean(
    c && (c.text?.trim() || c.imageUrl || c.attachment?.url || c.buttons?.length || c.cards?.length),
  );
}

/**
 * The bubbles to send, in order. An older row kept text and an image in one message, and
 * Instagram sends an image without its text, so that becomes two bubbles.
 */
export function bubbles(content: StoredContent | null | undefined): MessageContent[] {
  if (!content) return [];
  if (Array.isArray(content.blocks)) return content.blocks.filter(hasBody);
  const out: MessageContent[] = [];
  if (content.text?.trim()) out.push({ text: content.text, buttons: content.buttons });
  if (content.imageUrl) out.push({ imageUrl: content.imageUrl });
  if (content.cards?.length) out.push({ cards: content.cards });
  return out;
}

/**
 * Start an automation for a contact. The run is parked as a due delay on the flow's first step,
 * so process-events picks it up on its next pass and executes it with the normal engine.
 * Returns false when the contact is already inside another run (one run per contact at a time).
 */
export async function queueFlowRun(sql: Db, flow: Row, contactId: string, state: Row): Promise<boolean> {
  const start = flow?.graph?.start;
  if (!start) return false;
  const { error } = await sql.from("flow_run").insert({
    flow_id: flow.id,
    contact_id: contactId,
    status: "waiting_delay",
    resume_at: new Date().toISOString(),
    current_node_id: start,
    state,
  });
  if (!error) return true;
  if (error.code === "23505") return false;
  throw new Error(`flow_run insert failed: ${error.message}`);
}

/** Wake process-events now (through pg_net, the path that reliably lands) instead of next minute. */
export async function wakeEngine(sql: Db): Promise<void> {
  const { error } = await sql.rpc("kick_edge", { fn: "process-events" });
  if (error) console.error("kick_edge(process-events) failed:", error.message);
}

// ---- send windows ("send between 08:00 and 22:00, Mon-Fri") --------------------------------

export interface SendWindow {
  from: string; // "08:00"
  to: string; // "22:00"
  days?: number[]; // ISO weekdays, 1 = Monday ... 7 = Sunday; empty or missing = every day
  tz?: string; // IANA zone the times are in
}

const WEEKDAY: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

function minutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
}

function inside(w: SendWindow, at: Date): boolean {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone: w.tz || "UTC",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(at);
  } catch {
    return true; // an unknown zone must not hold messages forever
  }
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const day = WEEKDAY[get("weekday")] ?? 1;
  if (w.days?.length && !w.days.includes(day)) return false;
  const now = Number(get("hour")) * 60 + Number(get("minute"));
  const from = minutes(w.from);
  const to = minutes(w.to);
  if (from === to) return true;
  return from < to ? now >= from && now < to : now >= from || now < to; // overnight windows wrap
}

/** The first moment at or after `from` that falls inside the window (5-minute precision). */
export function nextOpening(w: SendWindow | null | undefined, from: Date): Date {
  if (!w?.from || !w?.to) return from;
  const step = 5 * 60 * 1000;
  for (let t = from.getTime(), end = t + 8 * 86400_000; t < end; t += step) {
    if (inside(w, new Date(t))) return new Date(t);
  }
  return from; // no day selected at all: do not block forever
}
