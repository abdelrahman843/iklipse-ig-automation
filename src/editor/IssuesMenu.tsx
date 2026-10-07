import { useEffect, useState } from "react";
import { stepLabel, type Check } from "../lib/graph";
import { relativeTime } from "../lib/time";
import type { Failure } from "../lib/flowFailures";
import type { FlowGraph } from "../lib/types";
import { useEditor } from "./store";

interface Item {
  key: string;
  level: "error" | "failure" | "warning";
  nodeId: string | null;
  message: string;
  meta?: string;
}

/**
 * The header button that says how many problems the automation has, and opens the list of them:
 * which step, what's wrong in plain words, and a click that takes you to the step.
 */
export function IssuesMenu({ checks, failures, graph }: { checks: Check[]; failures: Failure[]; graph: FlowGraph }) {
  const [open, setOpen] = useState(false);
  const focus = useEditor((s) => s.focus);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const errors: Item[] = checks
    .filter((c) => c.level === "error")
    .map((c, i) => ({ key: `e${i}`, level: "error", nodeId: c.nodeId ?? "trigger", message: c.message }));
  const warnings: Item[] = checks
    .filter((c) => c.level === "warning")
    .map((c, i) => ({ key: `w${i}`, level: "warning", nodeId: c.nodeId ?? "trigger", message: c.message }));
  const failed: Item[] = failures.map((f, i) => ({
    key: `f${i}`,
    level: f.fixable ? "failure" : "warning",
    nodeId: f.nodeId,
    message: f.message,
    meta: `${f.count} ${f.count === 1 ? "time" : "times"} · last ${relativeTime(f.lastAt)}`,
  }));

  const fixableFailures = failures.filter((f) => f.fixable).length;
  const total = errors.length + warnings.length + failed.length;
  if (!total) return null;

  const label = errors.length
    ? `${errors.length} problem${errors.length > 1 ? "s" : ""}`
    : fixableFailures
      ? `${fixableFailures} failed`
      : `${total} note${total > 1 ? "s" : ""}`;
  const bad = errors.length > 0 || fixableFailures > 0;

  const groups: Array<[string, Item[]]> = [
    ["Fix before it can go live", errors],
    [`Went wrong for contacts · last 7 days`, failed],
    ["Worth a look", warnings],
  ];

  const show = (id: string | null) => {
    setOpen(false);
    if (id && (id === "trigger" || graph.nodes[id])) focus(id);
  };

  return (
    <div className="issues-anchor">
      <button
        className={`pill issues-btn${bad ? " is-bad" : ""}`}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="true"
      >
        {label}
      </button>
      {open && (
        <>
          <div className="picker-scrim" onClick={() => setOpen(false)} />
          <div className="issues-menu" role="menu">
            {groups.map(([title, items]) =>
              items.length ? (
                <div key={title} className="issues-group">
                  <div className="issues-head">{title}</div>
                  {items.map((it) => {
                    const known = it.nodeId && (it.nodeId === "trigger" || graph.nodes[it.nodeId]);
                    return (
                      <button
                        key={it.key}
                        role="menuitem"
                        className={`issue-item is-${it.level}`}
                        onClick={() => show(it.nodeId)}
                        title={known ? "Show this step" : undefined}
                      >
                        <span className="issue-step">
                          {known ? stepLabel(graph.nodes[it.nodeId!], it.nodeId!) : it.nodeId ? "A deleted step" : "This automation"}
                        </span>
                        {it.message}
                        {it.meta && <span className="issue-meta">{it.meta}</span>}
                      </button>
                    );
                  })}
                </div>
              ) : null,
            )}
          </div>
        </>
      )}
    </div>
  );
}
