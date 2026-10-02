// Editor state. React Flow owns the canvas; this owns the graph being edited. Kept in Zustand
// so the canvas, the picker and the config panel all read and mutate one source of truth.
//
// Undo/redo is a snapshot stack. A checkpoint is taken BEFORE each discrete change: a connect,
// an add, a delete, or the start of a drag. Config typing is coalesced — a run of keystrokes is
// one undo step — so undo does not rewind letter by letter.

import { create } from "zustand";
import {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
} from "@xyflow/react";
import { blankNode } from "../lib/graph";
import type { Flow, FlowNode, NodeType, TriggerConfig } from "../lib/types";
import { fromReactFlow, toReactFlow, type FlowNodeData, type TriggerNodeData } from "./adapter";

interface Snapshot {
  nodes: Node[];
  edges: Edge[];
}

const HISTORY_LIMIT = 50;

interface EditorState {
  nodes: Node[];
  edges: Edge[];
  selectedId: string | null;
  dirty: boolean;
  /** Bumped on every meaningful edit, so a save can tell whether edits landed while it ran. */
  rev: number;
  past: Snapshot[];
  future: Snapshot[];
  coalescingEdit: boolean;
  /** How many contacts reached each node (node id -> count), and how many entered the flow. */
  stats: Record<string, number>;
  entered: number;

  init: (flow: Flow) => void;
  setStats: (stats: Record<string, number>, entered: number) => void;
  onNodesChange: (changes: NodeChange[]) => void;
  onEdgesChange: (changes: EdgeChange[]) => void;
  onConnect: (conn: Connection) => void;
  onNodeDragStart: () => void;
  addNode: (type: NodeType) => void;
  addNote: () => void;
  updateNote: (id: string, patch: { text?: string; color?: "yellow" | "green" | "blue" | "pink" }) => void;
  addNodeConnected: (
    type: NodeType,
    source: string,
    sourceHandle: string,
    position: { x: number; y: number },
  ) => void;
  updateFlowNode: (id: string, patch: Partial<FlowNode>) => void;
  updateTrigger: (patch: { trigger_type?: Flow["trigger_type"]; trigger_config?: TriggerConfig }) => void;
  deleteNode: (id: string) => void;
  select: (id: string | null) => void;
  /** Clears `dirty` — unless edits arrived after `rev` (the revision that was saved). */
  markSaved: (rev?: number) => void;
  checkpoint: (isEdit?: boolean) => void;
  undo: () => void;
  redo: () => void;
  canUndo: () => boolean;
  canRedo: () => boolean;
  compile: () => ReturnType<typeof fromReactFlow>;
}

function nextId(nodes: Node[]): string {
  const used = nodes
    .filter((n) => n.type === "flowNode")
    .map((n) => Number(n.id.replace(/^n/, "")))
    .filter((n) => Number.isFinite(n));
  return `n${(used.length ? Math.max(...used) : 0) + 1}`;
}

