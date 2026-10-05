// Reads the raw webhook log, matches triggers, and runs the execution engine.
//
// Called straight from ig-webhook the moment an event lands, and every minute by pg_cron as the
// safety net for delays, reply timeouts and anything the direct call missed. Both paths can run
// at once, so every row is claimed before it is worked on.

import { db, json } from "../_shared/db.ts";
import { fetchFollowState, fetchProfile, listMedia, MetaError } from "../_shared/meta.ts";
import { kick } from "../_shared/invoke.ts";
import { requireService } from "../_shared/auth.ts";
import { LIVE_REPLY_TTL_MS, PRIVATE_REPLY_TTL_MS, WINDOW_MS } from "../_shared/types.ts";
import type { FlowGraph, FlowNode, InputType, MessageContent } from "../_shared/types.ts";
import { validateInput } from "../_shared/validate.ts";
import { itemsFromEntry, matchTrigger } from "../_shared/triggers/registry.ts";
import { isInbound, readRef, type RawItem, type TriggerHit } from "../_shared/triggers/registry.ts";

type Row = Record<string, any>;
const sql = db();

const EVENT_BATCH = 50;
const MAX_STEPS = 50; // a graph that loops forever should stop, not spin
// A loop through a delay resets MAX_STEPS on every resume, so cap what one run can actually send.
const MAX_SENDS_PER_RUN = 20;
// go_to_flow chains flows; a flow that jumps back to an earlier one must not bounce forever.
const MAX_FLOW_HOPS = 5;
const HTTP_MAX_BYTES = 256 * 1024;
const SKIP_PAYLOAD = "__SKIP__";
// An answer under a comment hours later reads as a bot catching up; past this it is dropped.
const PUBLIC_REPLY_TTL_MS = 2 * 60 * 60 * 1000;
// A person answering a comment takes a moment; an answer in the same second reads as a bot
// (Manychat suggests a short Smart Delay before the first message). Random within these ranges.
const PRIVATE_REPLY_PAUSE_MS: [number, number] = [4_000, 12_000];
const PUBLIC_REPLY_PAUSE_MS: [number, number] = [10_000, 40_000];

function after([min, max]: [number, number]): string {
  return new Date(Date.now() + min + Math.random() * (max - min)).toISOString();
}

let queued = 0; // sends enqueued during this invocation, so we know whether to wake the sender

// ---------------------------------------------------------------- contacts

async function upsertContact(igsid: string, username?: string, touchWindow = false): Promise<Row> {
  const patch: Row = { igsid };
  if (username) patch.username = username;
  // A comment does not open the messaging window. Only a reply or a button tap does.
  if (touchWindow) patch.last_interaction_at = new Date().toISOString();

  const { data, error } = await sql
    .from("contact")
    .upsert(patch, { onConflict: "igsid" })
    .select()
    .single();
  if (error) throw new Error(`contact upsert failed: ${error.message}`);
  return data;
}

// Live Chat shows the contact's Instagram name and picture; refresh them every few days.
const PROFILE_TTL_MS = 3 * 24 * 60 * 60 * 1000;

// One per contact per invocation, finished before the invocation returns.
let profileFetches = new Map<string, Promise<void>>();

/** A new message: the conversation shows as unread, and a closed one opens again. */
async function markIncoming(contact: Row): Promise<void> {
  const { error } = await sql.from("contact").update({ unread: true, status: "open" }).eq("id", contact.id);
  if (error) console.warn("contact update failed:", error.message);
  const stale =
    !contact.profile_checked_at || Date.now() - new Date(contact.profile_checked_at).getTime() > PROFILE_TTL_MS;
  // Off the reply path: the automation answers first, the profile lands alongside.
  if (stale && !profileFetches.has(contact.id)) profileFetches.set(contact.id, refreshProfile(contact));
}

async function refreshProfile(contact: Row): Promise<void> {
  const now = new Date().toISOString();
  const patch: Row = { profile_checked_at: now };
  try {
    const p = await fetchProfile(contact.igsid);
    if (p.name) patch.name = p.name;
    if (p.username) patch.username = p.username;
    if (p.profile_pic) patch.profile_pic = p.profile_pic;
    patch.follows_account = p.follows;
    patch.follows_checked_at = now;
  } catch (err) {
    // Best effort: the chat works without a picture. Retried after the TTL, not on every message.
    console.warn("profile fetch failed:", err instanceof Error ? err.message : err);
  }
  await sql.from("contact").update(patch).eq("id", contact.id);
}

/** Contacts who wrote before profiles were fetched get theirs a few at a time, once each. */
async function backfillProfiles(): Promise<void> {
  const { data } = await sql
    .from("contact")
    .select("id, igsid, profile_checked_at")
    .is("profile_checked_at", null)
    .gte("last_interaction_at", new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString())
    .limit(3);
  for (const c of data ?? []) {
    if (!profileFetches.has(c.id)) profileFetches.set(c.id, refreshProfile(c));
  }
}

function windowOpen(contact: Row): boolean {
  if (!contact.last_interaction_at) return false;
  return Date.now() - new Date(contact.last_interaction_at).getTime() < WINDOW_MS;
}

// ---------------------------------------------------------------- triggers
//
// Which flow a webhook fires is decided entirely by the trigger registry (_shared/triggers).
// This file only does the plumbing around it: upsert the contact, resume a waiting run, or open
// a new one. Adding a trigger never touches this file.

/** Store an ig.me ref on the contact for campaign attribution. */
async function storeRef(contact: Row, ref: string): Promise<void> {
  const fields = { ...(contact.custom_fields ?? {}), ref, ref_at: new Date().toISOString() };
  await sql.from("contact").update({ custom_fields: fields }).eq("id", contact.id);
}

// ---------------------------------------------------------------- Instagram settings
//
// Conversation starters and menu items carry "FLOW:<id>": a tap runs that automation. The
// Opt-in / Opt-out system keywords ("start" / "stop") take a contact out of broadcasts and
// sequences, or back in. Both are global: they cut in ahead of a run that waits for a reply.

const FLOW_PAYLOAD = "FLOW:";
const WAITING = ["waiting_input", "waiting_delay"];

