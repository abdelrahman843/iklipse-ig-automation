import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { Loader } from "../components/Loader";
import { friendlyError, toast } from "../components/Toast";
import { confirmDialog } from "../components/Confirm";
import { Composer } from "../components/Composer";
import { FlowPicker } from "../components/FlowPicker";
import { Crumbs, SaveState } from "../components/PageBits";
import { ConditionBuilder } from "../components/ConditionBuilder";
import { ContactAvatar, nameOf } from "../components/ContactBits";
import {
  blocksProblem,
  countAudience,
  listAudience,
  pct,
  toBlocks,
  type AudienceCondition,
  type Block,
} from "../lib/content";
import type { Contact } from "../lib/types";
import type { Broadcast } from "./Broadcasts";

const SAVE_DELAY_MS = 600;

const SECTION_OF: Record<Broadcast["status"], string> = {
  draft: "Drafts",
  scheduled: "Scheduled",
  sending: "History",
  sent: "History",
};

/** A datetime-local value for "now + minutes", in the browser's zone. */
function localInput(minutesAhead: number): string {
  const d = new Date(Date.now() + minutesAhead * 60_000);
  d.setSeconds(0, 0);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

export function BroadcastEditor() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [b, setB] = useState<Broadcast | null>(null);
  const [flowName, setFlowName] = useState<string | null>(null);
  const [reach, setReach] = useState<number | null>(null);
  const [stats, setStats] = useState<{ queued: number; delivered: number; failed: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "failed">("idle");
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);
  const [open, setOpen] = useState({ content: true, audience: true });
  const [scheduling, setScheduling] = useState(false);
  const [at, setAt] = useState(() => localInput(60));
  const [peek, setPeek] = useState<Contact[] | null>(null);

  // Edits autosave after a pause in typing, one write at a time.
  const pending = useRef<{ patch: Partial<Broadcast>; timer: number } | null>(null);
  const saving = useRef<Promise<boolean>>(Promise.resolve(true));

  useEffect(() => {
    (async () => {
      const { data, error } = await supabase.from("broadcast").select("*").eq("id", id).maybeSingle();
      if (error || !data) {
        setError(error ? friendlyError(error) : "This broadcast doesn't exist any more.");
        return;
      }
      const row = data as Broadcast;
      // Rows from before audience conditions kept one segment tag.
      if (!row.audience?.length && row.segment_tag) row.audience = [{ field: "tag", op: "is", value: row.segment_tag }];
      setB(row);
      if (row.status !== "draft") {
        const s = await supabase.rpc("broadcast_stats");
        const mine = (s.data ?? []).find((x: Record<string, unknown>) => x.broadcast_id === row.id);
        if (mine) setStats({ queued: Number(mine.queued), delivered: Number(mine.delivered), failed: Number(mine.failed) });
      }
    })();
    return () => void flush();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    if (!b?.flow_id) return setFlowName(null);
    supabase.from("flow").select("name").eq("id", b.flow_id).maybeSingle().then(({ data }) => setFlowName(data?.name ?? null));
  }, [b?.flow_id]);

  // Recount the audience whenever its conditions change.
  const audienceKey = JSON.stringify(b?.audience ?? []);
  useEffect(() => {
    if (!b || b.status !== "draft") return;
    setReach(null);
    const t = window.setTimeout(() => {
      countAudience(b.audience ?? []).then(setReach, (err) => toast.error(err));
    }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audienceKey, b?.status]);

  function flush(): Promise<boolean> {
    const p = pending.current;
    if (!p || !id) return saving.current;
    clearTimeout(p.timer);
    pending.current = null;
    const rowId = id; // from the URL, so the unmount flush still knows which row
    saving.current = saving.current.then(async () => {
      const { error } = await supabase.from("broadcast").update(p.patch).eq("id", rowId).eq("status", "draft");
      if (error) {
        setSaveState("failed");
        toast.error(error);
        return false;
      }
      if (!pending.current) setSaveState("saved");
      return true;
    });
    return saving.current;
  }

  function patch(p: Partial<Broadcast>) {
    if (!b || b.status !== "draft") return;
    setB({ ...b, ...p });
    setSaveState("saving");
    const merged = { ...(pending.current?.patch ?? {}), ...p };
    if (pending.current) clearTimeout(pending.current.timer);
    pending.current = { patch: merged, timer: window.setTimeout(() => void flush(), SAVE_DELAY_MS) };
  }

  if (error) {
    return (
      <div className="stack" style={{ gap: 12 }}>
        <div className="notice">{error}</div>
        <Link to="/broadcasts">← Back to Broadcasts</Link>
      </div>
    );
  }
  if (!b) return <Loader label="Loading broadcast" />;

  const editable = b.status === "draft";
  const blocks = toBlocks(b.content);
  const problem = b.flow_id ? null : blocksProblem(blocks);

  async function sendAt(when: Date) {
    if (!b) return;
    if (problem) return toast.error(problem);
    const now = when.getTime() <= Date.now() + 30_000;
    if (!now && when.getTime() < Date.now()) return toast.error("Pick a time in the future.");
    const ok = await confirmDialog({
      title: now ? `Send "${b.name}" now?` : `Schedule "${b.name}"?`,
      body: now
        ? `It goes to the ${reach ?? "matching"} contact${reach === 1 ? "" : "s"} whose 24-hour window is open right now. A sent broadcast can't be recalled.`
        : `It goes out ${when.toLocaleString()} to whoever matches the audience at that moment and messaged you in the 24 hours before.`,
      confirmLabel: now ? "Send Now" : "Schedule",
    });
    if (!ok) return;
    setBusy(true);
    try {
      if (!(await flush())) return; // the last edit did not save; don't send a stale draft
      const { data, error } = await supabase
        .from("broadcast")
        .update({ status: "scheduled", scheduled_at: when.toISOString(), segment_tag: null })
        .eq("id", b.id)
        .eq("status", "draft")
        .select("id");
      if (error) throw error;
      if (!data?.length) toast.info("This broadcast already left Drafts.");
      else toast.success(now ? "Broadcast is sending" : `Scheduled for ${when.toLocaleString()}`);
      navigate("/broadcasts");
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  }

  async function copyAndEdit() {
    if (!b) return;
    const { data, error } = await supabase
      .from("broadcast")
      .insert({ name: `${b.name} (copy)`, content: b.content, audience: b.audience, flow_id: b.flow_id })
      .select("id")
      .single();
    if (error) return toast.error(error);
    navigate(`/broadcasts/${data.id}`);
  }

  async function unschedule() {
    if (!b) return;
    const { data, error } = await supabase
      .from("broadcast")
      .update({ status: "draft", scheduled_at: null })
      .eq("id", b.id)
      .eq("status", "scheduled")
      .select("*")
      .maybeSingle();
    if (error) return toast.error(error);
    if (!data) return toast.info("It already started sending.");
    setB(data as Broadcast);
    toast.success("Moved back to Drafts");
  }

  const setConditions = (audience: AudienceCondition[]) => patch({ audience });

  const actions: ReactNode = editable ? (
    <>
      <SaveState state={saveState} />
      <button className={`btn btn-primary ${busy ? "is-busy" : ""}`} disabled={busy} onClick={() => sendAt(new Date())}>
        Send Now
      </button>
      <div className="pop-anchor">
        <button className="btn btn-primary btn-icon" disabled={busy} onClick={() => setScheduling((s) => !s)} aria-label="Schedule" title="Schedule for later">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <circle cx="8" cy="8" r="6.2" stroke="currentColor" strokeWidth="1.6" />
            <path d="M8 4.6V8l2.4 1.6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </button>
        {scheduling && (
          <div className="pop-card">
            <label className="label">Send on</label>
            <input className="input" type="datetime-local" value={at} min={localInput(1)} onChange={(e) => setAt(e.target.value)} />
            <p className="mono" style={{ margin: 0 }}>Your time zone ({Intl.DateTimeFormat().resolvedOptions().timeZone}).</p>
            <div className="row-between">
              <button className="btn btn-quiet" onClick={() => setScheduling(false)}>Cancel</button>
              <button className="btn btn-primary" disabled={!at} onClick={() => { setScheduling(false); sendAt(new Date(at)); }}>
                Schedule
              </button>
            </div>
          </div>
        )}
      </div>
    </>
  ) : b.status === "scheduled" ? (
    <>
      <span className="mono">Sends {b.scheduled_at ? new Date(b.scheduled_at).toLocaleString() : "soon"}</span>
      <button className="btn" onClick={unschedule}>Cancel schedule</button>
    </>
  ) : (
    <button className="btn btn-primary" onClick={copyAndEdit}>Copy &amp; Edit</button>
  );

  return (
    <div className="stack" style={{ gap: 14 }}>
      <Crumbs
        trail={[{ label: "Broadcasts", to: "/broadcasts" }, { label: SECTION_OF[b.status] }]}
        name={b.name}
        onRename={editable ? (name) => patch({ name }) : undefined}
        actions={actions}
      />

      {!editable && (
        <div className="published-bar">
          {b.status === "scheduled"
            ? "This broadcast is scheduled. Cancel the schedule to edit it."
            : "You are viewing a sent broadcast. Use Copy & Edit to send it again."}
        </div>
      )}

      {b.status !== "draft" && b.status !== "scheduled" && (
        <div className="stat-strip">
          <div><span className="stat-n">{b.sent_count}</span><span className="stat-l">Sent</span></div>
          <div><span className="stat-n">{stats ? pct(stats.delivered, stats.queued) : "n/a"}</span><span className="stat-l">Delivered</span></div>
          <div><span className="stat-n">{stats ? pct(stats.failed, stats.queued) : "n/a"}</span><span className="stat-l">Failed</span></div>
          <div><span className="stat-n">{b.sent_at ? new Date(b.sent_at).toLocaleString() : "—"}</span><span className="stat-l">Started</span></div>
        </div>
      )}

      <Fold title="Content" open={open.content} onToggle={() => setOpen((o) => ({ ...o, content: !o.content }))}
        right={b.flow_id ? null : editable ? <button className="link-btn" onClick={() => setPicking(true)}>Send an automation instead</button> : null}>
        {b.flow_id ? (
          <div className="flow-choice">
            <div>
              <span className="label" style={{ margin: 0 }}>Sends this automation</span>
              <p className="flow-choice-name">{flowName ?? "Deleted automation"}</p>
              <p className="mono" style={{ margin: 0 }}>Each contact starts it from its first step, just like when its trigger fires.</p>
            </div>
            <div className="cluster" style={{ gap: 8 }}>
              <Link className="btn" to={`/flows/${b.flow_id}`}>Open automation</Link>
              {editable && <button className="btn" onClick={() => setPicking(true)}>Change</button>}
              {editable && (
                <button className="btn btn-quiet" onClick={() => patch({ flow_id: null, content: { blocks: [{ text: "", buttons: [] }] } })}>
                  Write a message instead
                </button>
              )}
            </div>
          </div>
        ) : (
          <Composer blocks={blocks} disabled={!editable} onChange={(next: Block[]) => patch({ content: { blocks: next } })} />
        )}
      </Fold>

      <Fold
        title="Target Audience"
        open={open.audience}
        onToggle={() => setOpen((o) => ({ ...o, audience: !o.audience }))}
        right={
          editable ? (
            <span className="reach"><strong>{reach ?? "…"}</strong> contact{reach === 1 ? "" : "s"} will receive this broadcast</span>
          ) : null
        }
      >
        <div className="stack" style={{ gap: 12 }}>
          <p style={{ margin: 0 }}>
            Send to contacts matching <strong>all of the following conditions:</strong>
          </p>
          <ConditionBuilder conditions={b.audience ?? []} onChange={setConditions} disabled={!editable} exclude={["subscribed"]} />
          {editable && (
            <button className="link-btn" style={{ alignSelf: "flex-start" }} onClick={() => listAudience(b.audience ?? []).then(setPeek, (e) => toast.error(e))}>
              Preview {reach ?? ""} contact{reach === 1 ? "" : "s"} who will receive this broadcast
            </button>
          )}
          <div className="info-banner">
            Instagram only delivers to people who messaged you in the last 24 hours, so everyone else is left out automatically. Contacts who sent STOP are left out too.
          </div>
        </div>
      </Fold>

      {picking && (
        <FlowPicker
          title="Broadcast an automation"
          onClose={() => setPicking(false)}
          onPick={(flow) => {
            setPicking(false);
            patch({ flow_id: flow.id });
          }}
        />
      )}

      {peek && (
        <div className="modal-scrim" onClick={() => setPeek(null)}>
          <div className="pick-modal" role="dialog" aria-label="Recipients" onClick={(e) => e.stopPropagation()}>
            <header className="pick-head">
              <h2>Who gets this broadcast</h2>
              <button className="icon-btn" onClick={() => setPeek(null)} aria-label="Close">×</button>
            </header>
            <div className="pick-list">
              {peek.length === 0 ? (
                <p className="mono" style={{ padding: 16, margin: 0 }}>Nobody matches right now.</p>
              ) : (
                peek.map((c) => (
                  <div key={c.id} className="pick-row is-static ct-peek">
                    <ContactAvatar contact={c} size={28} />
                    <span className="pick-name" dir="auto">{nameOf(c)}</span>
                    {c.username && <span className="cell-muted">@{c.username}</span>}
                  </div>
                ))
              )}
              {peek.length === 50 && <p className="mono" style={{ padding: "8px 16px" }}>Showing the 50 most recent.</p>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** A collapsible white section with its title on the left and a summary on the right. */
function Fold({ title, open, onToggle, right, children }: { title: string; open: boolean; onToggle: () => void; right?: ReactNode; children: ReactNode }) {
  return (
    <section className={`fold ${open ? "is-open" : ""}`}>
      <div className="fold-head">
        <button className="fold-toggle" onClick={onToggle} aria-expanded={open}>
          {title}
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
            <path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </button>
        {right}
      </div>
      {open && <div className="fold-body">{children}</div>}
    </section>
  );
}
