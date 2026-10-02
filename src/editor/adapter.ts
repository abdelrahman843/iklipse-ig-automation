// The bridge between the backend flow graph and React Flow.
//
// The backend graph is already a node graph: { start, nodes }, where each node points at the
// next by exit key (next / onTrue / onFalse / onTimeout). React Flow wants an array of nodes
// with positions and an array of edges. These two functions convert each way. Positions ride
// along inside the same JSONB (node.position, graph.triggerPosition); the execution engine never
// reads them, so nothing on the backend changes.

import { type Edge, type Node } from "@xyflow/react";
import { exits } from "../lib/graph";
import type { EditorNote, Flow, FlowGraph, FlowNode, NodeType, TriggerConfig } from "../lib/types";

export interface NoteNodeData extends Record<string, unknown> {
  text: string;
  color: EditorNote["color"];
}

const ROW = 150;
const COL = 300;
const TOP = 0;
const START_Y = 160;

export interface FlowNodeData extends Record<string, unknown> {
  nodeType: NodeType;
  flowNode: FlowNode;
}
export interface TriggerNodeData extends Record<string, unknown> {
  trigger_type: Flow["trigger_type"];
  trigger_config: TriggerConfig;
}

// Exit keys that any node might carry. Kept as a superset (static branches + a few dynamic
// randomize handles) so fromReactFlow can strip stale edge targets before re-reading them off the
// canvas edges. Randomize handles beyond b7 are rare; extend if a flow ever needs more.
const EXIT_KEYS = [
  "next",
  "onTimeout",
  "onTrue",
  "onFalse",
  "onFailed",
  "onError",
  "b0",
  "b1",
  "b2",
  "b3",
  "b4",
  "b5",
  "b6",
  "b7",
] as const;

const edgeBase = {
  type: "smoothstep",
  markerEnd: { type: "arrowclosed" as const },
} as const;

/** BFS levels from start, so a fresh (position-less) graph opens as a readable tree. */
function autoLayout(graph: FlowGraph): { nodes: Record<string, { x: number; y: number }>; trigger: { x: number; y: number } } {
  const depth: Record<string, number> = {};
  const queue: string[] = [];
  if (graph.start && graph.nodes[graph.start]) {
    depth[graph.start] = 0;
    queue.push(graph.start);
  }
  while (queue.length) {
    const id = queue.shift()!;
    const node = graph.nodes[id];
    if (!node) continue;
    for (const exit of exits(node)) {
      const target = node[exit.key] as string | null | undefined;
      if (target && graph.nodes[target] && depth[target] === undefined) {
        depth[target] = depth[id] + 1;
        queue.push(target);
      }
    }
  }
  // Orphans (unreachable from start) get parked in rows below the deepest reached level.
  let maxDepth = Object.values(depth).reduce((m, d) => Math.max(m, d), 0);
  for (const id of Object.keys(graph.nodes)) {
    if (depth[id] === undefined) depth[id] = ++maxDepth;
  }

  const byLevel: Record<number, string[]> = {};
  for (const [id, d] of Object.entries(depth)) (byLevel[d] ??= []).push(id);

  const positions: Record<string, { x: number; y: number }> = {};
  for (const [level, ids] of Object.entries(byLevel)) {
    ids.forEach((id, i) => {
      positions[id] = { x: (i - (ids.length - 1) / 2) * COL, y: START_Y + Number(level) * ROW };
    });
  }
  const startX = graph.start ? positions[graph.start]?.x ?? 0 : 0;
  return { nodes: positions, trigger: { x: startX, y: TOP } };
}

export function toReactFlow(flow: Flow): { nodes: Node[]; edges: Edge[] } {
  const graph = flow.graph ?? { start: "", nodes: {} };
  const layout = autoLayout(graph);
  const nodes: Node[] = [];
  const edges: Edge[] = [];

  nodes.push({
    id: "trigger",
    type: "triggerNode",
    position: graph.triggerPosition ?? layout.trigger,
    deletable: false,
    data: { trigger_type: flow.trigger_type, trigger_config: flow.trigger_config } as TriggerNodeData,
  });
  if (graph.start && graph.nodes[graph.start]) {
    edges.push({ id: "e-trigger", source: "trigger", sourceHandle: "start", target: graph.start, targetHandle: "in", ...edgeBase });
  }

  // Sticky notes: free-floating, no handles, never part of execution.
  for (const note of graph.notes ?? []) {
    nodes.push({
      id: note.id,
      type: "noteNode",
      position: note.position,
      data: { text: note.text, color: note.color ?? "yellow" } as NoteNodeData,
    });
  }

  for (const [id, node] of Object.entries(graph.nodes)) {
    nodes.push({
      id,
      type: "flowNode",
      position: node.position ?? layout.nodes[id] ?? { x: 0, y: 0 },
      data: { nodeType: node.type, flowNode: node } as FlowNodeData,
    });
    for (const exit of exits(node)) {
      const target = node[exit.key] as string | null | undefined;
      if (target) {
        edges.push({
          id: `${id}-${String(exit.key)}`,
          source: id,
          sourceHandle: String(exit.key),
          target,
          targetHandle: "in",
          ...edgeBase,
        });
      }
    }
  }
  return { nodes, edges };
}

/** Compile the canvas back into what the backend and execution engine expect. */
export function fromReactFlow(
  rfNodes: Node[],
  rfEdges: Edge[],
): { graph: FlowGraph; trigger_type: Flow["trigger_type"]; trigger_config: TriggerConfig } {
  const triggerNode = rfNodes.find((n) => n.type === "triggerNode");
  const triggerData = (triggerNode?.data ?? {}) as TriggerNodeData;

  const nodes: Record<string, FlowNode> = {};
  const notes: EditorNote[] = [];
  for (const rf of rfNodes) {
    if (rf.type === "noteNode") {
      const data = rf.data as NoteNodeData;
      notes.push({ id: rf.id, text: data.text ?? "", position: rf.position, color: data.color });
      continue;
    }
    if (rf.type !== "flowNode") continue;
    const data = rf.data as FlowNodeData;
    const clean: FlowNode = { ...data.flowNode, position: rf.position };
    for (const key of EXIT_KEYS) delete (clean as unknown as Record<string, unknown>)[key];
    nodes[rf.id] = clean;
  }

  let start = "";
  for (const edge of rfEdges) {
    if (edge.source === "trigger") {
      start = edge.target;
      continue;
    }
    const node = nodes[edge.source];
    if (node && edge.sourceHandle) (node as unknown as Record<string, unknown>)[edge.sourceHandle] = edge.target;
  }

  return {
    graph: { start, nodes, triggerPosition: triggerNode?.position, notes },
    trigger_type: triggerData.trigger_type,
    trigger_config: triggerData.trigger_config,
  };
}
