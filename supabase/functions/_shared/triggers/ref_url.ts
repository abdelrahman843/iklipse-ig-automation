import type { TriggerConfig } from "../types.ts";
import { isInbound, readRef, type RawItem, type TriggerDef, type TriggerHit } from "./kit.ts";

/**
 * A click on an ig.me link carrying ?ref=. The referral rides a different webhook field per
 * thread state — postback (ice-breaker tap), message (typed) or messaging_referral (existing
 * thread). readRef pulls it from all three. Checked before the plain DM trigger so a ref wins.
 */
export const ref_url: TriggerDef = {
  type: "ref_url",
  label: "Ref link click",
  detect(item: RawItem): TriggerHit | null {
    const m = item.messaging;
    if (!isInbound(m)) return null;
    const ref = readRef(m);
    if (!ref) return null;

    const text = m.message?.text ?? m.postback?.payload ?? "";
    return {
      igsid: m.sender.id,
      text,
      opensWindow: true,
      firstSend: "dm",
      seed: { ref, trigger_text: text },
    };
  },
  matches(config: TriggerConfig, hit: TriggerHit): boolean {
    const want = (config.ref ?? "").trim();
    if (!want) return true;
    return String(hit.seed.ref ?? "").includes(want);
  },
  configSchema: [
    { key: "ref", label: "Ref value", type: "text", help: "Match this ref. Empty = any ref." },
  ],
};
