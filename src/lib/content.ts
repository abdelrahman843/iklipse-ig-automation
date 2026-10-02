// The message a broadcast or a sequence message sends, panel side. Mirrors
// supabase/functions/_shared/content.ts: blocks are sent one bubble each, in order.

import { supabase } from "./supabase";
import { matchContacts, type Condition } from "./conditions";
import type { Contact, MessageContent } from "./types";

export type BlockKind = "text" | "image" | "gallery";

/** One bubble in the basic builder. Its kind follows from what it holds. */
export type Block = MessageContent;

export interface StoredContent extends MessageContent {
  blocks?: Block[];
}

export function blockKind(b: Block): BlockKind {
  if (b.cards) return "gallery";
  if (b.imageUrl !== undefined) return "image";
  return "text";
}

export function blankBlock(kind: BlockKind): Block {
  if (kind === "image") return { imageUrl: "" };
  if (kind === "gallery") return { cards: [{ title: "", subtitle: "", imageUrl: "", buttons: [] }] };
  return { text: "", buttons: [] };
}

/** Read stored content as blocks. Older rows held text and an image in one message. */
export function toBlocks(content: StoredContent | null | undefined): Block[] {
  if (!content) return [];
  if (Array.isArray(content.blocks)) return content.blocks;
  const out: Block[] = [];
  if (content.text !== undefined || content.buttons?.length) out.push({ text: content.text ?? "", buttons: content.buttons ?? [] });
  if (content.imageUrl) out.push({ imageUrl: content.imageUrl });
  if (content.cards?.length) out.push({ cards: content.cards });
  return out;
}

export function hasBody(b: Block): boolean {
  return Boolean(b.text?.trim() || b.imageUrl?.trim() || b.cards?.some((c) => c.title.trim()));
}

const HTTPS = /^https:\/\/\S+$/i;

/** The first thing Instagram would refuse in these blocks, worded so a person can fix it. */
export function blocksProblem(blocks: Block[]): string | null {
  if (!blocks.some(hasBody)) return "Add a message first.";
  for (const [i, b] of blocks.entries()) {
    const n = `Block ${i + 1}`;
    const kind = blockKind(b);
    if (kind === "text") {
      const limit = b.buttons?.length ? 640 : 1000;
      if ((b.text ?? "").length > limit) return `${n}: text is over ${limit} characters.`;
      if (b.buttons?.length && !b.text?.trim()) return `${n}: a message with buttons needs text.`;
      for (const btn of b.buttons ?? []) {
        if (!btn.title.trim()) return `${n}: every button needs a title.`;
        if (!HTTPS.test(btn.url ?? "")) return `${n}: "${btn.title}" needs a link starting with https://.`;
      }
    }
    if (kind === "image" && b.imageUrl && !HTTPS.test(b.imageUrl)) return `${n}: the image link must start with https://.`;
    if (kind === "gallery") {
      for (const [j, c] of (b.cards ?? []).entries()) {
        if (!c.title.trim()) return `${n}, card ${j + 1}: add a title.`;
        if (c.imageUrl && !HTTPS.test(c.imageUrl)) return `${n}, card ${j + 1}: the image link must start with https://.`;
        for (const btn of c.buttons ?? []) {
          if (!btn.title.trim() || !HTTPS.test(btn.url ?? "")) return `${n}, card ${j + 1}: each button needs a title and an https:// link.`;
        }
      }
    }
  }
  return null;
}

/** A one-line description of what will be sent, for tables. */
export function summarize(content: StoredContent | null | undefined): string {
  const blocks = toBlocks(content).filter(hasBody);
  if (!blocks.length) return "";
  const first = blocks[0];
  const head =
    blockKind(first) === "image" ? "Image" : blockKind(first) === "gallery" ? `Gallery · ${first.cards?.length ?? 0} cards` : (first.text ?? "").trim();
  return blocks.length > 1 ? `${head} +${blocks.length - 1}` : head;
}

// ---- image uploads (Instagram fetches images by public URL) ------------------------------------

export const IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif"];
export const IMAGE_MAX_BYTES = 8 * 1024 * 1024;

/** Upload an image to the public media bucket and return its link. Throws a readable error. */
export async function uploadImage(file: File): Promise<string> {
  if (!IMAGE_TYPES.includes(file.type)) throw new Error("Use a JPG, PNG or GIF. Instagram won't deliver other formats.");
  if (file.size > IMAGE_MAX_BYTES) {
    throw new Error(`That file is ${(file.size / 1024 / 1024).toFixed(1)} MB. Instagram's limit is 8 MB.`);
  }
  const path = `${crypto.randomUUID()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, "-")}`;
  const { error } = await supabase.storage.from("media").upload(path, file, { contentType: file.type, upsert: false });
  if (error) throw error;
  const { data } = supabase.storage.from("media").getPublicUrl(path);
  const { error: rowError } = await supabase.from("media_asset").insert({ storage_path: path, public_url: data.publicUrl });
  if (rowError) {
    await supabase.storage.from("media").remove([path]);
    throw rowError;
  }
  return data.publicUrl;
}

// ---- audiences -------------------------------------------------------------------------------

/** A broadcast audience is a list of contact conditions (see lib/conditions). */
export type AudienceCondition = Condition;

const WINDOW_MS = 24 * 3600 * 1000;

/** Contacts Instagram can still deliver a broadcast to: window open, not opted out, matching. */
const reachable = (conditions: AudienceCondition[], opts?: { count: "exact" }) => matchContacts(conditions, "", opts);

/** How many contacts a broadcast would reach right now (open window, not opted out, matching). */
export async function countAudience(conditions: AudienceCondition[]): Promise<number> {
  // Not a HEAD request: that sends the arguments in the URL, where an empty condition list
  // turns into "{}" and the function rejects it.
  const { count, error } = await reachable(conditions, { count: "exact" })
    .select("id")
    .gte("last_interaction_at", new Date(Date.now() - WINDOW_MS).toISOString())
    .is("opted_out_at", null)
    .limit(1);
  if (error) throw error;
  return count ?? 0;
}

/** Up to 50 of the contacts countAudience counts, for the "Preview contacts" list. */
export async function listAudience(conditions: AudienceCondition[]): Promise<Contact[]> {
  const { data, error } = await reachable(conditions)
    .select("*")
    .gte("last_interaction_at", new Date(Date.now() - WINDOW_MS).toISOString())
    .is("opted_out_at", null)
    .order("last_interaction_at", { ascending: false })
    .limit(50);
  if (error) throw error;
  return (data ?? []) as Contact[];
}

/** "496 (98.6%)" — ManyChat's count-and-share cell. */
export function pct(part: number, whole: number): string {
  if (!whole) return "—";
  return `${part} (${Math.round((part / whole) * 1000) / 10}%)`;
}