let optSettings: Row | null | undefined; // read once per invocation

async function optConfig(): Promise<Row | null> {
  if (optSettings === undefined) {
    const { data } = await sql.from("messenger_profile").select("opt_in, opt_out").eq("id", 1).maybeSingle();
    optSettings = data ?? null;
  }
  return optSettings;
}

/** A starter or menu tap: drop what the contact was waiting in and run that automation. */
async function handleFlowTap(payload: string, contact: Row): Promise<boolean> {
  if (!payload.startsWith(FLOW_PAYLOAD)) return false;
  const { data: flow } = await sql
    .from("flow")
    .select()
    .eq("id", payload.slice(FLOW_PAYLOAD.length))
    .is("deleted_at", null)
    .maybeSingle();
  if (!flow) return true; // its automation was deleted or trashed: swallow the tap, don't keyword-match "FLOW:…"
  await sql
    .from("flow_run")
    .update({ status: "cancelled", resume_at: null })
    .eq("contact_id", contact.id)
    .in("status", WAITING);
  if (await activeRun(contact.id)) return true; // a step is executing this instant; it can't be cut
  await startRun(flow, contact, {});
  return true;
}

/** "stop" / "start" and friends. Returns true when the message was one of them. */
async function handleOptKeyword(text: string, contact: Row): Promise<boolean> {
  const word = text.trim().toLowerCase();
  if (!word || word.length > 40) return false;
  const cfg = await optConfig();
  const said = (o: Row | undefined) =>
    Boolean(o?.enabled) && (o?.keywords ?? []).some((k: string) => k.trim().toLowerCase() === word);
  const out = said(cfg?.opt_out);
  if (!out && !said(cfg?.opt_in)) return false;

  await sql.from("contact").update({ opted_out_at: out ? new Date().toISOString() : null }).eq("id", contact.id);
  if (out) {
    await sql
      .from("sequence_subscription")
      .update({ status: "cancelled" })
      .eq("contact_id", contact.id)
      .eq("status", "active");
    await sql
      .from("flow_run")
      .update({ status: "cancelled", resume_at: null })
      .eq("contact_id", contact.id)
      .in("status", WAITING);
  }
  const reply = String((out ? cfg?.opt_out : cfg?.opt_in)?.reply ?? "").trim();
  if (reply) {
    const { error } = await sql.from("send_queue").insert({
      contact_id: contact.id,
      flow_run_id: null,
      send_type: "dm",
      comment_id: null,
      payload: { text: reply },
      expires_at: new Date(Date.now() + WINDOW_MS).toISOString(),
    });
    if (error) console.error("opt reply insert failed:", error.message);
    else queued++;
  }
  return true;
}

async function activeRun(contactId: string): Promise<Row | null> {
  const { data } = await sql
    .from("flow_run")
    .select()
    .eq("contact_id", contactId)
    .in("status", ["running", "waiting_input", "waiting_delay"])
    .order("created_at", { ascending: false })
    .limit(1);
  return data?.[0] ?? null;
}

// ---------------------------------------------------------------- engine

async function enqueue(
  run: Row,
  contact: Row,
  content: MessageContent,
  kind: "private_reply" | "dm",
): Promise<void> {
  // A bubble left empty in the builder has nothing to deliver; Meta would reject it anyway.
  const hasBody = Boolean(
    content.text?.trim() || content.imageUrl || content.attachment?.url ||
      content.buttons?.length || content.cards?.length || content.quickReplies?.length,
  );
  if (!hasBody) return;
  // Instagram sends an image attachment without its text, so a bubble holding both goes out as
  // two: the words first, then the image. (A private reply is a single message; it keeps one.)
  if (kind === "dm" && content.imageUrl && (content.text?.trim() || content.buttons?.length) && !content.cards?.length) {
    const { imageUrl, ...words } = content;
    await enqueue(run, contact, words, kind);
    await enqueue(run, contact, { imageUrl }, kind);
    return;
  }
  const commentAt = run.state?.comment_at ? new Date(run.state.comment_at).getTime() : Date.now();
  const windowEnds = new Date(contact.last_interaction_at ?? Date.now()).getTime() + WINDOW_MS;
  // A live-comment reply is only valid while the broadcast runs, so it expires in minutes.
  const replyTtl = run.state?.live ? LIVE_REPLY_TTL_MS : PRIVATE_REPLY_TTL_MS;

  const { error } = await sql.from("send_queue").insert({
    contact_id: contact.id,
    flow_run_id: run.id,
    send_type: kind,
    comment_id: kind === "private_reply" ? run.state?.comment_id ?? null : null,
    payload: content,
    // A run started by a broadcast or a sequence message credits its sends to it (stats).
    broadcast_id: run.state?.broadcast_id ?? null,
    sequence_step_id: run.state?.sequence_step_id ?? null,
    // ...and draws on the slower proactive budget, until the contact answers: from then on it is
    // a conversation they are waiting on.
    proactive: Boolean(run.state?.broadcast_id || run.state?.sequence_step_id) && !answeredSince(contact, run),
    expires_at:
      kind === "private_reply"
        ? new Date(commentAt + replyTtl).toISOString()
        : new Date(windowEnds).toISOString(),
    // A live comment is answered at once: the reply is only valid while the broadcast runs.
    ...(kind === "private_reply" && !run.state?.live ? { next_attempt_at: after(PRIVATE_REPLY_PAUSE_MS) } : {}),
  });
  if (error) throw new Error(`send_queue insert failed: ${error.message}`);
  queued++;
}

/** True when the contact messaged or tapped after this run began. */
function answeredSince(contact: Row, run: Row): boolean {
  if (!contact.last_interaction_at || !run.created_at) return false;
  return new Date(contact.last_interaction_at).getTime() > new Date(run.created_at).getTime();
}

/** Which channel the next outbound must use, or null if the window has closed. */
function sendKind(state: Row, contact: Row): "private_reply" | "dm" | null {
  if (Boolean(state.comment_id) && !state.private_reply_sent) return "private_reply";
  if (windowOpen(contact)) return "dm";
  return null;
}