export const useEditor = create<EditorState>((set, get) => ({
  nodes: [],
  edges: [],
  selectedId: null,
  dirty: false,
  rev: 0,
  past: [],
  future: [],
  coalescingEdit: false,
  stats: {},
  entered: 0,

  init: (flow) => {
    const { nodes, edges } = toReactFlow(flow);
    set({ nodes, edges, selectedId: null, dirty: false, past: [], future: [], coalescingEdit: false });
  },

  setStats: (stats, entered) => set({ stats, entered }),

  checkpoint: (isEdit = false) => {
    // Coalesce a run of config edits into a single undo step.
    if (isEdit && get().coalescingEdit) return;
    set({
      past: [...get().past.slice(-(HISTORY_LIMIT - 1)), { nodes: get().nodes, edges: get().edges }],
      future: [],
      coalescingEdit: isEdit,
    });
  },

  undo: () => {
    const past = get().past;
    if (!past.length) return;
    const prev = past[past.length - 1];
    set({
      nodes: prev.nodes,
      edges: prev.edges,
      past: past.slice(0, -1),
      future: [{ nodes: get().nodes, edges: get().edges }, ...get().future],
      dirty: true,
      rev: get().rev + 1,
      coalescingEdit: false,
    });
  },

  redo: () => {
    const future = get().future;
    if (!future.length) return;
    const nextState = future[0];
    set({
      nodes: nextState.nodes,
      edges: nextState.edges,
      future: future.slice(1),
      past: [...get().past, { nodes: get().nodes, edges: get().edges }],
      dirty: true,
      rev: get().rev + 1,
      coalescingEdit: false,
    });
  },

  canUndo: () => get().past.length > 0,
  canRedo: () => get().future.length > 0,

  onNodesChange: (changes) => {
    // A keyboard delete arrives here as a 'remove' change; snapshot before applying it.
    if (changes.some((c) => c.type === "remove")) get().checkpoint(false);
    const meaningful = changes.some((c) => c.type !== "select" && c.type !== "dimensions");
    set({
      nodes: applyNodeChanges(changes, get().nodes),
      dirty: get().dirty || meaningful,
      rev: meaningful ? get().rev + 1 : get().rev,
    });
  },

  onEdgesChange: (changes) => {
    if (changes.some((c) => c.type === "remove")) get().checkpoint(false);
    const meaningful = changes.some((c) => c.type !== "select");
    set({
      edges: applyEdgeChanges(changes, get().edges),
      dirty: get().dirty || meaningful,
      rev: meaningful ? get().rev + 1 : get().rev,
    });
  },

  onNodeDragStart: () => get().checkpoint(false),

  onConnect: (conn) => {
    if (conn.target === "trigger") return; // nothing feeds the trigger
    get().checkpoint(false);
    // Each exit points at exactly one target: replace any existing edge from this handle.
    const edges = get().edges.filter(
      (e) => !(e.source === conn.source && e.sourceHandle === conn.sourceHandle),
    );
    set({
      edges: addEdge(
        { ...conn, type: "smoothstep", markerEnd: { type: "arrowclosed" as never } },
        edges,
      ),
      dirty: true,
      rev: get().rev + 1,
    });
  },

  addNode: (type) => {
    get().checkpoint(false);
    const id = nextId(get().nodes);
    const node: Node = {
      id,
      type: "flowNode",
      position: { x: 40, y: 60 + get().nodes.length * 20 },
      data: { nodeType: type, flowNode: { ...blankNode(type), position: undefined } } as FlowNodeData,
    };
    set({ nodes: [...get().nodes, node], selectedId: id, dirty: true, rev: get().rev + 1 });
  },

  addNote: () => {
    get().checkpoint(false);
    const id = `note${Date.now().toString(36)}`;
    const node: Node = {
      id,
      type: "noteNode",
      position: { x: 60, y: 40 + get().nodes.length * 12 },
      data: { text: "", color: "yellow" },
    };
    set({ nodes: [...get().nodes, node], selectedId: id, dirty: true, rev: get().rev + 1 });
  },

  updateNote: (id, patch) => {
    get().checkpoint(true);
    set({
      nodes: get().nodes.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...patch } } : n)),
      dirty: true,
      rev: get().rev + 1,
    });
  },

  // Drop a fresh node at `position` and wire the source handle straight to it, so dragging a
  // connection into empty canvas adds and connects in one gesture. An exit points at one target,
  // so any existing edge from that handle is replaced.
  addNodeConnected: (type, source, sourceHandle, position) => {
    get().checkpoint(false);
    const id = nextId(get().nodes);
    const node: Node = {
      id,
      type: "flowNode",
      position,
      data: { nodeType: type, flowNode: { ...blankNode(type), position: undefined } } as FlowNodeData,
    };
    const edges = get().edges.filter(
      (e) => !(e.source === source && e.sourceHandle === sourceHandle),
    );
    set({
      nodes: [...get().nodes, node],
      edges: [
        ...edges,
        {
          id: `${source}-${sourceHandle}-${id}`,
          source,
          sourceHandle,
          target: id,
          targetHandle: "in",
          type: "smoothstep",
          markerEnd: { type: "arrowclosed" as never },
        },
      ],
      selectedId: id,
      dirty: true,
      rev: get().rev + 1,
    });
  },

  updateFlowNode: (id, patch) => {
    get().checkpoint(true);
    set({
      nodes: get().nodes.map((n) =>
        n.id === id
          ? { ...n, data: { ...n.data, flowNode: { ...(n.data as FlowNodeData).flowNode, ...patch } } }
          : n,
      ),
      dirty: true,
      rev: get().rev + 1,
    });
  },

  updateTrigger: (patch) => {
    get().checkpoint(true);
    set({
      nodes: get().nodes.map((n) => {
        if (n.type !== "triggerNode") return n;
        const data = n.data as TriggerNodeData;
        return {
          ...n,
          data: {
            trigger_type: patch.trigger_type ?? data.trigger_type,
            trigger_config: patch.trigger_config ?? data.trigger_config,
          },
        };
      }),
      dirty: true,
      rev: get().rev + 1,
    });
  },

  deleteNode: (id) => {
    if (id === "trigger") return; // the trigger is part of every flow
    get().checkpoint(false);
    set({
      nodes: get().nodes.filter((n) => n.id !== id),
      edges: get().edges.filter((e) => e.source !== id && e.target !== id),
      selectedId: get().selectedId === id ? null : get().selectedId,
      dirty: true,
      rev: get().rev + 1,
    });
  },

  select: (id) => set({ selectedId: id }),

  markSaved: (rev) => {
    if (rev === undefined || rev === get().rev) set({ dirty: false });
  },

  compile: () => fromReactFlow(get().nodes, get().edges),
}));
