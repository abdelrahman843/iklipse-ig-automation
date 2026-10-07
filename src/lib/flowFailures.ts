import { supabase } from "./supabase";
import { explainRunError } from "./runErrors";
import type { Flow, FlowGraph } from "./types";

/** Something that went wrong for contacts in this automation, grouped by step and cause. */
export interface Failure {
  /** The step it happened at; "trigger" for the reply under a comment; null when unknown. */
  nodeId: string | null;
  message: string;
  fixable: boolean;
  count: number;
  lastAt: string;
}

const WINDOW_DAYS = 7;

/** A message step's text as a pattern: {{placeholders}} match whatever they were filled with. */
function textPattern(text: string): RegExp {
  const parts = text.trim().split(/\{\{[^}]*\}\}/).map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`^${parts.join("[\\s\\S]*")}$`);
}

/** Which step sent this text. A send row doesn't record its step, but its text gives it away. */
function stepOfText(graph: FlowGraph | undefined, text: string | undefined): string | null {
  if (!graph || !text?.trim()) return null;
  for (const [id, node] of Object.entries(graph.nodes ?? {})) {
    const texts = [node.content?.text, node.promptText, ...(node.extras ?? []).map((e) => e.text)];
    if (texts.some((t) => t?.trim() && textPattern(t).test(text.trim()))) return id;
  }
  return null;
}

/** Failed runs and failed sends of the last week, explained and counted. */
export async function loadFailures(flow: Flow): Promise<Failure[]> {
  const since = new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString();
  const [runs, sends] = await Promise.all([
    supabase
      .from("flow_run")
      .select("current_node_id, error, updated_at")
      .eq("flow_id", flow.id)
      .in("status", ["failed", "blocked_window"])
      .not("error", "is", null)
      .gte("updated_at", since)
      .order("updated_at", { ascending: false })
      .limit(300),
    supabase
      .from("send_queue")
      .select("error, created_at, send_type, payload, flow_run!inner(flow_id)")
      .eq("flow_run.flow_id", flow.id)
      .eq("status", "failed")
      .not("error", "is", null)
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(300),
  ]);
  if (runs.error) throw runs.error;
  if (sends.error) throw sends.error;

  const groups = new Map<string, Failure>();
  const add = (nodeId: string | null, raw: string, at: string) => {
    const { text, fixable } = explainRunError(raw);
    const key = `${nodeId}|${text}`;
    const g = groups.get(key);
    if (g) {
      g.count++;
      if (at > g.lastAt) g.lastAt = at;
    } else {
      groups.set(key, { nodeId, message: text, fixable, count: 1, lastAt: at });
    }
  };

  for (const r of runs.data ?? []) add(r.current_node_id ?? null, String(r.error), r.updated_at);
  for (const s of sends.data ?? []) {
    const nodeId = s.send_type === "public_reply"
      ? "trigger"
      : stepOfText(flow.graph, (s.payload as { text?: string } | null)?.text);
    add(nodeId, String(s.error), s.created_at);
  }

  // Fixable first, then the most frequent.
  return [...groups.values()].sort((a, b) => Number(b.fixable) - Number(a.fixable) || b.count - a.count);
}
