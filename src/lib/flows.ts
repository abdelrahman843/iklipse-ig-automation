// Automation status, folders and unpublished changes, shared by the list and the builder.

import { supabase } from "./supabase";
import type { Flow, FlowDraft, FlowFolder } from "./types";

/** What the builder edits: the unpublished version when there is one. */
export const editable = (flow: Flow): Flow => (flow.draft ? { ...flow, ...flow.draft } : flow);

/**
 * Set Live or Stop. A Live automation keeps edits in `draft` until Publish; once it stops, those
 * edits become the automation itself, since a stopped one is edited in place.
 */
export async function setFlowStatus(flow: Flow, status: Flow["status"]): Promise<Flow> {
  const patch: Partial<Flow> = { status };
  if (status === "draft" && flow.draft) Object.assign(patch, flow.draft, { draft: null });
  const { data, error } = await supabase.from("flow").update(patch).eq("id", flow.id).select().maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("That automation no longer exists. Refresh the page.");
  return data as Flow;
}

/** Publish: the unpublished edits replace what contacts run. */
export async function publishDraft(flow: Flow, draft: FlowDraft): Promise<Flow> {
  const { data, error } = await supabase
    .from("flow")
    .update({ ...draft, draft: null })
    .eq("id", flow.id)
    .select()
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("That automation no longer exists.");
  return data as Flow;
}

/** Folders from the top down to `id` (empty at the top level). */
export function folderPath(folders: FlowFolder[], id: string | null): FlowFolder[] {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const out: FlowFolder[] = [];
  let at = id ? byId.get(id) : undefined;
  while (at && out.length < 20) {
    out.unshift(at);
    at = at.parent_id ? byId.get(at.parent_id) : undefined;
  }
  return out;
}

/** The folder tree flattened in display order, with each folder's depth. */
export function folderTree(folders: FlowFolder[]): { folder: FlowFolder; depth: number }[] {
  const out: { folder: FlowFolder; depth: number }[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const f of folders.filter((x) => x.parent_id === parent).sort((a, b) => a.name.localeCompare(b.name))) {
      out.push({ folder: f, depth });
      if (depth < 20) walk(f.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

/** True when `id` is `root` or sits somewhere inside it. */
export function isInside(folders: FlowFolder[], id: string, root: string): boolean {
  return folderPath(folders, id).some((f) => f.id === root);
}
