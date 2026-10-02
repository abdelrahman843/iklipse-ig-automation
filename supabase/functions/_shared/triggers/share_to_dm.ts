import type { TriggerConfig } from "../types.ts";
import { isInbound, isShare, type RawItem, type TriggerDef, type TriggerHit } from "./kit.ts";

/** The user reshares our post or reel into their story / a DM. Arrives on `messages`. */
export const share_to_dm: TriggerDef = {
  type: "share_to_dm",
  label: "Reshare of your post",
  detect(item: RawItem): TriggerHit | null {
    const m = item.messaging;
    if (!isInbound(m)) return null;
    if (!isShare(m)) return null;

    const att = (m.message?.attachments ?? []).find((a: Record<string, any>) => a?.type === "share");
    return {
      igsid: m.sender.id,
      text: "",
      opensWindow: true,
      firstSend: "dm",
      seed: { is_share: true, shared_url: att?.payload?.url ?? null },
    };
  },
  matches(): boolean {
    return true;
  },
  configSchema: [],
};
