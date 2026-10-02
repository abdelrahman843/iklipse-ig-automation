import type { TriggerConfig } from "../types.ts";
import {
  isInbound, isShare, isStoryMention, isStoryReply, keywordHit,
  type RawItem, type TriggerDef, type TriggerHit,
} from "./kit.ts";

/** A plain DM whose text matches a keyword. Story replies, mentions and shares are excluded — */
/** each has its own trigger. */
export const keyword: TriggerDef = {
  type: "keyword",
  label: "Direct message",
  detect(item: RawItem): TriggerHit | null {
    const m = item.messaging;
    if (!isInbound(m)) return null;
    if (isStoryReply(m) || isStoryMention(m) || isShare(m)) return null;

    const text = m.postback?.payload ?? m.message?.quick_reply?.payload ?? m.message?.text ?? "";
    if (!text) return null;

    return {
      igsid: m.sender.id,
      text,
      opensWindow: true,
      firstSend: "dm",
      seed: { trigger_text: text },
    };
  },
  matches(config: TriggerConfig, hit: TriggerHit): boolean {
    return keywordHit(config, hit.text);
  },
  configSchema: [
    { key: "keywords", label: "Keywords", type: "keywords", help: "Empty = any message." },
    { key: "match", label: "Match", type: "select", options: ["contains", "exact"] },
  ],
};
