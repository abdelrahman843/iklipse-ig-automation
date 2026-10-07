import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ReactFlowProvider } from "@xyflow/react";
import { supabase } from "../lib/supabase";
import { checkFlow } from "../lib/graph";
import { editable, folderPath, publishDraft, setFlowStatus } from "../lib/flows";
import { FlowPill } from "../components/StatusPill";
import { Canvas } from "../editor/Canvas";
import { ConfigPanel } from "../editor/ConfigPanel";
import { NodePicker } from "../editor/NodePicker";
import { Loader } from "../components/Loader";
import { friendlyError, toast } from "../components/Toast";
import { confirmDialog } from "../components/Confirm";
import { useEditor, type StepIssue } from "../editor/store";
import { IssuesMenu } from "../editor/IssuesMenu";
import { loadFailures, type Failure } from "../lib/flowFailures";
import type { Flow, FlowFolder } from "../lib/types";

type Compiled = ReturnType<ReturnType<typeof useEditor.getState>["compile"]>;

/**
 * Writes the compiled graph + name. Returns the error, or null when it landed. A Live automation's
 * edits go to `draft` until Publish, so contacts never run a half-built flow; anything else is
 * edited in place.
 */
async function writeFlow(flowId: string, name: string, compiled: Compiled | null, live: boolean): Promise<unknown> {
  const draft = compiled && {
    trigger_type: compiled.trigger_type,
    trigger_config: compiled.trigger_config,
    graph: compiled.graph,
  };
  // A rename alone never counts as an unpublished change.
  const patch = !draft ? { name } : live ? { name, draft } : { name, ...draft, draft: null };
  const { data, error } = await supabase
    .from("flow")
    .update(patch)
    .eq("id", flowId)
    .select("id");
  if (error) return error;
  // No row back means it was deleted elsewhere (or RLS hid it) — nothing was saved.
  if (!data?.length) return "This automation no longer exists. It may have been deleted in another tab.";
  return null;
}

/**
 * The visual flow builder. The canvas (React Flow) owns the graph; this screen loads the flow
 * into the editor store, compiles it back on save, and keeps the surrounding chrome — name,
 * status, validation. The backend model is untouched: compile() produces the same { start,
 * nodes } graph the execution engine already runs.
 */
