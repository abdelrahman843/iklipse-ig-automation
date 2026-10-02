import type { TriggerConfig } from "../types.ts";
import { keywordHit, type RawItem, type TriggerDef, type TriggerHit } from "./kit.ts";

/**
 * A comment during a live broadcast, on the `live_comments` field. The private reply is valid
 * only while the broadcast is live, so it is queued with a short expiry and never retried once
 * that passes (see LIVE_REPLY_TTL_MS and the send-worker). Fires once per user per broadcast.
 */
export const live_comment: TriggerDef = {
  type: "live_comment",
  label: "Comment on a live",
  detect(item: RawItem): TriggerHit | null {
    const c = item.change;
    if (!c || c.field !== "live_comments") return null;
    const v = c.value ?? {};
    const igsid = v.from?.id;
    const commentId = v.id;
    if (!igsid || !commentId) return null;
    if (igsid === item.selfIgId) return null;

    const text = v.text ?? "";
    const mediaId = v.media?.id;
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
      mediaId,
      seed: { comment_id: commentId, comment_at: commentAt, live: true, media_id: mediaId ?? null, trigger_text: text },
      scopeKey: `live:${mediaId ?? "any"}:${igsid}`,
      expiresWith: "broadcast",
    };
  },
  matches(config: TriggerConfig, hit: TriggerHit): boolean {
    if (config.broadcastId && config.broadcastId !== hit.mediaId) return false;
    return keywordHit(config, hit.text);
  },
  configSchema: [
    { key: "broadcastId", label: "Broadcast id", type: "text", help: "Live media id. Empty = any live." },
    { key: "keywords", label: "Keywords", type: "keywords", help: "Empty = any live comment." },
    { key: "match", label: "Match", type: "select", options: ["contains", "exact"] },
  ],
};