async function saveRun(runId: string, patch: Row): Promise<void> {
  const { error } = await sql.from("flow_run").update(patch).eq("id", runId);
  if (error) throw new Error(`flow_run update failed: ${error.message}`);
}

/** Store a collected value on the contact, typed, and register the field for the UI to list. */
async function saveCustomField(
  contact: Row,
  key: string,
  value: string | number,
  type: InputType,
): Promise<void> {
  const fields: Row = { ...(contact.custom_fields ?? {}), [key]: value };
  // Email consent, so a later export can prove opt-in.
  if (type === "email") {
    fields[`${key}_opt_in`] = true;
    fields[`${key}_opt_in_at`] = new Date().toISOString();
  }
  await sql.from("contact").update({ custom_fields: fields }).eq("id", contact.id);
  await sql.from("custom_field").upsert({ key, type }, { onConflict: "key" });
}

/** Choice options plus an optional Skip, as Instagram quick replies. */
function buildQuicks(node: FlowNode): { title: string; payload: string }[] {
  const q: { title: string; payload: string }[] = [];
  if (node.inputType === "choice") {
    for (const o of node.quickReplies ?? []) q.push({ title: o, payload: o });
  }
  if (node.skipEnabled) q.push({ title: node.skipTitle || "Skip", payload: SKIP_PAYLOAD });
  return q;
}

let botFields: Record<string, string> = {}; // read once per invocation; {{bot.key}}

async function loadBotFields(): Promise<void> {
  const { data } = await sql.from("bot_field").select("key, value");
  botFields = Object.fromEntries((data ?? []).map((f: Row) => [f.key, f.value]));
}

function readPath(path: string, state: Row, contact: Row): unknown {
  const [scope, ...rest] = path.split(".");
  const key = rest.join(".");
  if (scope === "state") return state?.[key];
  if (scope === "bot") return botFields[key];
  // {{contact.username}} reads the contact; {{contact.city}} falls through to a custom field.
  if (scope === "contact") return contact?.[key] ?? contact?.custom_fields?.[key];
  return undefined;
}

function evaluate(node: FlowNode, state: Row, contact: Row): boolean {
  const right = node.right ?? "";
  // Tag tests read the contact's tag array, not a path value.
  if (node.op === "has_tag" || node.op === "not_has_tag") {
    const tags: string[] = Array.isArray(contact.tags) ? contact.tags : [];
    const has = tags.some((t) => t.toLowerCase() === right.toLowerCase());
    return node.op === "has_tag" ? has : !has;
  }
  const left = readPath(node.left ?? "", state, contact);
  switch (node.op) {
    case "exists":
      return left !== undefined && left !== null && String(left).length > 0;
    case "neq":
      return String(left ?? "").toLowerCase() !== right.toLowerCase();
    case "contains":
      return String(left ?? "").toLowerCase().includes(right.toLowerCase());
    case "gt":
      return Number(left) > Number(right);
    case "lt":
      return Number(left) < Number(right);
    case "eq":
    default:
      return String(left ?? "").toLowerCase() === right.toLowerCase();
  }
}

/**
 * Replace {{state.x}} / {{contact.y}} tokens in a string with their runtime values.
 * `encode` escapes each value for where it lands (a URL, a JSON body), because contact replies
 * flow into these values and must not be able to rewrite the surrounding request.
 */
function interpolate(tpl: string, state: Row, contact: Row, encode: (v: string) => string = (v) => v): string {
  return tpl.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, path: string) => {
    const v = readPath(path, state, contact);
    return v === undefined || v === null ? "" : encode(String(v));
  });
}

/** A value spliced inside a JSON string literal: escape it, drop the surrounding quotes. */
const jsonInner = (v: string) => JSON.stringify(v).slice(1, -1);

/** Pick a randomize branch key by weight. Falls back to the first branch. */
function pickBranch(node: FlowNode): string | null {
  const branches = node.branches ?? [];
  if (!branches.length) return null;
  const total = branches.reduce((s, b) => s + Math.max(0, b.weight || 0), 0);
  if (total <= 0) return branches[0].key;
  let r = Math.random() * total;
  for (const b of branches) {
    r -= Math.max(0, b.weight || 0);
    if (r < 0) return b.key;
  }
  return branches[branches.length - 1].key;
}

/**
 * Apply an Action node's list of side effects to the contact. Best-effort per action. Returns
 * false when an action deleted the contact: the run is gone with it and must stop.
 */
