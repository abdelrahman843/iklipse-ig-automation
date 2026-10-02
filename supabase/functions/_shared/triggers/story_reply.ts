import type { TriggerConfig } from "../types.ts";
import { isInbound, isStoryReply, keywordHit, type RawItem, type TriggerDef, type TriggerHit } from "./kit.ts";

/** A reply to our story — text or an emoji reaction. Arrives on `messages` with reply_to.story. */
export const story_reply: TriggerDef = {
  type: "story_reply",
  label: "Reply to your story",
  detect(item: RawItem): TriggerHit | null {
    const m = item.messaging;
    if (!isInbound(m)) return null;
    if (!isStoryReply(m)) return null;

    const text = m.message?.text ?? "";
    return {
      igsid: m.sender.id,
      text,
      opensWindow: true,
      firstSend: "dm",
      seed: { trigger_text: text, story_id: m.message?.reply_to?.story?.id ?? null, is_story_reply: true },
    };
  },
  matches(config: TriggerConfig, hit: TriggerHit): boolean {
    return keywordHit(config, hit.text);
  },
  configSchema: [
    { key: "keywords", label: "Keywords", type: "keywords", help: "Empty = any story reply." },
    { key: "match", label: "Match", type: "select", options: ["contains", "exact"] },
  ],
};
