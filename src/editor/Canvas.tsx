import { useEffect, useRef, useState } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  useReactFlow,
  type Node,
  type OnConnectStartParams,
} from "@xyflow/react";
import { useEditor } from "./store";
import { FlowNodeCard } from "./nodes/FlowNodeCard";
import { TriggerNode } from "./nodes/TriggerNode";
import { NoteNode } from "./nodes/NoteNode";
import { CATEGORY_ACCENT, CATEGORY_ORDER, NODE_DEFS } from "./nodeDefs";
import { NODE_ICON } from "./nodes/icons";
import type { NodeType } from "../lib/types";

const nodeTypes = { flowNode: FlowNodeCard, triggerNode: TriggerNode, noteNode: NoteNode };

/** How far the pointer may move during a click before it counts as a drag. */
const CLICK_SLACK_PX = 6;

interface ConnectMenu {
  x: number;
  y: number;
  source: string;
  handle: string;
  flow: { x: number; y: number };
}

export function Canvas() {
  const nodes = useEditor((s) => s.nodes);
  const edges = useEditor((s) => s.edges);
  const onNodesChange = useEditor((s) => s.onNodesChange);
  const onEdgesChange = useEditor((s) => s.onEdgesChange);
  const onConnect = useEditor((s) => s.onConnect);
  const onNodeDragStart = useEditor((s) => s.onNodeDragStart);
  const addNodeConnected = useEditor((s) => s.addNodeConnected);
  const select = useEditor((s) => s.select);

  const { screenToFlowPosition, getNode, getZoom, setCenter } = useReactFlow();

  // "Show me" from the problems list: bring the step into the middle of the canvas.
  const focusReq = useEditor((s) => s.focusReq);
  useEffect(() => {
    if (!focusReq) return;
    const n = getNode(focusReq.id);
    if (!n) return;
    const w = n.measured?.width ?? 240;
    const h = n.measured?.height ?? 120;
    void setCenter(n.position.x + w / 2, n.position.y + h / 2, { zoom: Math.max(getZoom(), 0.9), duration: 400 });
  }, [focusReq, getNode, getZoom, setCenter]);
  const dragFrom = useRef<{ source: string; handle: string } | null>(null);
  const [menu, setMenu] = useState<ConnectMenu | null>(null);

  return (
    <div className="relative flex-1 min-w-0" style={{ background: "var(--slate)" }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeDragStart={onNodeDragStart}
        onConnectStart={(_, params: OnConnectStartParams) => {
          // Only outgoing (source) drags spawn a node; nothing feeds a target.
          if (params.handleType === "source" && params.nodeId) {
            dragFrom.current = { source: params.nodeId, handle: params.handleId ?? "next" };
          }
        }}
        onConnectEnd={(event) => {
          const from = dragFrom.current;
          dragFrom.current = null;
          if (!from) return;
          // A drop onto a handle already became a real edge via onConnect; only an empty-canvas
          // drop (the pane) opens the picker.
          const target = event.target as Element | null;
          if (!target?.classList?.contains("react-flow__pane")) return;
          const point =
            "changedTouches" in event ? event.changedTouches[0] : (event as MouseEvent);
          const flow = screenToFlowPosition({ x: point.clientX, y: point.clientY });
          setMenu({ x: point.clientX, y: point.clientY, source: from.source, handle: from.handle, flow });
        }}
        onNodeClick={(_, n: Node) => select(n.id)}
        onPaneClick={() => { select(null); setMenu(null); }}
        // React Flow's defaults treat a 1px hand wobble during a click as a drag and swallow the
        // click, so opening a node took a second, stiller click. A few pixels of slack fixes it.
        nodeClickDistance={CLICK_SLACK_PX}
        nodeDragThreshold={CLICK_SLACK_PX}
        paneClickDistance={CLICK_SLACK_PX}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        proOptions={{ hideAttribution: true }}
        defaultEdgeOptions={{ type: "smoothstep" }}
      >
        {/* n8n-style canvas: a mid-grey sheet with a crisp dot grid, so white cards lift off it */}
        <Background variant={BackgroundVariant.Dots} gap={20} size={1.6} color="var(--canvas-dot)" bgColor="var(--canvas-bg)" />
        <Controls showInteractive={false} />
        <MiniMap
          pannable
          zoomable
          style={{ background: "var(--surface)" }}
          maskColor="rgba(16, 24, 40, 0.08)"
          nodeColor="#c9cdd3"
          nodeBorderRadius={4}
        />
      </ReactFlow>

      {menu && (
        <ConnectMenuCard
          menu={menu}
          onClose={() => setMenu(null)}
          onPick={(type) => {
            // Drop the node so its top-center lands near where the drag ended.
            addNodeConnected(type, menu.source, menu.handle, { x: menu.flow.x - 110, y: menu.flow.y });
            setMenu(null);
          }}
        />
      )}
    </div>
  );
}

/** The library that pops where a connection was dropped, so add + connect is one gesture. */
function ConnectMenuCard({
  menu,
  onPick,
  onClose,
}: {
  menu: ConnectMenu;
  onPick: (type: NodeType) => void;
  onClose: () => void;
}) {
  const groups = CATEGORY_ORDER.map((cat) => ({
    cat,
    defs: Object.values(NODE_DEFS).filter((d) => d.addable && d.category === cat),
  })).filter((g) => g.defs.length > 0);

  // Keep the menu inside the viewport near the drop point.
  const left = Math.min(menu.x, window.innerWidth - 288);
  const top = Math.min(menu.y, window.innerHeight - 360);

  return (
    <>
      <div className="picker-scrim" onClick={onClose} />
      <div className="picker-menu connect-menu" style={{ position: "fixed", left, top, zIndex: 40 }}>
        <div className="connect-menu-head mono">Add &amp; connect</div>
        {groups.map((g) => (
          <div key={g.cat} className="picker-group">
            <div className="picker-cat">{g.cat}</div>
            {g.defs.map((d) => (
              <button key={d.type} className="picker-item" onClick={() => onPick(d.type as NodeType)}>
                <span className="picker-ic" style={{ background: `${CATEGORY_ACCENT[d.category]}1e` }}>
                  {NODE_ICON[d.type]}
                </span>
                <span className="picker-text">
                  <span className="picker-name">{d.name}</span>
                  <span className="picker-desc">{d.description}</span>
                </span>
              </button>
            ))}
          </div>
        ))}
      </div>
    </>
  );
}