async function runActions(node: FlowNode, state: Row, contact: Row, run: Row): Promise<boolean> {
  for (const a of node.actions ?? []) {
    try {
      switch (a.kind) {
        case "add_tag":
          if (a.tag) await sql.rpc("add_contact_tag", { p_contact: contact.id, p_tag: a.tag });
          break;
        case "remove_tag":
          if (a.tag) await sql.rpc("remove_contact_tag", { p_contact: contact.id, p_tag: a.tag });
          break;
        case "set_field": {
          if (!a.field) break;
          const value = interpolate(a.value ?? "", state, contact);
          const fields = { ...(contact.custom_fields ?? {}), [a.field]: value };
          await sql.from("contact").update({ custom_fields: fields }).eq("id", contact.id);
          await sql.from("custom_field").upsert({ key: a.field, type: "text" }, { onConflict: "key" });
          break;
        }
        case "clear_field": {
          if (!a.field) break;
          const fields = { ...(contact.custom_fields ?? {}) };
          delete fields[a.field];
          await sql.from("contact").update({ custom_fields: fields }).eq("id", contact.id);
          break;
        }
        case "assign":
          await sql.from("contact").update({ assigned_to: a.assignee ?? null }).eq("id", contact.id);
          break;
        case "mark_done":
          await sql.from("contact").update({ status: "done" }).eq("id", contact.id);
          break;
        case "mark_open":
          await sql.from("contact").update({ status: "open" }).eq("id", contact.id);
          break;
        case "opt_in":
          await sql.from("contact").update({ opted_out_at: null }).eq("id", contact.id);
          break;
        case "opt_out":
          // Same as the contact typing an opt-out word: no more broadcasts or sequence messages.
          await sql.from("contact").update({ opted_out_at: new Date().toISOString() }).eq("id", contact.id);
          await sql
            .from("sequence_subscription")
            .update({ status: "cancelled" })
            .eq("contact_id", contact.id)
            .eq("status", "active");
          break;
        case "set_bot_field": {
          if (!a.field) break;
          const value = interpolate(a.value ?? "", state, contact);
          await sql.from("bot_field").upsert({ key: a.field, value, updated_at: new Date().toISOString() }, { onConflict: "key" });
          botFields[a.field] = value;
          break;
        }
        case "log_conversion": {
          const amount = Number(interpolate(a.value ?? "", state, contact));
          await sql.from("conversion_event").insert({
            contact_id: contact.id,
            flow_id: run.flow_id ?? null,
            name: (a.event ?? "").trim() || "conversion",
            value: a.value?.trim() && Number.isFinite(amount) ? amount : null,
          });
          break;
        }
        case "delete_contact":
          // Messages, runs (this one too), notes and queued sends go with it.
          await sql.from("contact").delete().eq("id", contact.id);
          return false;
        case "notify":
          await sql.from("contact_note").insert({
            contact_id: contact.id,
            body: interpolate(a.message ?? "Flow notification", state, contact),
            author: "automation",
          });
          break;
        case "subscribe_sequence": {
          if (!a.sequenceId) break;
          // Start at step 0, due immediately; the sequence worker takes it from there.
          await sql.from("sequence_subscription").upsert(
            {
              sequence_id: a.sequenceId,
              contact_id: contact.id,
              step: 0,
              next_send_at: new Date().toISOString(),
              status: "active",
            },
            { onConflict: "sequence_id,contact_id" },
          );
          break;
        }
        case "unsubscribe_sequence": {
          if (!a.sequenceId) break;
          await sql
            .from("sequence_subscription")
            .update({ status: "cancelled" })
            .eq("sequence_id", a.sequenceId)
            .eq("contact_id", contact.id);
          break;
        }
      }
    } catch (err) {
      console.warn(`action ${a.kind} failed:`, err instanceof Error ? err.message : err);
    }
  }
  return true;
}

/** True for hosts an automation must never reach: loopback, private ranges, cloud metadata. */
function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || /\.(localhost|local|internal|lan|home|corp)$/.test(h)) return true;
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }
  if (h.includes(":")) {
    if (h === "::" || h === "::1") return true;
    if (/^(fc|fd|fe8|fe9|fea|feb)/.test(h)) return true;
    const mapped = h.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateHost(mapped[1]);
  }
  return false;
}

/** Refuse private targets, including a public name that resolves to a private address. */
async function assertPublicUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Invalid URL");
  }
  if (url.protocol !== "https:") throw new Error("URL must be https");
  if (isPrivateHost(url.hostname)) throw new Error("That host is not allowed");
  let ips: string[] = [];
  try {
    ips = [
      ...(await Deno.resolveDns(url.hostname, "A").catch(() => [] as string[])),
      ...(await Deno.resolveDns(url.hostname, "AAAA").catch(() => [] as string[])),
    ];
  } catch {
    // resolveDns unavailable in this runtime: the literal-host check above still applies.
  }
  if (ips.some(isPrivateHost)) throw new Error("That host is not allowed");
  return url;
}

/** Read at most `limit` bytes of a response body, then stop. */
async function readCapped(res: Response, limit: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel();
      throw new Error(`Response larger than ${Math.round(limit / 1024)} KB`);
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.length;
  }
  return new TextDecoder().decode(all);
}

/** Call an external API. Public https hosts only, no redirects, 10s timeout, 256 KB cap. */
async function runHttp(node: FlowNode, state: Row, contact: Row): Promise<unknown> {
  const url = await assertPublicUrl(interpolate(node.url ?? "", state, contact, encodeURIComponent));
  const headers: Record<string, string> = {};
  for (const h of node.headers ?? []) {
    // Header values cannot carry line breaks; strip them so a reply can't inject a header.
    if (h.key) headers[h.key] = interpolate(h.value ?? "", state, contact).replace(/[\r\n]/g, " ");
  }
  const method = node.method ?? "GET";
  const init: RequestInit = { method, headers, redirect: "manual" };
  if (method !== "GET" && node.body) {
    const ct = headers["Content-Type"] ?? headers["content-type"];
    if (!ct) headers["Content-Type"] = "application/json";
    const isJson = !ct || /json/i.test(ct);
    init.body = interpolate(node.body, state, contact, isJson ? jsonInner : (v) => v);
  }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 10_000);
  try {
    const res = await fetch(url, { ...init, signal: ctl.signal });
    if (res.status >= 300 && res.status < 400) throw new Error(`HTTP ${res.status} redirect not followed`);
    const text = await readCapped(res, HTTP_MAX_BYTES);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    try { return JSON.parse(text); } catch { return text; }
  } finally {
    clearTimeout(timer);
  }
}

/** When a smart delay should resume: a duration from now, or the next occurrence of HH:MM UTC. */
function smartResumeAt(node: FlowNode): number {
  if ((node.delayMode ?? "duration") === "duration") {
    return Date.now() + (node.seconds ?? 0) * 1000;
  }
  const now = new Date();
  const target = new Date(now);
  target.setUTCHours(node.untilHour ?? 9, node.untilMinute ?? 0, 0, 0);
  if (target.getTime() <= now.getTime()) target.setUTCDate(target.getUTCDate() + 1);
  return target.getTime();
}

/**
 * Count the sends a node is about to make against the run's cap. When the cap is hit the run is
 * failed (with a readable reason) and true is returned so the caller stops.
 */
async function overSendCap(runId: string, state: Row, count: number): Promise<boolean> {
  const sent = Number(state._sends ?? 0);
  if (sent + count > MAX_SENDS_PER_RUN) {
    await saveRun(runId, {
      status: "failed",
      state,
      error: `Stopped: this run tried to send more than ${MAX_SENDS_PER_RUN} messages. The flow probably loops.`,
    });
    return true;
  }
  state._sends = sent + count;
  return false;
}

