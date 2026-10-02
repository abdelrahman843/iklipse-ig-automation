import { useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabase";
import { triggerChip } from "../lib/triggers";
import { relativeTime } from "../lib/time";
import { FlowPill } from "./StatusPill";
import { Loader } from "./Loader";
import { toast } from "./Toast";
import type { Flow } from "../lib/types";

/** "Select Existing": pick one of the automations, with a search box. */
export function FlowPicker({
  title = "Select an automation",
  onPick,
  onClose,
}: {
  title?: string;
  onPick: (flow: Flow) => void;
  onClose: () => void;
}) {
  const [flows, setFlows] = useState<Flow[] | null>(null);
  const [query, setQuery] = useState("");
  const [chosen, setChosen] = useState<Flow | null>(null);

  useEffect(() => {
    supabase
      .from("flow")
      .select("*")
      .is("deleted_at", null)
      .order("updated_at", { ascending: false })
      .then(({ data, error }) => {
        if (error) toast.error(error);
        setFlows((data ?? []) as Flow[]);
      });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    // An automation with no steps has nothing to send.
    return (flows ?? []).filter((f) => f.graph?.start && (!q || f.name.toLowerCase().includes(q)));
  }, [flows, query]);

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="pick-modal" role="dialog" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <header className="pick-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">×</button>
        </header>
        <div className="pick-search">
          <input className="input" autoFocus placeholder="Search automations…" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <div className="pick-list">
          {flows === null ? (
            <Loader inline label="Loading automations" />
          ) : shown.length === 0 ? (
            <p className="mono" style={{ padding: 16, margin: 0 }}>
              {flows.length ? "Nothing matches that search." : "No automations with steps yet. Build one in Automations first."}
            </p>
          ) : (
            shown.map((f) => (
              <button
                key={f.id}
                className={`pick-row ${chosen?.id === f.id ? "is-current" : ""}`}
                onClick={() => setChosen(f)}
                onDoubleClick={() => onPick(f)}
              >
                <span className="pick-name">{f.name}</span>
                <span className="pick-meta">
                  <FlowPill status={f.status} />
                  <span>{triggerChip(f.trigger_type)}</span>
                  <span>· edited {relativeTime(f.updated_at)}</span>
                </span>
              </button>
            ))
          )}
        </div>
        <footer className="pick-foot">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={!chosen} onClick={() => chosen && onPick(chosen)}>
            Pick This Automation
          </button>
        </footer>
      </div>
    </div>
  );
}
