import type { CSSProperties } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { CATEGORY_ACCENT, def } from "../nodeDefs";
import { useEditor } from "../store";
import type { FlowNodeData } from "../adapter";
import { describeDelay } from "../../lib/time";
import { IgChat, IgLogo, NODE_ICON } from "./icons";

/** A small "N reached" badge, shown when the engine has recorded arrivals at this step. */
function Reached({ id }: { id: string }) {
  const n = useEditor((s) => s.stats[id] ?? 0);
  if (!n) return null;
  return (
    <span className="node-reached" title={`${n} ${n === 1 ? "contact" : "contacts"} reached this step`}>
      {n} reached
    </span>
  );
}

/** A mark on a step that has problems: red when it is broken or failed for contacts, grey for a note. */
export function IssueMark({ id }: { id: string }) {
  const issues = useEditor((s) => s.issues[id]);
  if (!issues?.length) return null;
  const bad = issues.some((i) => i.level !== "warning");
  return (
    <span className={`node-issue${bad ? " is-bad" : ""}`} title={issues.map((i) => `• ${i.message}`).join("\n")}>
      {bad ? "!" : "i"} {issues.length}
    </span>
  );
}

/** A broken step gets a red outline, so it stands out on a busy canvas. */
function useIssueRing(id: string): CSSProperties {
  const bad = useEditor((s) => (s.issues[id] ?? []).some((i) => i.level !== "warning"));
  return bad ? { borderColor: "var(--burn)", boxShadow: "0 0 0 3px var(--burn-bg)" } : {};
}

/** Nodes that speak to the contact are drawn as a real Instagram message, not a generic box. */
const PREVIEW = new Set(["send_message", "collect"]);

function outputs(type: FlowNodeData["nodeType"]) {
  return def(type).outputs;
}

const ACTION_VERB: Record<string, string> = {
  set_field: "Set field",
  clear_field: "Clear field",
  add_tag: "Add tag",
  remove_tag: "Remove tag",
  assign: "Assign",
  mark_done: "Mark done",
  notify: "Notify",
};

function actionLine(a: NonNullable<FlowNodeData["flowNode"]["actions"]>[number]): string {
  switch (a.kind) {
    case "set_field": return `Set ${a.field || "field"}`;
    case "clear_field": return `Clear ${a.field || "field"}`;
    case "add_tag": return `+ tag ${a.tag || "?"}`;
    case "remove_tag": return `− tag ${a.tag || "?"}`;
    case "assign": return `Assign ${a.assignee || "?"}`;
    case "mark_done": return "Mark done";
    case "notify": return "Notify admin";
    case "subscribe_sequence": return "Subscribe sequence";
    case "unsubscribe_sequence": return "Unsub sequence";
    default: return ACTION_VERB[a.kind] ?? a.kind;
  }
}

/** A one-line preview of a compact node's config. */
function summary(data: FlowNodeData): string {
  const n = data.flowNode;
  switch (data.nodeType) {
    case "wait_reply":
      return `Save as ${n.saveTo || "reply"} · ${describeDelay(n.timeoutSeconds ?? 3600)}`;
    case "check_follow":
      return "Does the contact follow?";
    case "condition": {
      const t = n.op === "has_tag" || n.op === "not_has_tag";
      const left = t ? "tag" : n.left || "value";
      return `${left} ${n.op || "eq"} ${n.op === "exists" ? "" : n.right ?? ""}`.trim();
    }
    case "delay":
      return describeDelay(n.seconds ?? 0);
    case "action": {
      const acts = n.actions ?? [];
      if (!acts.length) return "No actions yet";
      return acts.map(actionLine).join(" · ");
    }
    case "randomize": {
      const b = n.branches ?? [];
      const total = b.reduce((s, x) => s + (x.weight || 0), 0) || 1;
      return b.map((x) => `${Math.round(((x.weight || 0) / total) * 100)}%`).join(" / ") || "Split";
    }
    case "smart_delay":
      return n.delayMode === "until_time"
        ? `Until ${String(n.untilHour ?? 9).padStart(2, "0")}:${String(n.untilMinute ?? 0).padStart(2, "0")}`
        : describeDelay(n.seconds ?? 0);
    case "http_request":
      return `${n.method || "GET"} ${(n.url || "…").replace(/^https?:\/\//, "").slice(0, 28)}`;
    case "go_to_flow":
      return n.targetFlowId ? "→ another flow" : "Pick a flow";
    case "end":
      return "Closes the run";
    default:
      return "";
  }
}

function OutHandles({ type, accent }: { type: FlowNodeData["nodeType"]; accent: string }) {
  const outs = outputs(type);
  if (!outs.length) return null;
  return (
    <div className="relative" style={{ height: outs.some((o) => o.label) ? 26 : 12 }}>
      {outs.map((out, i) => {
        const left = ((i + 1) / (outs.length + 1)) * 100;
        return (
          <div key={out.key}>
            {out.label && (
              <span
                className="absolute -translate-x-1/2 top-0 text-[9px] uppercase tracking-wide font-mono whitespace-nowrap"
                style={{ left: `${left}%`, color: "var(--ink-soft)" }}
              >
                {out.label}
              </span>
            )}
            <Handle
              type="source"
              position={Position.Bottom}
              id={out.key}
              style={{ left: `${left}%`, height: 9, width: 9, background: accent, borderColor: "#fff", borderWidth: 2 }}
            />
          </div>
        );
      })}
    </div>
  );
}