/**
 * One loop, one run. Executes until a node pauses or the run ends.
 * Every pause writes its state before returning, so the next tick picks it up.
 */
async function executeRun(runId: string): Promise<void> {
  const { data: run } = await sql.from("flow_run").select().eq("id", runId).single();
  if (!run) return;

  const { data: flow } = await sql.from("flow").select().eq("id", run.flow_id).single();
  let { data: contact } = await sql.from("contact").select().eq("id", run.contact_id).single();
  if (!flow || !contact) return;

  const graph = (flow.graph ?? {}) as FlowGraph;
  const state: Row = { ...(run.state ?? {}) };
  let current: string | undefined | null = run.current_node_id ?? graph.start;

  for (let step = 0; step < MAX_STEPS; step++) {
    if (!current) {
      await saveRun(runId, { status: "done", state, current_node_id: null, resume_at: null });
      return;
    }

    const node = graph.nodes?.[current] as FlowNode | undefined;
    if (!node) {
      await saveRun(runId, {
        status: "failed",
        state,
        error: `Step "${current}" is missing from the graph`,
      });
      return;
    }

    // Count this contact as having reached this step, once per run — deduped in state so a loop
    // back or a resume never double-counts. Best-effort; a stats failure must not break the run.
    const visited = (state._visited ?? {}) as Record<string, boolean>;
    if (!visited[current]) {
      visited[current] = true;
      state._visited = visited;
      try {
        await sql.rpc("bump_node", { p_flow: run.flow_id, p_node: current });
      } catch (err) {
        console.error("bump_node failed:", err instanceof Error ? err.message : err);
      }
    }

    // A human agent just replied: hold automated sends until the pause ends, then continue.
    if (
      (node.type === "send_message" || node.type === "collect") &&
      contact.pause_until &&
      new Date(contact.pause_until).getTime() > Date.now()
    ) {
      await saveRun(runId, {
        status: "waiting_delay",
        state,
        current_node_id: current,
        resume_at: contact.pause_until,
      });
      return;
    }

    switch (node.type) {
      case "send_message": {
        const kind = sendKind(state, contact);
        if (!kind) {
          await saveRun(runId, {
            status: "blocked_window",
            state,
            current_node_id: current,
            error: "The 24-hour messaging window is closed for this contact",
          });
          return;
        }
        if (await overSendCap(runId, state, 1 + (node.extras?.length ?? 0))) return;
        {
          // Personalize text with {{state.x}} / {{contact.y}} tokens.
          const base = { ...(node.content ?? {}) };
          if (base.text) base.text = interpolate(base.text, state, contact);
          await enqueue({ ...run, state }, contact, base, kind);
          if (kind === "private_reply") state.private_reply_sent = true;

          // Additional bubbles: each sent as its own message, in order. A private reply is a single
          // message only, so extras can only go out as DMs once the window is open.
          for (const extra of node.extras ?? []) {
            const extraKind = sendKind(state, contact);
            if (extraKind !== "dm") break;
            const ex = { ...extra };
            if (ex.text) ex.text = interpolate(ex.text, state, contact);
            await enqueue({ ...run, state }, contact, ex, "dm");
          }
        }
        current = node.next;
        break;
      }

      case "action": {
        if (!(await runActions(node, state, contact, run))) return; // the contact was deleted
        // Re-read the contact so later nodes (condition on tag, etc.) see the mutations.
        const { data: fresh } = await sql.from("contact").select().eq("id", contact.id).single();
        if (fresh) contact = fresh;
        current = node.next;
        break;
      }

      case "randomize": {
        current = pickBranch(node) as string | undefined;
        break;
      }

      case "http_request": {
        try {
          const outcome = await runHttp(node, state, contact);
          state[node.saveTo ?? "response"] = outcome;
          current = node.next;
        } catch (err) {
          console.warn("http_request failed:", err instanceof Error ? err.message : err);
          state[`${node.saveTo ?? "response"}_error`] = String(err instanceof Error ? err.message : err);
          current = node.onError ?? node.next;
        }
        break;
      }

      case "smart_delay": {
        const resumeAt = smartResumeAt(node);
        const windowEnds = contact.last_interaction_at
          ? new Date(contact.last_interaction_at).getTime() + WINDOW_MS
          : 0;
        const privateReplyLeft = Boolean(state.comment_id) && !state.private_reply_sent;
        if (!privateReplyLeft && resumeAt > windowEnds) {
          await saveRun(runId, {
            status: "blocked_window",
            state,
            current_node_id: current,
            error: "This smart delay ends after the 24-hour window closes",
          });
          return;
        }
        await saveRun(runId, {
          status: "waiting_delay",
          state,
          current_node_id: node.next ?? null,
          resume_at: new Date(resumeAt).toISOString(),
        });
        return;
      }

      case "go_to_flow": {
        // Hand off: end this run, start a fresh run of the target flow carrying the same state.
        // The send counter travels with the state; the hop counter stops flows bouncing forever.
        await saveRun(runId, { status: "done", state, current_node_id: null, resume_at: null });
        const hops = Number(state._hops ?? 0) + 1;
        if (!node.targetFlowId || node.targetFlowId === flow.id || hops > MAX_FLOW_HOPS) {
          if (hops > MAX_FLOW_HOPS) console.warn(`go_to_flow stopped after ${MAX_FLOW_HOPS} hops (run ${runId})`);
          return;
        }
        const { data: target } = await sql.from("flow").select().eq("id", node.targetFlowId).maybeSingle();
        const targetGraph = (target?.graph ?? {}) as FlowGraph;
        if (!target || target.status !== "live" || !targetGraph.start) return;
        const { data: next, error: nextErr } = await sql
          .from("flow_run")
          .insert({
            flow_id: target.id,
            contact_id: contact.id,
            status: "running",
            current_node_id: targetGraph.start,
            state: { ...state, _visited: {}, _hops: hops },
          })
          .select("id")
          .single();
        if (nextErr) {
          console.error("go_to_flow insert failed:", nextErr.message);
          return;
        }
        await executeRun(next.id);
        return;
      }

      case "collect": {
        const kind = sendKind(state, contact);
        if (!kind) {
          await saveRun(runId, {
            status: "blocked_window",
            state,
            current_node_id: current,
            error: "The 24-hour messaging window is closed for this contact",
          });
          return;
        }

        if (await overSendCap(runId, state, 1)) return;
        const quicks = buildQuicks(node);
        const content: MessageContent = {
          text: node.promptText ?? "",
          quickReplies: quicks.length ? quicks : undefined,
        };
        await enqueue({ ...run, state }, contact, content, kind);
        if (kind === "private_reply") state.private_reply_sent = true;

        const timeoutSeconds = node.timeoutSeconds ?? 3600;
        state.collect = {
          saveTo: node.saveTo ?? "value",
          inputType: node.inputType ?? "text",
          choices: node.quickReplies ?? [],
          next: node.next ?? null,
          onTimeout: node.onTimeout ?? null,
          onFailed: node.onFailed ?? null,
          retryMessage: node.retryMessage ?? "That doesn't look right. Please try again.",
          maxAttempts: node.maxAttempts ?? 3,
          attempts: 0,
          skipPayload: node.skipEnabled ? SKIP_PAYLOAD : null,
          quicks,
          timeoutSeconds,
        };
        await saveRun(runId, {
          status: "waiting_input",
          state,
          current_node_id: current,
          resume_at: new Date(Date.now() + timeoutSeconds * 1000).toISOString(),
        });
        return;
      }

      case "wait_reply": {
        const timeoutSeconds = node.timeoutSeconds ?? 3600;
        state.wait = {
          saveTo: node.saveTo ?? "reply",
          next: node.next ?? null,
          onTimeout: node.onTimeout ?? null,
        };
        await saveRun(runId, {
          status: "waiting_input",
          state,
          current_node_id: current,
          resume_at: new Date(Date.now() + timeoutSeconds * 1000).toISOString(),
        });
        return;
      }

      case "check_follow": {
        // Meta rejects this call before the contact has messaged us. Treat a failure as
        // "not confirmed" and take the false branch rather than killing the run.
        let follows = false;
        try {
          const result = await fetchFollowState(contact.igsid);
          follows = result.follows;
          const { data: updated } = await sql
            .from("contact")
            .update({
              follows_account: result.follows,
              follows_checked_at: new Date().toISOString(),
              ...(result.username ? { username: result.username } : {}),
            })
            .eq("id", contact.id)
            .select()
            .single();
          if (updated) contact = updated;
        } catch (err) {
          const message = err instanceof MetaError ? err.message : String(err);
          console.warn(`check_follow failed for ${contact.igsid}: ${message}`);
        }
        current = follows ? node.onTrue : node.onFalse;
        break;
      }

      case "condition": {
        current = evaluate(node, state, contact) ? node.onTrue : node.onFalse;
        break;
      }

      case "delay": {
        const seconds = node.seconds ?? 0;
        const resumeAt = Date.now() + seconds * 1000;
        const windowEnds = contact.last_interaction_at
          ? new Date(contact.last_interaction_at).getTime() + WINDOW_MS
          : 0;
        const privateReplyLeft = Boolean(state.comment_id) && !state.private_reply_sent;

        // A delay that lands past the window sends nothing and reports no error. Refuse it here.
        if (!privateReplyLeft && resumeAt > windowEnds) {
          await saveRun(runId, {
            status: "blocked_window",
            state,
            current_node_id: current,
            error: `This delay ends after the 24-hour window closes (${seconds}s)`,
          });
          return;
        }

        await saveRun(runId, {
          status: "waiting_delay",
          state,
          current_node_id: node.next ?? null,
          resume_at: new Date(resumeAt).toISOString(),
        });
        return;
      }

      case "end":
      default: {
        await saveRun(runId, { status: "done", state, current_node_id: null, resume_at: null });
        return;
      }
    }
  }

  await saveRun(runId, {
    status: "failed",
    state,
    error: `Stopped after ${MAX_STEPS} steps. The graph probably loops.`,
  });
}

