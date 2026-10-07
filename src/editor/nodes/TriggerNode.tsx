import { Handle, Position, type NodeProps } from "@xyflow/react";
import { CATEGORY_ACCENT } from "../nodeDefs";
import { triggerMeta } from "../../lib/triggers";
import { useEditor } from "../store";
import type { TriggerNodeData } from "../adapter";
import { IgLogo } from "./icons";
import { IssueMark } from "./FlowNodeCard";

export function TriggerNode({ data, selected }: NodeProps) {
  const d = data as TriggerNodeData;
  const accent = CATEGORY_ACCENT.Triggers;
  const meta = triggerMeta(d.trigger_type);
  const entered = useEditor((s) => s.entered);
  const kws = (d.trigger_config?.keywords ?? []).filter(Boolean);
  const line = meta?.chip ?? "Choose a trigger";
  const sub = meta ? (kws.length ? kws.join(", ") : "any text") : "click to pick one";

  return (
    <div
      className="rounded-full bg-white border pl-2.5 pr-4 py-2 min-w-[200px] flex items-center gap-2.5"
      style={{
        borderColor: meta ? accent : "var(--ink-faint)",
        borderStyle: meta ? "solid" : "dashed",
        boxShadow: selected ? `0 0 0 3px ${accent}22` : "0 2px 8px rgba(23,19,13,.06)",
      }}
    >
      <IgLogo size={26} />
      <div className="leading-tight">
        <div className="text-[9px] uppercase tracking-wider font-mono" style={{ color: "var(--ink-faint)" }}>Trigger</div>
        <div className="text-[13px] font-semibold text-[var(--ink)]">{line}</div>
        <div className="text-[10px] font-mono" style={{ color: "var(--ink-soft)" }}>{sub}</div>
      </div>
      <IssueMark id="trigger" />
      {entered > 0 && <span className="node-reached" title={`${entered} entered this automation`}>{entered} entered</span>}
      <Handle type="source" position={Position.Bottom} id="start" style={{ height: 10, width: 10, background: accent, borderColor: "#fff", borderWidth: 2 }} />
    </div>
  );
}
