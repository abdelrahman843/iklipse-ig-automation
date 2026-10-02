// Where automations name a tag or a team member, so Settings can show usage and keep them in step
// on a rename. Tags appear in Action steps (add / remove tag) and Condition steps (has tag);
// team members in Action steps (assign).

import { supabase } from "./supabase";
import type { Flow, FlowGraph, FlowNode } from "./types";

export type RefKind = "tag" | "agent";

type FlowRefs = Pick<Flow, "id" | "name" | "graph" | "draft" | "deleted_at">;

/** Calls `visit` with a setter for every tag / assignee a step names. */
function eachRef(node: FlowNode, kind: RefKind, visit: (value: string, set: (v: string) => void) => void) {
  for (const a of node.actions ?? []) {
    if (kind === "tag" && (a.kind === "add_tag" || a.kind === "remove_tag") && a.tag) visit(a.tag, (v) => (a.tag = v));
    if (kind === "agent" && a.kind === "assign" && a.assignee) visit(a.assignee, (v) => (a.assignee = v));
  }
  if (kind === "tag" && (node.op === "has_tag" || node.op === "not_has_tag") && node.right) {
    visit(node.right, (v) => (node.right = v));
  }
}

const graphsOf = (f: FlowRefs): FlowGraph[] => [f.graph, f.draft?.graph].filter((g): g is FlowGraph => Boolean(g?.nodes));

/** name -> automations (not in Trash) that use it. */
export function usage(flows: FlowRefs[], kind: RefKind): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const f of flows) {
    if (f.deleted_at) continue;
    const names = new Set<string>();
    for (const g of graphsOf(f)) for (const n of Object.values(g.nodes)) eachRef(n, kind, (v) => names.add(v));
    for (const n of names) out.set(n, [...(out.get(n) ?? []), f.name]);
  }
  return out;
}

export async function loadFlowRefs(): Promise<FlowRefs[]> {
  const { data, error } = await supabase.from("flow").select("id, name, graph, draft, deleted_at");
  if (error) throw error;
  return (data ?? []) as FlowRefs[];
}

/** Renames a tag / team member inside every automation (published and unpublished). Returns how many changed. */
export async function renameInFlows(kind: RefKind, from: string, to: string): Promise<number> {
  const flows = await loadFlowRefs();
  let changed = 0;
  for (const f of flows) {
    let touched = false;
    const rename = (g: FlowGraph | undefined) => {
      if (!g?.nodes) return g;
      const copy = JSON.parse(JSON.stringify(g)) as FlowGraph;
      for (const n of Object.values(copy.nodes)) {
        eachRef(n, kind, (v, set) => {
          if (v === from) {
            set(to);
            touched = true;
          }
        });
      }
      return copy;
    };
    const graph = rename(f.graph);
    const draft = f.draft ? { ...f.draft, graph: rename(f.draft.graph) as FlowGraph } : null;
    if (!touched) continue;
    const { error } = await supabase.from("flow").update({ graph, draft }).eq("id", f.id);
    if (error) throw error;
    changed++;
  }
  return changed;
}