/** Start a run. Returns its id, or null when the contact already had one going. */
async function startRun(flow: Row, contact: Row, seed: Row): Promise<string | null> {
  const graph = (flow.graph ?? {}) as FlowGraph;
  const { data, error } = await sql
    .from("flow_run")
    .insert({
      flow_id: flow.id,
      contact_id: contact.id,
      current_node_id: graph.start,
      state: seed,
      status: "running",
    })
    .select()
    .single();
  if (error) {
    // The one-active-run-per-contact index: another event already started a run. Not an error.
    if (error.code === "23505") return null;
    throw new Error(`flow_run insert failed: ${error.message}`);
  }
  await executeRun(data.id);
  return data.id;
}

/** Claim a waiting run atomically. Returns true if this worker won it. */
async function claimWaiting(runId: string): Promise<boolean> {
  const { data } = await sql
    .from("flow_run")
    .update({ status: "running" })
    .eq("id", runId)
    .eq("status", "waiting_input")
    .select();
  return Boolean(data?.length);
}

/** A reply landed on a collect node: validate, and save / retry / give up / skip. */
async function resumeCollect(run: Row, text: string, contact: Row): Promise<void> {
  const c = run.state.collect as Row;
  const state = { ...(run.state ?? {}) };
  if (!(await claimWaiting(run.id))) return;

  // Skip button.
  if (c.skipPayload && text === c.skipPayload) {
    delete state.collect;
    await saveRun(run.id, { state, current_node_id: c.next ?? null, resume_at: null });
    await executeRun(run.id);
    return;
  }

  const { ok, value } = validateInput(c.inputType as InputType, text, c.choices ?? []);
  if (ok && value !== undefined) {
    await saveCustomField(contact, c.saveTo, value, c.inputType as InputType);
    state[c.saveTo] = value;
    delete state.collect;
    await saveRun(run.id, { state, current_node_id: c.next ?? null, resume_at: null });
    await executeRun(run.id);
    return;
  }

  const attempts = (c.attempts ?? 0) + 1;
  if (attempts >= (c.maxAttempts ?? 3)) {
    delete state.collect;
    await saveRun(run.id, { state, current_node_id: c.onFailed ?? null, resume_at: null });
    await executeRun(run.id);
    return;
  }

  // Invalid but attempts remain: re-ask, and stay on the node.
  state.collect = { ...c, attempts };
  const kind = sendKind(state, contact);
  if (kind) {
    const retry: MessageContent = {
      text: c.retryMessage ?? "That doesn't look right. Please try again.",
      quickReplies: c.quicks?.length ? c.quicks : undefined,
    };
    await enqueue({ ...run, state }, contact, retry, kind);
    if (kind === "private_reply") state.private_reply_sent = true;
  }
  await saveRun(run.id, {
    status: "waiting_input",
    state,
    current_node_id: run.current_node_id,
    resume_at: new Date(Date.now() + (c.timeoutSeconds ?? 3600) * 1000).toISOString(),
  });
}

