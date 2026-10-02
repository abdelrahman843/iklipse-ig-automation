// Trigger toolkit: the shape every trigger implements, plus helpers they share.
//
// A trigger is self-contained. It reads a normalized slice of a webhook and decides whether it
// applies; it never touches the execution engine. Adding one is a new file here plus a single
// line in registry.ts — nothing in process-events changes. That is the whole point.

import type { TriggerConfig, TriggerType } from "../types.ts";

export type Row = Record<string, any>;

/**
 * One normalized piece of a webhook payload: either a messaging event or a change. `selfIgId`
 * is our own Instagram account id, so a trigger can ignore our own comments and echoes.
 */
export interface RawItem {
  entry: Row;
  selfIgId: string;
  messaging?: Row;
  change?: Row;
}

/**
 * What a trigger returns when it recognizes an event. `firstSend` is how the opening message
 * must leave: a private reply answers a comment once and does not open the window; a dm needs
 * the window already open. `opensWindow` says whether THIS inbound event opened it.
 */
export interface TriggerHit {
  igsid: string;
  username?: string;
  text: string;
  opensWindow: boolean;
  firstSend: "private_reply" | "dm";
  commentId?: string;
  mediaId?: string;
  /** Extra state seeded onto the run, e.g. the ref value or the shared post id. */
  seed: Row;
  /** Dedupe key for once-per-session triggers, e.g. one live-comment reply per broadcast. */
  scopeKey?: string;
  /** live_comment: the queued reply must expire when the broadcast ends, never retry after. */
  expiresWith?: "broadcast";
}

export interface ConfigField {
  key: string;
  label: string;
  type: "text" | "keywords" | "boolean" | "select";
  help?: string;
  options?: string[];
}

export interface TriggerDef {
  type: TriggerType;
  label: string;
  /** True for a trigger that only fires when no other trigger matched (default_reply). */
  fallback?: boolean;
  /** Recognize the event, or return null. Pure: no I/O, so it is trivial to test. */
  detect(item: RawItem): TriggerHit | null;
  /** Does a live flow of this type, with this config, want the hit? */
  matches(config: TriggerConfig, hit: TriggerHit): boolean;
  /** Field definitions for the editor. */
  configSchema: ConfigField[];
}

// ---- shared helpers ----------------------------------------------------------------------

/** Keyword rule shared by comment, keyword and live_comment. No keywords means match all. */
export function keywordHit(config: TriggerConfig, text: string): boolean {
  const keywords = (config.keywords ?? []).map((k) => k.trim().toLowerCase()).filter(Boolean);
  if (keywords.length === 0) return true;
  const haystack = text.toLowerCase().trim();
  return config.match === "exact"
    ? keywords.some((k) => haystack === k)
    : keywords.some((k) => haystack.includes(k));
}

/** A messaging event we should act on: from a real user, not our echo or a receipt. */
export function isInbound(messaging: Row | undefined): messaging is Row {
  if (!messaging) return false;
  if (messaging.message?.is_echo) return false;
  if (messaging.read || messaging.delivery || messaging.reaction) return false;
  return Boolean(messaging.sender?.id);
}

/** Pull a referral ref from wherever Meta hangs it, across the three thread states. */
export function readRef(messaging: Row | undefined): string | undefined {
  const ref = messaging?.referral?.ref ?? messaging?.postback?.referral?.ref;
  return typeof ref === "string" && ref.length ? ref : undefined;
}

const STORY_MENTION = "story_mention";
const SHARE = "share";

export function attachmentType(messaging: Row | undefined, type: string): boolean {
  const atts = messaging?.message?.attachments;
  return Array.isArray(atts) && atts.some((a: Row) => a?.type === type);
}

export function isStoryReply(messaging: Row | undefined): boolean {
  return Boolean(messaging?.message?.reply_to?.story);
}

export function isStoryMention(messaging: Row | undefined): boolean {
  return attachmentType(messaging, STORY_MENTION);
}

export function isShare(messaging: Row | undefined): boolean {
  return attachmentType(messaging, SHARE);
}
