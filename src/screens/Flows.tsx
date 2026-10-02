import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { errorText, supabase } from "../lib/supabase";
import { checkFlow, triggerSummary } from "../lib/graph";
import { folderPath, folderTree, isInside, setFlowStatus } from "../lib/flows";
import { relativeTime } from "../lib/time";
import { FlowPill } from "../components/StatusPill";
import { Loader } from "../components/Loader";
import { toast } from "../components/Toast";
import { confirmDialog, promptDialog } from "../components/Confirm";
import { RowMenu } from "../components/PageBits";
import { IgLogo } from "../editor/nodes/icons";
import { NewWorkflowModal } from "./NewWorkflowModal";
import type { Flow, FlowFolder } from "../lib/types";

/** Something being moved: an automation or a folder. */
type Moving = { kind: "flow"; item: Flow } | { kind: "folder"; item: FlowFolder };

/**
 * Automations, laid out like ManyChat: folders first, then automations, each with its trigger,
 * runs and last edit. Deleted automations go to Trash, where they can be restored.
 * The open folder and the Trash live in the URL (?folder=… / ?view=trash) so Back works.
 */
export function Flows() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const inTrash = params.get("view") === "trash";
  const [flows, setFlows] = useState<Flow[]>([]);
  const [folders, setFolders] = useState<FlowFolder[]>([]);
  const [runs, setRuns] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [showNew, setShowNew] = useState(false);
  const [moving, setMoving] = useState<Moving | null>(null);
  // Rows with a write in flight, so their menu can't fire twice.
  const [pending, setPending] = useState<Record<string, boolean>>({});

  // A folder that was deleted (or a stale link) falls back to the top level.
  const folderId = useMemo(() => {
    const id = params.get("folder");
    return id && folders.some((f) => f.id === id) ? id : null;
  }, [params, folders]);
  const path = useMemo(() => folderPath(folders, folderId), [folders, folderId]);

  async function load() {
    try {
      const [f, d] = await Promise.all([
        supabase.from("flow").select("*").order("updated_at", { ascending: false }),
        supabase.from("flow_folder").select("*").order("name"),
      ]);
      if (f.error) throw f.error;
      if (d.error) throw d.error;
      setFlows((f.data ?? []) as Flow[]);
      setFolders((d.data ?? []) as FlowFolder[]);
      setError(null);
      // Run counts are extras: if they fail the list still works.
      const r = await supabase.rpc("flow_run_counts");
      if (r.error) toast.error(r.error);
      else setRuns(Object.fromEntries((r.data ?? []).map((x: { flow_id: string; runs: number }) => [x.flow_id, Number(x.runs)])));
    } catch (err) {
      setError(
        `Could not reach Supabase: ${errorText(err)}. ` +
          "Check VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in .env, then restart the dev server.",
      );
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  // Leaving a folder or the Trash clears the search, like opening a new page.
  useEffect(() => setQuery(""), [folderId, inTrash]);

  const goFolder = (id: string | null) => setParams(id ? { folder: id } : {});
  const open = (flow: Flow) => navigate(`/flows/${flow.id}`);

  async function guard(id: string, fn: () => Promise<void>) {
    if (pending[id]) return;
    setPending((p) => ({ ...p, [id]: true }));
    try {
      await fn();
    } catch (err) {
      toast.error(err);
    } finally {
      setPending((p) => {
        const next = { ...p };
        delete next[id];
        return next;
      });
    }
  }

  const replace = (row: Flow) => setFlows((list) => list.map((f) => (f.id === row.id ? row : f)));

  // ---- automations ------------------------------------------------------------------------------

  function setStatus(flow: Flow, status: Flow["status"]) {
    return guard(flow.id, async () => {
      replace(await setFlowStatus(flow, status));
      toast.success(status === "live" ? `“${flow.name}” is live` : `“${flow.name}” stopped`);
    });
  }

  async function rename(flow: Flow) {
    const name = await promptDialog({ title: "Rename automation", initial: flow.name, confirmLabel: "Rename" });
    if (!name || name === flow.name) return;
    await guard(flow.id, async () => {
      const { data, error } = await supabase.from("flow").update({ name }).eq("id", flow.id).select().single();
      if (error) throw error;
      replace(data as Flow);
    });
  }

  function duplicate(flow: Flow) {
    return guard(flow.id, async () => {
      // The copy starts from what's being edited, published or not, and never goes live by itself.
      const src = flow.draft ?? flow;
      const { data, error } = await supabase
        .from("flow")
        .insert({
          name: `${flow.name} (copy)`,
          status: "draft",
          folder_id: flow.folder_id,
          trigger_type: src.trigger_type,
          trigger_config: src.trigger_config,
          graph: src.graph,
        })
        .select()
        .single();
      if (error) throw error;
      setFlows((list) => [data as Flow, ...list]);
      toast.success("Copy created as a draft");
    });
  }

  async function trash(flow: Flow) {
    if (flow.status === "live") {
      const ok = await confirmDialog({
        title: `Move “${flow.name}” to Trash?`,
        body: "It stops running now, and contacts waiting inside it are let go. You can restore it from Trash.",
        confirmLabel: "Move to Trash",
        danger: true,
      });
      if (!ok) return;
    }
    await guard(flow.id, async () => {
      const { data, error } = await supabase
        .from("flow")
        .update({ deleted_at: new Date().toISOString() })
        .eq("id", flow.id)
        .select()
        .single();
      if (error) throw error;
      replace(data as Flow);
      toast.success(`Moved “${flow.name}” to Trash`);
    });
  }

  function restore(flow: Flow) {
    return guard(flow.id, async () => {
      const { data, error } = await supabase.from("flow").update({ deleted_at: null }).eq("id", flow.id).select().single();
      if (error) throw error;
      replace(data as Flow);
      const where = (data as Flow).folder_id ? folderPath(folders, (data as Flow).folder_id).map((f) => f.name).join(" › ") : "Automations";
      toast.success(`Restored to ${where} as a draft`);
    });
  }

  async function destroy(flow: Flow) {
    const ok = await confirmDialog({
      title: `Delete “${flow.name}” forever?`,
      body: "The automation and its run history are removed for good. This can't be undone.",
      confirmLabel: "Delete forever",
      danger: true,
    });
    if (!ok) return;
    await guard(flow.id, async () => {
      const { error } = await supabase.from("flow").delete().eq("id", flow.id);
      if (error) throw error;
      setFlows((list) => list.filter((f) => f.id !== flow.id));
      toast.success("Deleted forever");
    });
  }

  async function emptyTrash() {
    const doomed = flows.filter((f) => f.deleted_at);
    const ok = await confirmDialog({
      title: `Empty Trash?`,
      body: `${doomed.length} ${doomed.length === 1 ? "automation is" : "automations are"} removed for good, with their run history. This can't be undone.`,
      confirmLabel: "Empty Trash",
      danger: true,
    });
    if (!ok) return;
    await guard("trash", async () => {
      const { error } = await supabase.from("flow").delete().in("id", doomed.map((f) => f.id));
      if (error) throw error;
      setFlows((list) => list.filter((f) => !f.deleted_at));
      toast.success("Trash emptied");
    });
  }

  // ---- folders ----------------------------------------------------------------------------------

  async function newFolder() {
    const name = await promptDialog({ title: "New folder", placeholder: "e.g. Giveaways", confirmLabel: "Create Folder" });
    if (!name) return;
    const { data, error } = await supabase.from("flow_folder").insert({ name, parent_id: folderId }).select().single();
    if (error) return toast.error(error);
    setFolders((list) => [...list, data as FlowFolder]);
  }

  async function renameFolder(folder: FlowFolder) {
    const name = await promptDialog({ title: "Rename folder", initial: folder.name, confirmLabel: "Rename" });
    if (!name || name === folder.name) return;
    const { error } = await supabase.from("flow_folder").update({ name }).eq("id", folder.id);
    if (error) return toast.error(error);
    setFolders((list) => list.map((f) => (f.id === folder.id ? { ...f, name } : f)));
  }

  async function deleteFolder(folder: FlowFolder) {
    const parent = folder.parent_id ? folders.find((f) => f.id === folder.parent_id)?.name ?? "the folder above" : "Automations";
    const ok = await confirmDialog({
      title: `Delete folder “${folder.name}”?`,
      body: `Only the folder goes. Everything inside it moves up to ${parent}.`,
      confirmLabel: "Delete Folder",
      danger: true,
    });
    if (!ok) return;
    await guard(folder.id, async () => {
      // Lift the contents first so the cascade on parent_id never takes a subfolder with it.
      const up = folder.parent_id;
      const a = await supabase.from("flow").update({ folder_id: up }).eq("folder_id", folder.id);
      if (a.error) throw a.error;
      const b = await supabase.from("flow_folder").update({ parent_id: up }).eq("parent_id", folder.id);
      if (b.error) throw b.error;
      const c = await supabase.from("flow_folder").delete().eq("id", folder.id);
      if (c.error) throw c.error;
      await load();
      toast.success("Folder deleted");
    });
  }

  async function moveTo(target: string | null) {
    const m = moving;
    setMoving(null);
    if (!m) return;
    await guard(m.item.id, async () => {
      if (m.kind === "flow") {
        const { data, error } = await supabase.from("flow").update({ folder_id: target }).eq("id", m.item.id).select().single();
        if (error) throw error;
        replace(data as Flow);
      } else {
        const { error } = await supabase.from("flow_folder").update({ parent_id: target }).eq("id", m.item.id);
        if (error) throw error;
        setFolders((list) => list.map((f) => (f.id === m.item.id ? { ...f, parent_id: target } : f)));
      }
      const where = target ? folders.find((f) => f.id === target)?.name : "Automations";
      toast.success(`Moved to ${where}`);
    });
  }

  // ---- what's on screen ---------------------------------------------------------------------------

  const live = useMemo(() => flows.filter((f) => !f.deleted_at), [flows]);
  const trashed = useMemo(
    () => flows.filter((f) => f.deleted_at).sort((a, b) => (b.deleted_at ?? "").localeCompare(a.deleted_at ?? "")),
    [flows],
  );

  const q = query.trim().toLowerCase();
  const matches = (f: Flow) =>
    `${f.name} ${triggerSummary(f)} ${JSON.stringify(f.graph?.nodes ?? {})}`.toLowerCase().includes(q);

  // A search looks in every folder; otherwise only the open one.
  const shownFolders = inTrash
    ? []
    : q
      ? folders.filter((f) => f.name.toLowerCase().includes(q))
      : folders.filter((f) => f.parent_id === folderId).sort((a, b) => a.name.localeCompare(b.name));
  const shownFlows = inTrash
    ? trashed.filter((f) => !q || matches(f))
    : q
      ? live.filter(matches)
      : live.filter((f) => f.folder_id === folderId);

  const inFolder = (id: string) => live.filter((f) => f.folder_id === id).length + folders.filter((f) => f.parent_id === id).length;
  const folderName = (id: string | null) => (id ? folderPath(folders, id).map((f) => f.name).join(" › ") : "");

  const nothingYet = !inTrash && !folderId && live.length === 0 && folders.length === 0;

  return (
    <>
      <header className="page-bar">
        <h1 className="page-title af-title">
          {inTrash || path.length ? (
            <>
              <Link to="/flows" className="af-crumb">Automations</Link>
              {inTrash ? (
                <><span className="af-sep" aria-hidden="true">›</span><span>Trash</span></>
              ) : (
                path.map((f, i) => (
                  <span key={f.id} className="af-crumb-wrap">
                    <span className="af-sep" aria-hidden="true">›</span>
                    {i === path.length - 1 ? <span>{f.name}</span> : <Link to={`/flows?folder=${f.id}`} className="af-crumb">{f.name}</Link>}
                  </span>
                ))
              )}
            </>
          ) : (
            "Automations"
          )}
        </h1>
        <div className="cluster" style={{ gap: 8 }}>
          {inTrash ? (
            trashed.length > 0 && (
              <button className={`btn btn-danger ${pending.trash ? "is-busy" : ""}`} onClick={emptyTrash} disabled={pending.trash}>
                Empty Trash
              </button>
            )
          ) : (
            <>
              <button className="btn" onClick={newFolder}>+ New Folder</button>
              <button className="btn btn-primary" onClick={() => setShowNew(true)}>+ New Automation</button>
            </>
          )}
        </div>
      </header>

      {showNew && <NewWorkflowModal folderId={folderId} onClose={() => setShowNew(false)} />}
      {moving && (
        <MoveDialog
          folders={folders}
          moving={moving}
          onPick={moveTo}
          onClose={() => setMoving(null)}
        />
      )}

      {error && <div className="notice" style={{ marginBottom: 16 }}>{error}</div>}

      {!nothingYet && (
        <div className="af-tools">
          <input
            className="input af-search"
            placeholder={inTrash ? "Search Trash…" : "Search all automations…"}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search automations"
          />
          {!inTrash && (
            <button className="btn btn-quiet af-trash-link" onClick={() => setParams({ view: "trash" })}>
              <TrashIcon /> Trash{trashed.length > 0 && <span className="af-count">{trashed.length}</span>}
            </button>
          )}
        </div>
      )}

      {inTrash && trashed.length > 0 && (
        <p className="info-banner" style={{ margin: "0 0 14px" }}>
          Automations in Trash don't run. Restore one to edit it again; it comes back as a draft.
        </p>
      )}

      {loading ? (
        <Loader label="Loading automations" />
      ) : nothingYet && !error ? (
        <div className="empty">
          <p style={{ margin: "0 0 6px", color: "var(--ink)", fontWeight: 600 }}>No automations yet</p>
          <p style={{ margin: "0 0 16px" }}>
            Start from a template or from scratch. Either way you land in the same builder.
          </p>
          <button className="btn btn-primary" onClick={() => setShowNew(true)}>+ New Automation</button>
        </div>
      ) : (
        <div className="mc-card">
          {shownFolders.length === 0 && shownFlows.length === 0 ? (
            <p className="mc-empty">
              {q
                ? "Nothing matches that search."
                : inTrash
                  ? "Trash is empty."
                  : "This folder is empty. Create an automation here, or move one in with ⋮ › Move to."}
            </p>
          ) : (
            <table className="mc-table af-table">
              <thead>
                <tr>
                  <th className="col-menu" />
                  <th>Name</th>
                  {!inTrash && <th className="num">Runs</th>}
                  <th className="af-when">{inTrash ? "Deleted" : "Modified"}</th>
                </tr>
              </thead>
              <tbody>
                {shownFolders.map((folder) => (
                  <tr
                    key={folder.id}
                    onClick={() => goFolder(folder.id)}
                    tabIndex={0}
                    onKeyDown={(e) => e.key === "Enter" && e.target === e.currentTarget && goFolder(folder.id)}
                  >
                    <td className="col-menu">
                      <RowMenu
                        label={`Actions for folder ${folder.name}`}
                        items={[
                          { label: "Open", onSelect: () => goFolder(folder.id) },
                          { label: "Rename", onSelect: () => renameFolder(folder) },
                          { label: "Move to…", onSelect: () => setMoving({ kind: "folder", item: folder }) },
                          { label: "Delete Folder", onSelect: () => deleteFolder(folder), danger: true },
                        ]}
                      />
                    </td>
                    <td>
                      <div className="af-name">
                        <FolderIcon />
                        <span className="cell-name">{folder.name}</span>
                      </div>
                      <div className="af-sub">
                        {q && folder.parent_id ? `In ${folderName(folder.parent_id)} · ` : ""}
                        {inFolder(folder.id) === 0 ? "Empty" : `${inFolder(folder.id)} ${inFolder(folder.id) === 1 ? "item" : "items"}`}
                      </div>
                    </td>
                    <td className="num" />
                    <td className="cell-muted af-when">{relativeTime(folder.created_at)}</td>
                  </tr>
                ))}
                {shownFlows.map((flow) => {
                  const problems = checkFlow(flow).filter((c) => c.level === "error").length;
                  const busy = Boolean(pending[flow.id]);
                  const items = inTrash
                    ? [
                        { label: "Restore", onSelect: () => restore(flow) },
                        { label: "Delete Forever", onSelect: () => destroy(flow), danger: true },
                      ]
                    : [
                        { label: "Edit", onSelect: () => open(flow) },
                        flow.status === "live"
                          ? { label: "Stop", onSelect: () => setStatus(flow, "draft") }
                          : {
                              label: "Set Live",
                              onSelect: () =>
                                problems > 0
                                  ? toast.error(`Fix ${problems === 1 ? "the problem" : `the ${problems} problems`} in the builder first.`)
                                  : setStatus(flow, "live"),
                            },
                        { label: "Rename", onSelect: () => rename(flow) },
                        { label: "Move to…", onSelect: () => setMoving({ kind: "flow", item: flow }) },
                        { label: "Duplicate", onSelect: () => duplicate(flow) },
                        { label: "Move to Trash", onSelect: () => trash(flow), danger: true },
                      ];
                  const openRow = () => (inTrash ? undefined : open(flow));
                  return (
                    <tr
                      key={flow.id}
                      className={`${busy ? "is-busy-row" : ""} ${inTrash ? "is-static" : ""}`}
                      onClick={openRow}
                      tabIndex={inTrash ? -1 : 0}
                      onKeyDown={(e) => e.key === "Enter" && e.target === e.currentTarget && openRow()}
                    >
                      <td className="col-menu">
                        <RowMenu label={`Actions for ${flow.name}`} items={items} />
                      </td>
                      <td>
                        <div className="af-name">
                          <span className="cell-name af-flow-name">{flow.name}</span>
                          {!inTrash && <FlowPill status={flow.status} />}
                          {!inTrash && flow.status === "live" && flow.draft && <span className="pill">Unpublished changes</span>}
                          {!inTrash && problems > 0 && <span className="pill is-bad">{problems} {problems === 1 ? "problem" : "problems"}</span>}
                        </div>
                        <div className="af-sub">
                          <IgLogo size={14} />
                          <span className="af-trigger">{triggerSummary(flow)}</span>
                          {(q || inTrash) && flow.folder_id && <span className="af-in">· in {folderName(flow.folder_id)}</span>}
                        </div>
                      </td>
                      {!inTrash && <td className="num">{runs[flow.id] ?? 0}</td>}
                      <td className="cell-muted af-when">{relativeTime(inTrash ? flow.deleted_at : flow.updated_at)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}
    </>
  );
}

/** "Move to…": pick a folder (or the top level) from the whole tree. */
function MoveDialog({
  folders,
  moving,
  onPick,
  onClose,
}: {
  folders: FlowFolder[];
  moving: Moving;
  onPick: (folder: string | null) => void;
  onClose: () => void;
}) {
  const here = moving.kind === "flow" ? moving.item.folder_id : moving.item.parent_id;
  const [chosen, setChosen] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // A folder can't go inside itself or anything below it.
  const blocked = (id: string) => moving.kind === "folder" && isInside(folders, id, moving.item.id);
  const rows = [{ id: null as string | null, name: "Automations", depth: 0 }].concat(
    folderTree(folders).map(({ folder, depth }) => ({ id: folder.id, name: folder.name, depth: depth + 1 })),
  );

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="pick-modal af-move" role="dialog" aria-label="Move to folder" onClick={(e) => e.stopPropagation()}>
        <header className="pick-head">
          <h2>Move “{moving.item.name}” to…</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">×</button>
        </header>
        <div className="pick-list">
          {rows.map((r) => {
            const isHere = r.id === here;
            const off = isHere || (r.id !== null && blocked(r.id));
            return (
              <button
                key={r.id ?? "top"}
                className={`pick-row af-move-row ${chosen === r.id ? "is-current" : ""}`}
                style={{ paddingLeft: 12 + r.depth * 20 }}
                disabled={off}
                onClick={() => setChosen(r.id)}
                onDoubleClick={() => !off && onPick(r.id)}
              >
                <FolderIcon />
                <span className="pick-name">{r.name}</span>
                {isHere && <span className="af-in">Current</span>}
              </button>
            );
          })}
          {folders.length === 0 && (
            <p className="mono" style={{ padding: "6px 12px 12px", margin: 0 }}>No folders yet. Create one with + New Folder.</p>
          )}
        </div>
        <footer className="pick-foot">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={chosen === undefined} onClick={() => chosen !== undefined && onPick(chosen)}>
            Move Here
          </button>
        </footer>
      </div>
    </div>
  );
}

function FolderIcon() {
  return (
    <svg className="af-folder-ic" width="18" height="18" viewBox="0 0 20 20" aria-hidden="true">
      <path d="M2.5 5.5a2 2 0 0 1 2-2h3.6l1.8 2h5.6a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-11a2 2 0 0 1-2-2v-9z" fill="currentColor" opacity=".9" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