async function resumeWithReply(run: Row, text: string, contact: Row): Promise<void> {
  // A collect node validates the reply; a plain wait just stores it.
  if (run.state?.collect) {
    await resumeCollect(run, text, contact);
    return;
  }

  const wait = run.state?.wait ?? {};
  const state = { ...(run.state ?? {}) };
  state[wait.saveTo ?? "reply"] = text;
  delete state.wait;

  // Claim the run. If another worker already resumed it, this matches nothing and we stop.
  const { data: claimed } = await sql
    .from("flow_run")
    .update({ status: "running", state, current_node_id: wait.next ?? null, resume_at: null })
    .eq("id", run.id)
    .eq("status", "waiting_input")
    .select();
  if (!claimed?.length) return;

  await executeRun(run.id);
}

// ---------------------------------------------------------------- event handlers

/** Open a run for a matched trigger, honouring once-per-session (scopeKey) dedupe. */
async function fire(match: { flow: Row; hit: TriggerHit } | null, contact: Row): Promise<void> {
  if (!match) return;
  const seed: Row = { ...match.hit.seed };

  if (match.hit.username && !contact.username) {
    await sql.from("contact").update({ username: match.hit.username }).eq("id", contact.id);
  }

  if (match.hit.scopeKey) {
    seed.scope_key = match.hit.scopeKey;
    const dup = await sql
      .from("flow_run")
      .select("id")
      .eq("contact_id", contact.id)
      .eq("flow_id", match.flow.id)
      .contains("state", { scope_key: match.hit.scopeKey })
      .limit(1);
    if (dup.data?.length) return; // already fired for this story / live session
  }

  const runId = await startRun(match.flow, contact, seed);
  if (runId) await queuePublicReply(match.flow, contact, runId, seed.comment_id);
}

let publicPaused: boolean | undefined; // read once per invocation

/**
 * "Reply to their comment too": a public reply under the comment, alongside the DM. Rotates
 * through the configured lines so it doesn't read as a bot. Queued like every send, so the
 * worker's limits and viral switch apply; nothing is queued while that switch is on.
 */
async function queuePublicReply(flow: Row, contact: Row, runId: string, commentId?: string): Promise<void> {
  const lines = (flow.trigger_config?.commentReply ?? []).filter((s: string) => s.trim());
  if (!commentId || !lines.length) return;
  if (publicPaused === undefined) {
    const { data } = await sql.from("send_guard").select("public_paused_until").eq("id", 1).maybeSingle();
    publicPaused = Boolean(data?.public_paused_until && new Date(data.public_paused_until).getTime() > Date.now());
  }
  if (publicPaused) return;

  const { error } = await sql.from("send_queue").insert({
    contact_id: contact.id,
    flow_run_id: runId,
    send_type: "public_reply",
    comment_id: commentId,
    payload: { text: lines[Math.floor(Math.random() * lines.length)] },
    next_attempt_at: after(PUBLIC_REPLY_PAUSE_MS),
    expires_at: new Date(Date.now() + PUBLIC_REPLY_TTL_MS).toISOString(),
  });
  if (error) console.error("public reply insert failed:", error.message);
  else queued++;
}

/**
 * Meta re-delivers a webhook it thinks we missed. Record each message and comment the first
 * time it arrives; false means it was handled already.
 */
async function firstSighting(key: string | null): Promise<boolean> {
  if (!key) return true;
  const { data, error } = await sql
    .from("seen_item")
    .upsert({ key }, { onConflict: "key", ignoreDuplicates: true })
    .select("key");
  if (error) {
    console.warn("seen_item insert failed:", error.message);
    return true; // better a rare duplicate than a dropped message
  }
  return Boolean(data?.length);
}

/** An inbound message: record it, resume a waiting run, or match a trigger. */
async function handleMessagingItem(item: RawItem, liveFlows: Row[]): Promise<void> {
  const m = item.messaging!;
  if (!isInbound(m)) return; // our echo, a receipt, or a reaction
  const mid = m.message?.mid ?? m.postback?.mid;
  if (!(await firstSighting(mid ? `m:${mid}` : null))) return;

  const igsid: string = m.sender.id;
  const text: string =
    m.postback?.payload ?? m.message?.quick_reply?.payload ?? m.message?.text ?? "";

  // A reply or a button tap opens the 24-hour window.
  const contact = await upsertContact(igsid, undefined, true);

  await sql.from("message").insert({
    contact_id: contact.id,
    direction: "in",
    payload: m.message ?? m.postback ?? {},
    meta_message_id: m.message?.mid ?? m.postback?.mid ?? null,
  });
  await markIncoming(contact);

  const ref = readRef(m);
  if (ref) await storeRef(contact, ref); // campaign attribution, on every path

  // Starter / menu taps and the opt-in / opt-out keywords come before anything else.
  const tap: string = m.postback?.payload ?? m.message?.quick_reply?.payload ?? "";
  if (await handleFlowTap(tap, contact)) return;
  if (!tap && (await handleOptKeyword(m.message?.text ?? "", contact))) return;

  // Continuation first: if a run is waiting for a reply, this message IS that reply.
  const waiting = await sql
    .from("flow_run")
    .select()
    .eq("contact_id", contact.id)
    .eq("status", "waiting_input")
    .order("created_at", { ascending: false })
    .limit(1);
  if (waiting.data?.[0]) {
    await resumeWithReply(waiting.data[0], text, contact);
    return;
  }

  if (await activeRun(contact.id)) return; // already mid-flow
  await fire(matchTrigger(item, liveFlows), contact);
}

