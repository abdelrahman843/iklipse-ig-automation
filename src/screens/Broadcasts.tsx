import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { Loader } from "../components/Loader";
import { friendlyError, toast } from "../components/Toast";
import { confirmDialog } from "../components/Confirm";
import { FlowPicker } from "../components/FlowPicker";
import { RowMenu } from "../components/PageBits";
import { pct, summarize, type AudienceCondition, type StoredContent } from "../lib/content";
import { relativeTime } from "../lib/time";
import type { Flow } from "../lib/types";

export interface Broadcast {
  id: string;
  name: string;
  segment_tag: string | null;
  audience: AudienceCondition[];
  flow_id: string | null;
  content: StoredContent;
  status: "draft" | "scheduled" | "sending" | "sent";
  scheduled_at: string | null;
  sent_count: number;
  created_at: string;
  updated_at: string;
  sent_at: string | null;
}

interface Stat {
  queued: number;
  delivered: number;
  failed: number;
}

/** Rows shown per section before "View all". */
const PREVIEW_ROWS = 5;

const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";

/** A fresh draft's name: "Broadcast Oct 1, 14:05". */
const draftName = () =>
  `Broadcast ${new Date().toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}`;

/**
 * Broadcasts, laid out like ManyChat: Drafts, Scheduled and History sections, each a table. A
 * broadcast is opened in its own page to edit content, pick the audience and send or schedule.
 */
