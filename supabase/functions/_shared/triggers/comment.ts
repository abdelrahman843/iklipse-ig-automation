import type { TriggerConfig } from "../types.ts";
import { keywordHit, type RawItem, type TriggerDef, type TriggerHit } from "./kit.ts";

/**
 * A user's first comment on a post. Meta only delivers the first, so once-per-user is its
 * behaviour, not ours. The reply is a private reply, which does not open the window.
 */
export const comment: TriggerDef = {
  type: "comment",
  label: "Comment on a post",
  detect(item: RawItem): TriggerHit | null {
    const c = item.change;
    if (!c || c.field !== "comments") return null;
    const v = c.value ?? {};
    const igsid = v.from?.id;
    const commentId = v.id;
    if (!igsid || !commentId) return null;
    if (igsid === item.selfIgId) return null; // our own comment

    const text = v.text ?? "";
    const commentAt = item.entry.time
      ? new Date(item.entry.time * 1000).toISOString()
      : new Date().toISOString();

    return {
      igsid,
      username: v.from?.username,
      text,
      opensWindow: false,
      firstSend: "private_reply",
      commentId,
      mediaId: v.media?.id,
      seed: {
        comment_id: commentId,
        comment_at: commentAt,
        media_id: v.media?.id ?? null,
        trigger_text: text,
      },
    };
  },
  matches(config: TriggerConfig, hit: TriggerHit): boolean {
    if (config.mediaId && config.mediaId !== hit.mediaId) return false;
    return keywordHit(config, hit.text);
  },
  configSchema: [
    { key: "mediaId", label: "Post id", type: "text", help: "Numeric media id. Empty = any post." },
    { key: "keywords", label: "Keywords", type: "keywords", help: "Empty = any comment." },
    { key: "match", label: "Match", type: "select", options: ["contains", "exact"] },
  ],
};
