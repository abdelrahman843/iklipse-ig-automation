// The trigger registry, frontend side.
//
// The backend has the real registry (supabase/functions/_shared/triggers) that decides which
// trigger fires for a webhook event. This is its UI mirror: the one place the panel learns what
// triggers exist, how to label them, and which config fields each one shows. The New Workflow
// modal's "By trigger" filter, the builder's trigger picker, and the trigger config form all read
// from here — none of them hardcode a trigger. Add a trigger type: add one entry.

import type { TriggerType } from "./types";

/** Which config controls a trigger shows in the config form. */
export interface TriggerFields {
  /** keyword list + match rule (contains / exact). */
  keywords?: boolean;
  /** a specific post/reel media id. */
  mediaId?: boolean;
  /** a live broadcast id. */
  broadcastId?: boolean;
  /** an ig.me ref value. */
  ref?: boolean;
  /** the "skip story replies" toggle (fallback only). */
  excludeStoryReplies?: boolean;
  /** a public reply posted under the comment, alongside the DM. */
  commentReply?: boolean;
}

export interface TriggerMeta {
  type: TriggerType;
  /** Full label for a picker/dropdown. */
  label: string;
  /** Short label for a chip. */
  chip: string;
  /** One line describing when it fires. */
  hint: string;
  fields: TriggerFields;
  /** Fallback triggers are offered last — they match anything the specifics missed. */
  fallback?: boolean;
}

export const TRIGGERS: TriggerMeta[] = [
  {
    type: "comment",
    label: "A comment on a post or reel",
    chip: "Post or Reel comment",
    hint: "Fires when someone comments on your post or reel.",
    fields: { mediaId: true, keywords: true, commentReply: true },
  },
  {
    type: "keyword",
    label: "A direct message (keyword)",
    chip: "DM",
    hint: "Fires when a DM contains one of your keywords.",
    fields: { keywords: true },
  },
  {
    type: "story_reply",
    label: "A reply to your story",
    chip: "Story reply",
    hint: "Fires when someone replies to your story.",
    fields: { keywords: true },
  },
  {
    type: "story_mention",
    label: "A mention in someone's story",
    chip: "Story mention",
    hint: "Fires when a public account @mentions you in their story.",
    fields: {},
  },
  {
    type: "share_to_dm",
    label: "A reshare of your post",
    chip: "Post reshare",
    hint: "Fires when someone reshares your post or reel to their DMs.",
    fields: {},
  },
  {
    type: "live_comment",
    label: "A comment on a live",
    chip: "Live comment",
    hint: "Fires when someone comments during your live video.",
    fields: { broadcastId: true, keywords: true, commentReply: true },
  },
  {
    type: "ref_url",
    label: "An ig.me ref link",
    chip: "Ref link",
    hint: "Fires when a contact opens your ig.me link carrying a ref.",
    fields: { ref: true },
  },
  {
    type: "default_reply",
    label: "Any other message (fallback)",
    chip: "Any message",
    hint: "The catch-all: fires on a DM that matched no other trigger.",
    fields: { excludeStoryReplies: true },
    fallback: true,
  },
];

const BY_TYPE: Record<string, TriggerMeta> = Object.fromEntries(TRIGGERS.map((t) => [t.type, t]));

export function triggerMeta(type: TriggerType | null | undefined): TriggerMeta | undefined {
  return type ? BY_TYPE[type] : undefined;
}

/** Chip label for a trigger type, safe for a null/unknown value. */
export function triggerChip(type: TriggerType | null | undefined): string {
  return triggerMeta(type)?.chip ?? "No trigger";
}
