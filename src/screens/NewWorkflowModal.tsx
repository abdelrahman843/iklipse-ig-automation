import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { emptyGraph } from "../lib/graph";
import { TRIGGERS, triggerChip } from "../lib/triggers";
import { Loader } from "../components/Loader";
import { friendlyError, toast } from "../components/Toast";
import { IgLogo } from "../editor/nodes/icons";
import type { FlowGraph, FlowTemplate, TriggerConfig, TriggerType } from "../lib/types";

// "By goal" reads its labels here; the set of goals shown is whatever the templates actually use,
// so a template with a new goal adds its group with no code change.
const GOAL_LABEL: Record<string, string> = {
  grow_followers: "Grow followers",
  engage: "Engage audience",
  drive_traffic: "Drive traffic",
};
const goalLabel = (g: string) => GOAL_LABEL[g] ?? g;

/**
 * The "New Automation" picker. Clicking a card deep-clones that template into a fresh draft flow;
 * "Start from scratch" opens an empty draft with no trigger. Everything the modal shows — the
 * cards, the "By goal" and "By trigger" filters — comes from data (flow_template rows + the
 * trigger registry), so it has no per-template code.
 */
export function NewWorkflowModal({ folderId = null, onClose }: { folderId?: string | null; onClose: () => void }) {
  const navigate = useNavigate();
  const [templates, setTemplates] = useState<FlowTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [goal, setGoal] = useState<string | null>(null);
  const [trig, setTrig] = useState<string | null>(null);
  // What is being created: "scratch" or a template id. Blocks a second click while it runs.
  const [creating, setCreating] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const { data, error } = await supabase.from("flow_template").select("*").order("sort");
        if (error) throw error;
        setTemplates((data ?? []) as FlowTemplate[]);
      } catch (err) {
        setError(`Could not load templates: ${friendlyError(err)}`);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // Close on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Goals present in the data, in a stable order.
  const goals = useMemo(
    () => [...new Set(templates.map((t) => t.goal))].sort((a, b) => goalLabel(a).localeCompare(goalLabel(b))),
    [templates],
  );
  // Trigger filters: generated from the registry, kept to triggers at least one template uses.
  const usedTriggers = useMemo(() => new Set(templates.map((t) => t.trigger_type)), [templates]);
  const triggerFilters = useMemo(() => TRIGGERS.filter((t) => usedTriggers.has(t.type)), [usedTriggers]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return templates.filter((t) => {
      if (goal && t.goal !== goal) return false;
      if (trig && t.trigger_type !== trig) return false;
      if (q && !`${t.name} ${t.description}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [templates, query, goal, trig]);

  const recommended = shown.filter((t) => t.recommended);
  const discover = shown.filter((t) => !t.recommended);

  async function createFrom(template: FlowTemplate | null) {
    if (creating) return;
    setCreating(template?.id ?? "scratch");
    const row: {
      name: string;
      status: "draft";
      folder_id: string | null;
      trigger_type: TriggerType | null;
      trigger_config: TriggerConfig;
      graph: FlowGraph;
    } = template
      ? {
          name: template.name,
          status: "draft",
          folder_id: folderId,
          trigger_type: template.trigger_type,
          // Deep-clone so editing the new draft never touches the template.
          trigger_config: JSON.parse(JSON.stringify(template.trigger_config ?? {})),
          graph: JSON.parse(JSON.stringify(template.graph ?? emptyGraph())),
        }
      : {
          name: "Untitled automation",
          status: "draft",
          folder_id: folderId,
          trigger_type: null,
          trigger_config: {},
          graph: emptyGraph(),
        };
    const { data, error } = await supabase.from("flow").insert(row).select().single();
    if (error) {
      toast.error(error);
      setCreating(null);
      return;
    }
    navigate(`/flows/${data.id}`);
  }

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="tpl-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="New automation">
        <header className="tpl-head">
          <div>
            <p className="eyebrow">New automation</p>
            <h2 className="tpl-title">Templates</h2>
          </div>
          <div className="cluster" style={{ gap: 8 }}>
            <button
              className={`btn btn-primary ${creating === "scratch" ? "is-busy" : ""}`}
              onClick={() => createFrom(null)}
              disabled={Boolean(creating)}
            >
              Start from scratch
            </button>
            <button className="drawer-close" onClick={onClose} aria-label="Close">×</button>
          </div>
        </header>

        <div className="tpl-search">
          <input
            className="input"
            placeholder="Search templates…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
          />
        </div>

        {error && <div className="notice" style={{ margin: "0 22px" }}>{error}</div>}

        <div className="tpl-body">
          <aside className="tpl-rail">
            <div className="tpl-filtergroup">
              <p className="tpl-filterhead">By goal</p>
              {goals.map((g) => (
                <button
                  key={g}
                  className={`tpl-filter ${goal === g ? "on" : ""}`}
                  onClick={() => setGoal(goal === g ? null : g)}
                >
                  {goalLabel(g)}
                </button>
              ))}
            </div>
            <div className="tpl-filtergroup">
              <p className="tpl-filterhead">By trigger</p>
              {triggerFilters.map((t) => (
                <button
                  key={t.type}
                  className={`tpl-filter ${trig === t.type ? "on" : ""}`}
                  onClick={() => setTrig(trig === t.type ? null : t.type)}
                >
                  {t.chip}
                </button>
              ))}
            </div>
          </aside>

          <main className="tpl-cards">
            {loading ? (
              <Loader label="Loading templates" inline />
            ) : shown.length === 0 ? (
              <div className="empty"><p style={{ margin: 0 }}>No templates match that.</p></div>
            ) : (
              <>
                {recommended.length > 0 && (
                  <section className="tpl-section">
                    <h3 className="tpl-section-head">Recommended</h3>
                    <div className="tpl-grid">
                      {recommended.map((t) => (
                        <TemplateCard key={t.id} t={t} disabled={Boolean(creating)} onPick={() => createFrom(t)} />
                      ))}
                    </div>
                  </section>
                )}
                {discover.length > 0 && (
                  <section className="tpl-section">
                    <h3 className="tpl-section-head">Discover more</h3>
                    <div className="tpl-grid">
                      {discover.map((t) => (
                        <TemplateCard key={t.id} t={t} disabled={Boolean(creating)} onPick={() => createFrom(t)} />
                      ))}
                    </div>
                  </section>
                )}
              </>
            )}
          </main>
        </div>
      </div>
    </div>
  );
}

function TemplateCard({ t, onPick, disabled }: { t: FlowTemplate; onPick: () => void; disabled: boolean }) {
  return (
    <button className="tpl-card" onClick={onPick} disabled={disabled}>
      {t.badge && <span className="tpl-badge">{t.badge}</span>}
      <span className="tpl-card-ic"><IgLogo size={22} /></span>
      <span className="tpl-card-name">{t.name}</span>
      <span className="tpl-card-desc">{t.description}</span>
      <span className="tpl-card-chip">{triggerChip(t.trigger_type)}</span>
    </button>
  );
}
