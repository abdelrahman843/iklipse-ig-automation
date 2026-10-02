import type { TriggerConfig } from "../types.ts";
import {
  isInbound, isShare, isStoryMention, isStoryReply,
  type RawItem, type TriggerDef, type TriggerHit,
} from "./kit.ts";

/**
 * The fallback: an inbound DM that matched no other trigger. `fallback: true` means the
 * registry only reaches for it once every specific trigger has passed. Scopeable to skip story
 * replies, which usually want their own handling.
 */
export const default_reply: TriggerDef = {
  type: "default_reply",
  label: "Any other message",
  fallback: true,
  detect(item: RawItem): TriggerHit | null {
    const m = item.messaging;
    if (!isInbound(m)) return null;

    const text = m.message?.text ?? m.postback?.payload ?? m.message?.quick_reply?.payload ?? "";
    return {
      igsid: m.sender.id,
      text,
      opensWindow: true,
      firstSend: "dm",
      seed: {
        trigger_text: text,
        is_story_reply: isStoryReply(m),
        is_story_mention: isStoryMention(m),
        is_share: isShare(m),
      },
    };
  },
  matches(config: TriggerConfig, hit: TriggerHit): boolean {
    if (config.excludeStoryReplies && hit.seed.is_story_reply) return false;
    return true;
  },
  configSchema: [
    { key: "excludeStoryReplies", label: "Skip story replies", type: "boolean" },
  ],
};