export function Broadcasts() {
  const navigate = useNavigate();
  const [rows, setRows] = useState<Broadcast[]>([]);
  const [flows, setFlows] = useState<Record<string, string>>({});
  const [stats, setStats] = useState<Record<string, Stat>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      const [b, f, s] = await Promise.all([
        supabase.from("broadcast").select("*").order("created_at", { ascending: false }),
        supabase.from("flow").select("id, name"),
        supabase.rpc("broadcast_stats"),
      ]);
      if (b.error) throw b.error;
      setRows((b.data ?? []) as Broadcast[]);
      setFlows(Object.fromEntries((f.data ?? []).map((x) => [x.id, x.name])));
      if (s.error) toast.error(s.error);
      setStats(Object.fromEntries((s.data ?? []).map((x: Record<string, unknown>) => [x.broadcast_id, { queued: Number(x.queued), delivered: Number(x.delivered), failed: Number(x.failed) }])));
      setError(null);
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function create(fields: Partial<Broadcast>) {
    if (busy) return;
    setBusy(true);
    try {
      const { data, error } = await supabase.from("broadcast").insert(fields).select("id").single();
      if (error) throw error;
      navigate(`/broadcasts/${data.id}`);
    } catch (err) {
      toast.error(err);
      setBusy(false);
    }
  }

  const newBroadcast = () => create({ name: draftName(), content: { blocks: [{ text: "", buttons: [] }] } });
  const fromAutomation = (flow: Flow) => {
    setPicking(false);
    create({ name: flow.name, flow_id: flow.id, content: { blocks: [] } });
  };

  async function duplicate(b: Broadcast) {
    const { error } = await supabase.from("broadcast").insert({
      name: `${b.name} (copy)`,
      content: b.content,
      audience: b.audience,
      flow_id: b.flow_id,
      segment_tag: b.segment_tag,
    });
    if (error) return toast.error(error);
    toast.success("Copied to Drafts");
    load();
  }

  async function unschedule(b: Broadcast) {
    const { data, error } = await supabase
      .from("broadcast")
      .update({ status: "draft", scheduled_at: null })
      .eq("id", b.id)
      .eq("status", "scheduled")
      .select("id");
    if (error) return toast.error(error);
    if (!data?.length) toast.info("It already started sending.");
    else toast.success("Moved back to Drafts");
    load();
  }

  async function remove(b: Broadcast) {
    const ok = await confirmDialog({
      title: `Delete "${b.name}"?`,
      body: b.status === "sent" ? "Its stats go with it. Contacts already reached keep their message." : "This can't be undone.",
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    const { error } = await supabase.from("broadcast").delete().eq("id", b.id);
    if (error) return toast.error(error);
    setRows((r) => r.filter((x) => x.id !== b.id));
    toast.success("Broadcast deleted");
  }

  const drafts = useMemo(() => rows.filter((r) => r.status === "draft").sort((a, b) => b.updated_at.localeCompare(a.updated_at)), [rows]);
  const scheduled = useMemo(() => rows.filter((r) => r.status === "scheduled").sort((a, b) => (a.scheduled_at ?? "").localeCompare(b.scheduled_at ?? "")), [rows]);
  const history = useMemo(() => rows.filter((r) => r.status === "sending" || r.status === "sent").sort((a, b) => (b.sent_at ?? b.created_at).localeCompare(a.sent_at ?? a.created_at)), [rows]);

  const what = (b: Broadcast) => (b.flow_id ? `Automation: ${flows[b.flow_id] ?? "deleted"}` : summarize(b.content) || "Empty message");
  const open = (b: Broadcast) => navigate(`/broadcasts/${b.id}`);

  return (
    <>
      <header className="page-bar">
        <h1 className="page-title">Broadcasts</h1>
        <div className="cluster" style={{ gap: 8 }}>
          <button className="btn btn-outline" onClick={() => setPicking(true)} disabled={busy}>Broadcast From Automation</button>
          <button className={`btn btn-primary ${busy ? "is-busy" : ""}`} onClick={newBroadcast} disabled={busy}>New Broadcast</button>
        </div>
      </header>

      {picking && <FlowPicker title="Broadcast an automation" onPick={fromAutomation} onClose={() => setPicking(false)} />}
      {error && <div className="notice" style={{ marginBottom: 16 }}>{error}</div>}

      {loading ? (
        <Loader label="Loading broadcasts" />
      ) : rows.length === 0 && !error ? (
        <div className="empty">
          <p style={{ margin: "0 0 6px", color: "var(--ink)", fontWeight: 600 }}>No broadcasts yet</p>
          <p style={{ margin: "0 0 16px" }}>
            A broadcast sends one message to everyone who messaged you in the last 24 hours, or to a tagged group of them.
          </p>
          <button className="btn btn-primary" onClick={newBroadcast} disabled={busy}>New Broadcast</button>
        </div>
      ) : (
        <div className="stack" style={{ gap: 28 }}>
          <Section title="Drafts" rows={drafts} empty="No drafts.">
            {(list) => (
              <table className="mc-table">
                <thead>
                  <tr><th className="col-menu" /><th>Name</th><th>Content</th><th>Last Edit</th></tr>
                </thead>
                <tbody>
                  {list.map((b) => (
                    <tr key={b.id} onClick={() => open(b)} tabIndex={0} onKeyDown={(e) => e.key === "Enter" && open(b)}>
                      <td className="col-menu">
                        <RowMenu items={[
                          { label: "Edit", onSelect: () => open(b) },
                          { label: "Duplicate", onSelect: () => duplicate(b) },
                          { label: "Delete", onSelect: () => remove(b), danger: true },
                        ]} />
                      </td>
                      <td className="cell-name">{b.name}</td>
                      <td className="cell-muted cell-clip">{what(b)}</td>
                      <td className="cell-muted">{relativeTime(b.updated_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Section>

          {scheduled.length > 0 && (
            <Section title="Scheduled" rows={scheduled}>
              {(list) => (
                <table className="mc-table">
                  <thead>
                    <tr><th className="col-menu" /><th>Name</th><th>Content</th><th>Sends</th></tr>
                  </thead>
                  <tbody>
                    {list.map((b) => (
                      <tr key={b.id} onClick={() => open(b)} tabIndex={0} onKeyDown={(e) => e.key === "Enter" && open(b)}>
                        <td className="col-menu">
                          <RowMenu items={[
                            { label: "View", onSelect: () => open(b) },
                            { label: "Cancel schedule", onSelect: () => unschedule(b) },
                            { label: "Duplicate", onSelect: () => duplicate(b) },
                            { label: "Delete", onSelect: () => remove(b), danger: true },
                          ]} />
                        </td>
                        <td className="cell-name">{b.name}</td>
                        <td className="cell-muted cell-clip">{what(b)}</td>
                        <td>{when(b.scheduled_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Section>
          )}

          <Section title="History" rows={history} empty="Nothing sent yet.">
            {(list) => (
              <table className="mc-table">
                <thead>
                  <tr>
                    <th className="col-menu" /><th>Name</th><th>Start</th>
                    <th className="num">Sent</th><th className="num">Delivered (%)</th><th className="num">Failed (%)</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((b) => {
                    const s = stats[b.id];
                    return (
                      <tr key={b.id} onClick={() => open(b)} tabIndex={0} onKeyDown={(e) => e.key === "Enter" && open(b)}>
                        <td className="col-menu">
                          <RowMenu items={[
                            { label: "View", onSelect: () => open(b) },
                            { label: "Copy & Edit", onSelect: () => duplicate(b) },
                            { label: "Delete", onSelect: () => remove(b), danger: true },
                          ]} />
                        </td>
                        <td className="cell-name">
                          {b.name}
                          {b.status === "sending" && <span className="pill" style={{ marginLeft: 8 }}>Sending</span>}
                        </td>
                        <td className="cell-muted">{when(b.sent_at ?? b.scheduled_at)}</td>
                        <td className="num">{b.sent_count}</td>
                        <td className="num">{s ? pct(s.delivered, s.queued) : "n/a"}</td>
                        <td className="num">{s ? pct(s.failed, s.queued) : "n/a"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </Section>
        </div>
      )}
    </>
  );
}

/** A titled white card holding a table, with "View All N" once it outgrows the preview. */
function Section<T>({ title, rows, empty, children }: { title: string; rows: T[]; empty?: string; children: (rows: T[]) => ReactNode }) {
  const [all, setAll] = useState(false);
  const shown = all ? rows : rows.slice(0, PREVIEW_ROWS);
  return (
    <section>
      <h2 className="section-title">{title}</h2>
      <div className="mc-card">
        {rows.length === 0 ? (
          <p className="mc-empty">{empty}</p>
        ) : (
          <>
            {children(shown)}
            {rows.length > PREVIEW_ROWS && (
              <div className="mc-more">
                <button className="btn" onClick={() => setAll((a) => !a)}>
                  {all ? "Show fewer" : `View All ${rows.length} Messages`}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}
