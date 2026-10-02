// The registry: the one place that knows the full set of triggers.
//
// Add a trigger with two edits, both here: import its file, add it to REGISTRY. Order is
// priority — a ref link beats a plain DM, and the fallback (default_reply) is reached only
// after every specific trigger has passed. process-events imports matchTrigger and nothing
// else from this layer; the execution engine never learns a new trigger exists.

import type { Row, TriggerDef, TriggerHit } from "./kit.ts";
import type { RawItem } from "./kit.ts";

import { ref_url } from "./ref_url.ts";
import { story_reply } from "./story_reply.ts";
import { story_mention } from "./story_mention.ts";
import { share_to_dm } from "./share_to_dm.ts";
import { live_comment } from "./live_comment.ts";
import { comment } from "./comment.ts";
import { keyword } from "./keyword.ts";
import { default_reply } from "./default_reply.ts";

export const REGISTRY: TriggerDef[] = [
  ref_url,
  story_reply,
  story_mention,
  share_to_dm,
  live_comment,
  comment,
  keyword,
  default_reply, // fallback, kept last
];

/** Break a webhook entry into the normalized items every trigger reads. */
export function itemsFromEntry(entry: Row, selfIgId: string): RawItem[] {
  const items: RawItem[] = [];
  for (const messaging of entry.messaging ?? []) items.push({ entry, selfIgId, messaging });
  for (const change of entry.changes ?? []) items.push({ entry, selfIgId, change });
  return items;
}

/**
 * The winning (flow, hit) for one item, or null. Specific triggers are tried before the
 * fallback; the first trigger that both recognizes the event AND has a matching live flow wins.
 */
export function matchTrigger(
  item: RawItem,
  liveFlows: Row[],
): { flow: Row; hit: TriggerHit } | null {
  const ordered = [
    ...REGISTRY.filter((t) => !t.fallback),
    ...REGISTRY.filter((t) => t.fallback),
  ];

  for (const def of ordered) {
    const hit = def.detect(item);
    if (!hit) continue;
    for (const flow of liveFlows) {
      if (flow.trigger_type !== def.type) continue;
      if (def.matches(flow.trigger_config ?? {}, hit)) return { flow, hit };
    }
  }
  return null;
}

export type { RawItem, TriggerDef, TriggerHit } from "./kit.ts";
export { isInbound, readRef } from "./kit.ts";
