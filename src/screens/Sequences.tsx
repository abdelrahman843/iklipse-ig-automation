import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { Loader } from "../components/Loader";
import { friendlyError, toast } from "../components/Toast";
import { confirmDialog, promptDialog } from "../components/Confirm";
import { RowMenu } from "../components/PageBits";
import { pct } from "../lib/content";

export interface Sequence {
  id: string;
  name: string;
  status: "active" | "paused";
  created_at: string;
}

interface Totals {
  subscribers: number;
  messages: number;
  live: number;
  queued: number;
  delivered: number;
}

/**
 * Sequences, like ManyChat: one table of sequences with their subscribers, message count and
 * delivery. A sequence opens in its own page where its messages are scheduled.
 */
export function Sequences() {
  const navigate = useNavigate();
  const [rows, setRows] = useState<Sequence[]>([]);
  const [totals, setTotals] = useState<Record<string, Totals>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      const [seqs, steps, subs, stats] = await Promise.all([
        supabase.from("sequence").select("*").order("created_at", { ascending: false }),
        supabase.from("sequence_step").select("id, sequence_id, active"),
        supabase.from("sequence_subscription").select("sequence_id").eq("status", "active"),
        supabase.rpc("sequence_step_stats"),
      ]);
      if (seqs.error) throw seqs.error;
      setRows((seqs.data ?? []) as Sequence[]);

      const t: Record<string, Totals> = {};
      const blank = (): Totals => ({ subscribers: 0, messages: 0, live: 0, queued: 0, delivered: 0 });
      const seqOfStep: Record<string, string> = {};
      for (const s of steps.data ?? []) {
        const x = (t[s.sequence_id] ??= blank());
        x.messages++;
        if (s.active) x.live++;
        seqOfStep[s.id] = s.sequence_id;
      }
      for (const s of subs.data ?? []) (t[s.sequence_id] ??= blank()).subscribers++;
      for (const s of (stats.data ?? []) as Record<string, unknown>[]) {
        const seq = seqOfStep[s.sequence_step_id as string];
        if (!seq) continue;
        t[seq].queued += Number(s.queued);
        t[seq].delivered += Number(s.delivered);
      }
      setTotals(t);
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

  async function create() {
    const name = await promptDialog({ title: "New sequence", placeholder: "Sequence name", initial: "", confirmLabel: "Create" });
    if (!name || busy) return;
    setBusy(true);
    try {
      const { data, error } = await supabase.from("sequence").insert({ name }).select("id").single();
      if (error) throw error;
      navigate(`/sequences/${data.id}`);
    } catch (err) {
      toast.error(err);
      setBusy(false);
    }
  }

  async function rename(s: Sequence) {
    const name = await promptDialog({ title: "Rename sequence", initial: s.name, confirmLabel: "Rename" });
    if (!name || name === s.name) return;
    const { error } = await supabase.from("sequence").update({ name }).eq("id", s.id);
    if (error) return toast.error(error);
    setRows((r) => r.map((x) => (x.id === s.id ? { ...x, name } : x)));
  }

  async function duplicate(s: Sequence) {
    try {
      const { data: copy, error } = await supabase.from("sequence").insert({ name: `${s.name} (copy)` }).select("id").single();
      if (error) throw error;
      const { data: steps, error: stepsError } = await supabase.from("sequence_step").select("*").eq("sequence_id", s.id);
      if (stepsError) throw stepsError;
      if (steps?.length) {
        const { error: insError } = await supabase.from("sequence_step").insert(
          steps.map(({ id: _id, created_at: _c, sequence_id: _s, ...rest }) => ({ ...rest, sequence_id: copy.id })),
        );
        if (insError) throw insError;
      }
      toast.success("Sequence duplicated");
      load();
    } catch (err) {
      toast.error(err);
    }
  }

  async function remove(s: Sequence) {
    const subs = totals[s.id]?.subscribers ?? 0;
    const ok = await confirmDialog({
      title: `Delete "${s.name}"?`,
      body: subs
        ? `${subs} contact${subs === 1 ? " is" : "s are"} still subscribed and will stop getting its messages. This can't be undone.`
        : "Its messages go with it. This can't be undone.",
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    const { error } = await supabase.from("sequence").delete().eq("id", s.id);
    if (error) return toast.error(error);
    setRows((r) => r.filter((x) => x.id !== s.id));
    toast.success("Sequence deleted");
  }

  return (
    <>
      <header className="page-bar">
        <h1 className="page-title">Sequences</h1>
        <button className={`btn btn-primary ${busy ? "is-busy" : ""}`} onClick={create} disabled={busy}>+ New Sequence</button>
      </header>

      {error && <div className="notice" style={{ marginBottom: 16 }}>{error}</div>}

      {loading ? (
        <Loader label="Loading sequences" />
      ) : rows.length === 0 && !error ? (
        <div className="empty">
          <p style={{ margin: "0 0 6px", color: "var(--ink)", fontWeight: 600 }}>No sequences yet</p>
          <p style={{ margin: "0 0 16px" }}>
            A sequence sends a series of messages, each a set time after the last. Contacts join it from an automation's Action step.
          </p>
          <button className="btn btn-primary" onClick={create} disabled={busy}>+ New Sequence</button>
        </div>
      ) : (
        <div className="mc-card">
          <table className="mc-table">
            <thead>
              <tr>
                <th className="col-menu" /><th>Name</th>
                <th className="num">Subscribers</th><th className="num">Messages</th>
                <th className="num">Sent</th><th className="num">Delivered (%)</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => {
                const t = totals[s.id];
                const open = () => navigate(`/sequences/${s.id}`);
                return (
                  <tr key={s.id} onClick={open} tabIndex={0} onKeyDown={(e) => e.key === "Enter" && open()}>
                    <td className="col-menu">
                      <RowMenu items={[
                        { label: "Rename", onSelect: () => rename(s) },
                        { label: "Duplicate", onSelect: () => duplicate(s) },
                        { label: "Delete", onSelect: () => remove(s), danger: true },
                      ]} />
                    </td>
                    <td className="cell-name">
                      <span className={`dot ${t?.live ? "is-on" : ""}`} title={t?.live ? "At least one message is on" : "All messages are off"} />
                      {s.name}
                    </td>
                    <td className="num">{t?.subscribers ?? 0}</td>
                    <td className="num">{t?.messages ?? 0}</td>
                    <td className="num">{t?.queued ?? 0}</td>
                    <td className="num">{t ? pct(t.delivered, t.queued) : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