export function FlowNodeCard({ id, data, selected }: NodeProps) {
  const d = data as FlowNodeData;
  const definition = def(d.nodeType);
  const accent = CATEGORY_ACCENT[definition.category];
  const title = d.flowNode.title?.trim() || definition.name;
  const n = d.flowNode;

  const issueRing = useIssueRing(id);
  const ring = selected ? { borderColor: accent, boxShadow: `0 0 0 3px ${accent}22` } : issueRing;

  // ---- message-preview nodes (send_message, collect) ----
  if (PREVIEW.has(d.nodeType)) {
    const text =
      d.nodeType === "collect" ? n.promptText : n.content?.text;
    const buttons = n.content?.buttons ?? [];
    const quicks = d.nodeType === "collect"
      ? [...(n.inputType === "choice" ? n.quickReplies ?? [] : []), ...(n.skipEnabled ? [n.skipTitle || "Skip"] : [])]
      : [];

    return (
      <div className="rounded-[14px] bg-white border w-[260px] overflow-hidden" style={{ borderColor: "var(--rule)", boxShadow: "0 4px 16px rgba(23,19,13,.08)", ...ring }}>
        <Handle type="target" position={Position.Top} id="in" style={{ height: 9, width: 9, background: "var(--ink-soft)", borderColor: "#fff", borderWidth: 2 }} />

        <div className="flex items-center gap-2 px-3 pt-2.5 pb-2">
          <IgLogo size={22} />
          <div className="leading-none flex-1 min-w-0">
            <div className="text-[10px] text-[var(--ink-faint)]">Instagram</div>
            <div className="text-[13px] font-semibold text-[var(--ink)] truncate mt-0.5">{title}</div>
          </div>
          <IssueMark id={id} />
          <Reached id={id} />
          <IgChat />
        </div>

        <div className="px-3 pb-3">
          {n.content?.imageUrl && (
            <img src={n.content.imageUrl} alt="" className="w-full rounded-[10px] mb-2 max-h-28 object-cover" style={{ background: "var(--inset)" }} />
          )}
          <div className="rounded-[12px] px-3 py-2 text-[12.5px] leading-snug text-[var(--ink)]" style={{ background: "var(--inset)" }}>
            {text?.trim() || <span className="text-[var(--ink-faint)]">No message yet</span>}
            {buttons.map((b, i) => (
              <div key={i} className="mt-2 flex items-center justify-center gap-2 rounded-[9px] bg-white border py-1.5 text-[12px] font-semibold" style={{ borderColor: "var(--rule)", color: "var(--signal)" }}>
                {b.title || "Button"}
                <span className="w-2 h-2 rounded-full inline-block" style={{ background: b.url ? "var(--rose)" : "var(--ink-faint)" }} title={b.url ? "opens a link" : "replies"} />
              </div>
            ))}
            {quicks.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {quicks.map((q, i) => (
                  <span key={i} className="text-[11px] font-semibold rounded-full px-2.5 py-1" style={{ background: "var(--signal-bg)", color: "var(--signal)" }}>{q}</span>
                ))}
              </div>
            )}
          </div>
          {(() => {
            const bits: string[] = [];
            const cards = n.content?.cards?.length ?? 0;
            const att = n.content?.attachment?.type;
            const extras = n.extras?.length ?? 0;
            if (cards) bits.push(`${cards} card${cards > 1 ? "s" : ""}`);
            if (att) bits.push(att);
            if (extras) bits.push(`+${extras} bubble${extras > 1 ? "s" : ""}`);
            return bits.length ? (
              <div className="mt-1.5 text-[10px] font-mono uppercase tracking-wide" style={{ color: "var(--ink-faint)" }}>
                {bits.join(" · ")}
              </div>
            ) : null;
          })()}
        </div>

        <div className="px-3 pb-2"><OutHandles type={d.nodeType} accent={accent} /></div>
      </div>
    );
  }

  // ---- compact nodes ----
  return (
    <div className="rounded-[12px] bg-white border w-[210px]" style={{ borderColor: "var(--rule)", boxShadow: "0 2px 8px rgba(23,19,13,.06)", ...ring }}>
      <Handle type="target" position={Position.Top} id="in" style={{ height: 9, width: 9, background: "var(--ink-soft)", borderColor: "#fff", borderWidth: 2 }} />
      <div className="flex items-center gap-2 px-3 py-2.5 border-b" style={{ borderColor: "var(--rule)" }}>
        <span className="grid place-items-center h-6 w-6 rounded-[7px]" style={{ background: `${accent}1e` }}>{NODE_ICON[d.nodeType]}</span>
        <span className="text-[13px] font-semibold text-[var(--ink)] leading-tight flex-1 truncate">{title}</span>
        <IssueMark id={id} />
          <Reached id={id} />
        {definition.pauses && <span className="text-[9px] uppercase tracking-wider font-mono" style={{ color: "var(--burn)" }}>pauses</span>}
      </div>
      <div className="px-3 py-2 text-[11px] leading-snug min-h-[16px] break-words" style={{ color: "var(--ink-soft)" }}>{summary(d)}</div>
      <div className="px-3 pb-2"><OutHandles type={d.nodeType} accent={accent} /></div>
    </div>
  );
}
