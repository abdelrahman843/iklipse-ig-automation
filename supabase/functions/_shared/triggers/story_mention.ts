import type { TriggerConfig } from "../types.ts";
import { attachmentType, isInbound, isStoryMention, type RawItem, type TriggerDef, type TriggerHit } from "./kit.ts";

/**
 * The user @mentions us in THEIR story. Arrives on `messages` as a story_mention attachment,
 * not on the `mentions` field. Meta only delivers it when the mentioning profile is public.
 */
export const story_mention: TriggerDef = {
  type: "story_mention",
  label: "Mention in a story",
  detect(item: RawItem): TriggerHit | null {
    const m = item.messaging;
    if (!isInbound(m)) return null;
    if (!isStoryMention(m)) return null;
    void attachmentType;

    const att = (m.message?.attachments ?? []).find((a: Record<string, any>) => a?.type === "story_mention");
    return {
      igsid: m.sender.id,
      text: "",
      opensWindow: true,
      firstSend: "dm",
      seed: { is_story_mention: true, media_url: att?.payload?.url ?? null },
    };
  },
  matches(): boolean {
    return true; // an event trigger: no keyword to match
  },
  configSchema: [],
};