let recentMedia: Promise<{ id: string; timestamp: string }[]> | null = null; // read once per invocation

/** Instagram writes "+0000"; make it an offset every Date parser accepts. */
const igTime = (t: string) => new Date(t.replace(/([+-]\d\d)(\d\d)$/, "$1:$2")).getTime();

/**
 * "Next post or reel": a live comment automation set up before its post existed. Once a post is
 * published after the moment it was chosen, bind the automation to the earliest such post, so
 * from then on it behaves like "specific post". Runs on comments only, and only reads the post
 * list when some automation is still waiting.
 */
async function bindNextPosts(flows: Row[]): Promise<void> {
  const waiting = flows.filter(
    (f) => f.trigger_type === "comment" && f.trigger_config?.nextPostAfter && !f.trigger_config?.mediaId,
  );
  if (!waiting.length) return;
  recentMedia ??= listMedia().catch((err) => {
    console.warn("next post: could not list posts:", err instanceof Error ? err.message : err);
    return [];
  });
  const media = await recentMedia;

  for (const flow of waiting) {
    const after = new Date(flow.trigger_config.nextPostAfter).getTime();
    const next = media
      .filter((m) => igTime(m.timestamp) > after)
      .sort((a, b) => igTime(a.timestamp) - igTime(b.timestamp))[0];
    if (!next) continue;

    const trigger_config = { ...flow.trigger_config, mediaId: next.id };
    const patch: Row = { trigger_config };
    // An unpublished edit that still says "next post" is bound to the same post.
    const pending = flow.draft?.trigger_config;
    if (pending?.nextPostAfter === flow.trigger_config.nextPostAfter && !pending.mediaId) {
      patch.draft = { ...flow.draft, trigger_config: { ...pending, mediaId: next.id } };
    }
    const { error } = await sql.from("flow").update(patch).eq("id", flow.id);
    if (error) {
      console.error(`next post: binding flow ${flow.id} failed:`, error.message);
      continue;
    }
    Object.assign(flow, patch); // this batch matches against the bound post too
  }
}

/** A change (comment, live comment): match a trigger. A comment never opens the window. */
async function handleChangeItem(item: RawItem, liveFlows: Row[]): Promise<void> {
  const value = item.change?.value ?? {};
  const igsid: string | undefined = value.from?.id;
  if (!igsid || igsid === item.selfIgId) return; // our own comment, or no author
  if (!(await firstSighting(value.id ? `c:${item.change?.field}:${value.id}` : null))) return;
  if (item.change?.field === "comments") await bindNextPosts(liveFlows);

  const contact = await upsertContact(igsid, value.from?.username, false);
  if (await activeRun(contact.id)) return;
  await fire(matchTrigger(item, liveFlows), contact);
}

async function handleEntry(entry: Row, liveFlows: Row[]): Promise<void> {
  for (const item of itemsFromEntry(entry, entry.id)) {
    if (item.messaging) await handleMessagingItem(item, liveFlows);
    else if (item.change) await handleChangeItem(item, liveFlows);
  }
}

async function processInbox(): Promise<number> {
  // Claimed atomically. Events arrive the moment Meta sends them, so two workers can be in
  // flight at once; without the claim they would answer the same comment twice.
  const { data: events, error } = await sql.rpc("claim_webhook_events", { batch_size: EVENT_BATCH });
  if (error) throw new Error(`claim_webhook_events failed: ${error.message}`);

  // One read of the live flows serves every trigger match in this batch.
  const { data: liveFlows } = await sql.from("flow").select().eq("status", "live");
  const flows = liveFlows ?? [];

  let handled = 0;
  for (const event of events ?? []) {
    try {
      for (const entry of event.raw?.entry ?? []) await handleEntry(entry, flows);
      handled++;
    } catch (err) {
      await sql.from("webhook_event").update({ error: String(err) }).eq("id", event.id);
      console.error(`webhook_event ${event.id} failed:`, err);
    }
  }
  return handled;
}

async function resumeDue(): Promise<number> {
  const now = new Date().toISOString();

  // Each update claims its rows: a run another worker already picked up no longer matches.
  const { data: delayed } = await sql
    .from("flow_run")
    .update({ status: "running", resume_at: null })
    .eq("status", "waiting_delay")
    .lte("resume_at", now)
    .select();

  for (const run of delayed ?? []) await executeRun(run.id);

  const { data: timedOut } = await sql
    .from("flow_run")
    .update({ status: "running" })
    .eq("status", "waiting_input")
    .lte("resume_at", now)
    .select();

  for (const run of timedOut ?? []) {
    const state = { ...(run.state ?? {}) };
    let target: string | null = null;
    if (state.wait) {
      target = state.wait.onTimeout ?? null;
      delete state.wait;
    } else if (state.collect) {
      target = state.collect.onTimeout ?? null;
      delete state.collect;
    }
    await saveRun(run.id, { state, current_node_id: target, resume_at: null });
    await executeRun(run.id);
  }

  return (delayed?.length ?? 0) + (timedOut?.length ?? 0);
}

Deno.serve(async (req) => {
  const denied = requireService(req);
  if (denied) return denied;
  queued = 0;
  optSettings = undefined;
  profileFetches = new Map();
  publicPaused = undefined;
  recentMedia = null;
  await loadBotFields().catch((err) => console.warn("bot fields not loaded:", err));
  try {
    const events = await processInbox();
    const resumed = await resumeDue();
    if (queued > 0) kick("send-worker");
    await backfillProfiles().catch((err) => console.warn("profile backfill failed:", err));
    await Promise.allSettled(profileFetches.values());
    return json({ events, resumed, queued });
  } catch (err) {
    console.error("process-events failed:", err);
    return json({ error: String(err) }, 500);
  }
});