export function FlowEditor() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [flow, setFlow] = useState<Flow | null>(null);
  const [folders, setFolders] = useState<FlowFolder[]>([]);
  const [name, setName] = useState("");
  const [nameDirty, setNameDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  // The edit a save failed on. Auto-save holds off until something changes, so a failing save
  // doesn't retry (and toast) every second; the header offers a manual retry instead.
  const [failed, setFailed] = useState<{ rev: number; name: string } | null>(null);
  const [statusBusy, setStatusBusy] = useState(false);
  const inflight = useRef<Promise<boolean> | null>(null);
  const fieldsWarned = useRef(false);
  // Read after an await, where the render's own values may be stale.
  const nameRef = useRef(name);
  nameRef.current = name;
  const nameDirtyRef = useRef(nameDirty);
  nameDirtyRef.current = nameDirty;
  // Updated with the state, so code after an await never reads a version from before the save.
  const flowRef = useRef(flow);
  const commitFlow = (next: Flow | null) => {
    flowRef.current = next;
    setFlow(next);
  };

  const init = useEditor((s) => s.init);
  const addNote = useEditor((s) => s.addNote);
  const setStats = useEditor((s) => s.setStats);
  const compile = useEditor((s) => s.compile);
  const markSaved = useEditor((s) => s.markSaved);
  const graphDirty = useEditor((s) => s.dirty);
  const rev = useEditor((s) => s.rev);
  const nodes = useEditor((s) => s.nodes);
  const edges = useEditor((s) => s.edges);
  const undo = useEditor((s) => s.undo);
  const redo = useEditor((s) => s.redo);
  const canUndo = useEditor((s) => s.past.length > 0);
  const canRedo = useEditor((s) => s.future.length > 0);
  const setIssues = useEditor((s) => s.setIssues);
  const [failures, setFailures] = useState<Failure[]>([]);

  useEffect(() => {
    (async () => {
      try {
        const { data, error } = await supabase.from("flow").select("*").eq("id", id).single();
        if (error) throw error;
        const f = data as Flow;
        commitFlow(f);
        setName(f.name);
        init(editable(f));
        supabase.from("flow_folder").select("*").then(({ data: d }) => setFolders((d ?? []) as FlowFolder[]));

        // Per-node "reached" counters, so each step can show how many contacts got there.
        const { data: stats, error: statsError } = await supabase
          .from("node_stat")
          .select("node_id, reached")
          .eq("flow_id", f.id);
        if (statsError) toast.error(statsError);
        const map: Record<string, number> = {};
        for (const row of stats ?? []) map[row.node_id as string] = Number(row.reached);
        setStats(map, map[f.graph?.start] ?? 0);
      } catch (err) {
        setLoadError(`Could not load this flow: ${friendlyError(err)}`);
      }
    })();
  }, [id, init, setStats]);

  // Validate the compiled graph — the same rules Meta enforces silently. Recomputes on any
  // canvas change (nodes/edges are dependencies).
  const compiled = useMemo(
    () => (flow ? compile() : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [flow, nodes, edges, compile],
  );
  const checks = useMemo(
    () => (flow && compiled ? checkFlow({ ...flow, ...compiled, draft: null }) : []),
    [flow, compiled],
  );
  const blocking = checks.filter((c) => c.level === "error");

  // What actually went wrong for contacts this week, so a silent failure has a visible cause.
  const flowId = flow?.id;
  useEffect(() => {
    if (!flowRef.current || !flowId) return;
    loadFailures(flowRef.current).then(setFailures, () => setFailures([]));
  }, [flowId]);

  // Hand every problem to the step it belongs to: the canvas marks it and the drawer explains it.
  useEffect(() => {
    const rank = { error: 0, failure: 1, warning: 2 };
    const map: Record<string, StepIssue[]> = {};
    const add = (id: string, issue: StepIssue) => (map[id] ??= []).push(issue);
    for (const c of checks) add(c.nodeId ?? "trigger", { level: c.level, message: c.message });
    for (const f of failures) {
      if (f.nodeId) add(f.nodeId, { level: f.fixable ? "failure" : "warning", message: f.message, count: f.count, lastAt: f.lastAt });
    }
    for (const list of Object.values(map)) list.sort((a, b) => rank[a.level] - rank[b.level]);
    setIssues(map);
  }, [checks, failures, setIssues]);
  const dirty = graphDirty || nameDirty;
  const saveFailed = Boolean(failed && failed.rev === rev && failed.name === name);

  /**
   * Saves now. `announce` toasts "Saved" (explicit saves); auto-save only speaks up on failure.
   * A save already in flight is awaited first, then whatever it missed is written.
   */
  async function save(announce = false): Promise<boolean> {
    while (inflight.current) await inflight.current;
    if (!useEditor.getState().dirty && !nameDirtyRef.current) {
      if (announce) toast.success("Saved");
      return true;
    }
    const p = write(announce).finally(() => {
      if (inflight.current === p) inflight.current = null;
    });
    inflight.current = p;
    return p;
  }

  async function write(announce: boolean): Promise<boolean> {
    const current = flowRef.current;
    if (!current) return false;
    setSaving(true);
    // Snapshot what is being saved: edits made while the request is in flight stay dirty.
    const savedRev = useEditor.getState().rev;
    const savedName = nameRef.current;
    const graphChanged = useEditor.getState().dirty;
    const compiled = compile();
    const live = current.status === "live";
    let err: unknown;
    try {
      err = await writeFlow(current.id, savedName, graphChanged ? compiled : null, live);
    } catch (e) {
      err = e;
    }
    setSaving(false);
    if (err) {
      setFailed({ rev: savedRev, name: savedName });
      toast.error(`Changes not saved. ${friendlyError(err)}`);
      return false;
    }
    setFailed(null);
    markSaved(savedRev);
    const saved = { trigger_type: compiled.trigger_type, trigger_config: compiled.trigger_config, graph: compiled.graph };
    const was = flowRef.current;
    if (was) commitFlow({ ...was, name: savedName, ...(!graphChanged ? {} : live ? { draft: saved } : { ...saved, draft: null }) });
    if (nameRef.current === savedName) setNameDirty(false);
    if (announce) toast.success("Saved");

    // Register any custom fields this flow collects, so the panel can list and filter on them
    // even before the first value arrives. The flow itself is saved either way.
    const fields = Object.values(compiled.graph.nodes)
      .filter((n) => n.type === "collect" && (n.saveTo ?? "").trim())
      .map((n) => ({ key: (n.saveTo as string).trim(), type: n.inputType ?? "text" }));
    if (fields.length) {
      const { error } = await supabase.from("custom_field").upsert(fields, { onConflict: "key" });
      // Once per visit: auto-save would otherwise repeat it every few seconds.
      if (error && !fieldsWarned.current) {
        fieldsWarned.current = true;
        toast.error(`Saved, but the custom fields weren't registered. ${friendlyError(error)}`);
      }
    }
    return true;
  }

  // Auto-save: whenever there are unsaved edits, save after a short pause. A ref keeps the effect
  // from re-running on every render while still calling the latest `save`.
  const saveRef = useRef<(announce?: boolean) => Promise<boolean>>(async () => false);
  saveRef.current = save;
  useEffect(() => {
    if (!flow || !dirty || saving || saveFailed) return;
    const t = setTimeout(() => void saveRef.current(), 900);
    return () => clearTimeout(t);
  }, [dirty, rev, name, flow, saving, saveFailed]);

  // Ctrl/Cmd+S saves now. Ctrl/Cmd+Z undo, Ctrl+Shift+Z or Ctrl+Y redo — native undo is left
  // alone while typing in a field.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!(e.ctrlKey || e.metaKey)) return;
      const key = e.key.toLowerCase();
      if (key === "s") {
        e.preventDefault();
        void saveRef.current(true);
        return;
      }
      const el = e.target as HTMLElement | null;
      if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;
      if (key === "z" && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if ((key === "z" && e.shiftKey) || key === "y") {
        e.preventDefault();
        redo();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo]);

  // Closing the tab with unsaved edits: let the browser ask.
  const unsaved = dirty || saving;
  useEffect(() => {
    if (!unsaved) return;
    const onUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, [unsaved]);

  // Leaving through the sidebar unmounts the editor mid-debounce: flush the pending edits, and
  // if that write fails say so on whatever screen comes next instead of losing them silently.
  const latest = useRef({ flow, discard: false });
  latest.current = { ...latest.current, flow: flowRef.current };
  useEffect(
    () => () => {
      const { flow: f, discard } = latest.current;
      const n = nameRef.current;
      const graphChanged = useEditor.getState().dirty;
      if (!f || discard || !(graphChanged || nameDirtyRef.current)) return;
      const compiled = graphChanged ? useEditor.getState().compile() : null;
      void writeFlow(f.id, n, compiled, f.status === "live")
        .catch((e: unknown) => e)
        .then((err) => {
          if (err) toast.error(`Your last changes to “${n}” weren't saved. ${friendlyError(err)}`);
        });
    },
    [],
  );

  const path = folderPath(folders, flow?.folder_id ?? null);
  const backTo = path.length ? `/flows?folder=${path[path.length - 1].id}` : "/flows";

  /** Back arrow and crumbs: save first; if that fails, ask before dropping the edits. */
  async function leave(e: React.MouseEvent, to = backTo) {
    if (!dirty && !saving) return; // the link navigates normally
    e.preventDefault();
    if (await save()) return navigate(to);
    const ok = await confirmDialog({
      title: "Leave without saving?",
      body: "Your latest changes couldn't be saved. If you leave now, they're lost.",
      confirmLabel: "Leave anyway",
      danger: true,
    });
    if (!ok) return;
    latest.current.discard = true;
    navigate(to);
  }

  /** Runs a status change after the pending edits are saved; nothing changes if that save fails. */
  async function afterSave(fn: (f: Flow) => Promise<Flow>, done: string) {
    if (statusBusy) return;
    setStatusBusy(true);
    try {
      if (!(await save())) return;
      const current = flowRef.current;
      if (!current) return;
      commitFlow(await fn(current));
      toast.success(done);
    } catch (err) {
      toast.error(err);
    } finally {
      setStatusBusy(false);
    }
  }

  const setLive = () => afterSave((f) => setFlowStatus(f, "live"), "Automation is live");
  const stop = () => afterSave((f) => setFlowStatus(f, "draft"), "Automation stopped. It no longer runs.");
  const publish = () =>
    afterSave((f) => {
      const c = compile();
      return publishDraft(f, { trigger_type: c.trigger_type, trigger_config: c.trigger_config, graph: c.graph });
    }, "Published. Contacts get the new version now.");

  async function discard() {
    const current = flowRef.current;
    if (!current?.draft || statusBusy) return;
    const ok = await confirmDialog({
      title: "Discard unpublished changes?",
      body: "The builder goes back to the version contacts are getting now.",
      confirmLabel: "Discard Changes",
      danger: true,
    });
    if (!ok) return;
    setStatusBusy(true);
    while (inflight.current) await inflight.current;
    const { data, error } = await supabase.from("flow").update({ draft: null }).eq("id", current.id).select().maybeSingle();
    setStatusBusy(false);
    if (error || !data) return toast.error(error ?? "This automation no longer exists.");
    const next = data as Flow;
    commitFlow(next);
    init(next);
    toast.success("Changes discarded");
  }

  if (loadError && !flow) return <div className="notice">{loadError}</div>;
  if (!flow) return <div className="editor-root"><Loader label="Loading flow" /></div>;

  // Edits waiting for Publish: saved to the draft, or typed but not saved yet.
  const unpublished = Boolean(flow.draft) || graphDirty;

  return (
    <div className="editor-root">
      <header className="editor-bar">
        <Link to={backTo} className="editor-back" aria-label="Back to automations" onClick={(e) => leave(e)}>←</Link>
        <nav className="editor-crumbs" aria-label="Breadcrumb">
          <Link to="/flows" onClick={(e) => leave(e, "/flows")}>Automations</Link>
          {path.map((f) => (
            <span key={f.id}>
              <span className="crumb-sep" aria-hidden="true">›</span>
              <Link to={`/flows?folder=${f.id}`} onClick={(e) => leave(e, `/flows?folder=${f.id}`)}>{f.name}</Link>
            </span>
          ))}
          <span className="crumb-sep" aria-hidden="true">›</span>
        </nav>
        <input
          className="editor-name"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setNameDirty(true);
          }}
          aria-label="Automation name"
        />
        {saveFailed && !saving ? (
          <>
            <span className="editor-save mono" style={{ color: "var(--burn)" }} role="status">Not saved</span>
            <button className="btn btn-quiet" onClick={() => void save(true)}>Retry save</button>
          </>
        ) : (
          <span className="editor-save mono" role="status" title="Saves automatically. Ctrl+S saves now.">
            {saving ? "Saving…" : dirty ? "Unsaved" : "Saved"}
          </span>
        )}

        <div className="editor-tools">
          <NodePicker />
          <button className="btn btn-quiet" onClick={() => addNote()} title="Add a sticky note">+ Note</button>
          <button className="btn btn-quiet" onClick={undo} disabled={!canUndo} title="Undo (Ctrl+Z)" aria-label="Undo">↶</button>
          <button className="btn btn-quiet" onClick={redo} disabled={!canRedo} title="Redo (Ctrl+Shift+Z)" aria-label="Redo">↷</button>
          {compiled && <IssuesMenu checks={checks} failures={failures} graph={compiled.graph} />}
          <span className="editor-divider" aria-hidden="true" />
          <FlowPill status={flow.status} />
          {flow.status === "live" ? (
            unpublished ? (
              <>
                {flow.draft && (
                  <button className="btn btn-quiet" onClick={discard} disabled={statusBusy}>Discard</button>
                )}
                <button
                  className={`btn btn-primary ${statusBusy ? "is-busy" : ""}`}
                  onClick={publish}
                  disabled={blocking.length > 0 || statusBusy}
                  title={blocking.length > 0 ? "Fix the problems first" : "Contacts get these changes once you publish"}
                >
                  Publish
                </button>
              </>
            ) : (
              <button className={`btn ${statusBusy ? "is-busy" : ""}`} onClick={stop} disabled={statusBusy} title="Stop running this automation">
                Stop
              </button>
            )
          ) : (
            <button
              className={`btn btn-primary ${statusBusy ? "is-busy" : ""}`}
              onClick={setLive}
              disabled={blocking.length > 0 || statusBusy || Boolean(flow.deleted_at)}
              title={flow.deleted_at ? "Restore it from Trash first" : blocking.length > 0 ? "Fix the problems first" : undefined}
            >
              Set Live
            </button>
          )}
        </div>
      </header>
      {flow.deleted_at && (
        <div className="editor-unpub" role="status">
          This automation is in Trash and doesn't run. <Link to="/flows?view=trash">Restore it from Trash</Link> to use it again.
        </div>
      )}
      {flow.status === "live" && unpublished && (
        <div className="editor-unpub" role="status">
          You're editing a live automation. Contacts keep getting the published version until you click Publish.
        </div>
      )}

      <div className="editor-stage">
        <ReactFlowProvider>
          <Canvas />
          <ConfigPanel />
        </ReactFlowProvider>
      </div>
    </div>
  );
}
