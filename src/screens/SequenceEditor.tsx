import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useAccountTimezone } from "../lib/settings";
import { supabase } from "../lib/supabase";
import { Loader } from "../components/Loader";
import { Select } from "../components/Select";
import { friendlyError, toast } from "../components/Toast";
import { confirmDialog } from "../components/Confirm";
import { Composer } from "../components/Composer";
import { FlowPicker } from "../components/FlowPicker";
import { Crumbs, SaveState, Toggle } from "../components/PageBits";
import { blocksProblem, hasBody, pct, summarize, toBlocks, type Block, type StoredContent } from "../lib/content";
import type { Sequence } from "./Sequences";

interface SendWindow {
  from: string;
  to: string;
  days?: number[];
  tz?: string;
}

interface Step {
  id: string;
  sequence_id: string;
  sort: number;
  delay_seconds: number;
  content: StoredContent;
  flow_id: string | null;
  active: boolean;
  send_window: SendWindow | null;
}

const SAVE_DELAY_MS = 500;
const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const UNITS = [
  { value: "0", label: "Immediately" },
  { value: "60", label: "Minutes" },
  { value: "3600", label: "Hours" },
  { value: "86400", label: "Days" },
];

function bestUnit(seconds: number): number {
  if (seconds === 0) return 0;
  for (const u of [86400, 3600, 60]) if (seconds % u === 0) return u;
  return 60;
}

/** "Immediately", "After 1 day", "After 3 hours". */
function scheduleLabel(seconds: number): string {
  const unit = bestUnit(seconds);
  if (!unit) return "Immediately";
  const n = Math.round(seconds / unit);
  const name = unit === 86400 ? "day" : unit === 3600 ? "hour" : "minute";
  return `After ${n} ${name}${n === 1 ? "" : "s"}`;
}

/**
 * One sequence, laid out like ManyChat: a Schedule column down the left ("Immediately", "After 1
 * day"), then a row per message with its on/off switch, what it sends and its delivery.
 */
export function SequenceEditor() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [seq, setSeq] = useState<Sequence | null>(null);
  const [steps, setSteps] = useState<Step[]>([]);
  const [flows, setFlows] = useState<Record<string, string>>({});
  const [subs, setSubs] = useState(0);
  const [stats, setStats] = useState<Record<string, { queued: number; delivered: number; failed: number }>>({});
  const [error, setError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "failed">("idle");
  const [editing, setEditing] = useState<string | null>(null); // step id in the message drawer
  const [scheduling, setScheduling] = useState<string | null>(null); // step id with the schedule pop-over
  const [picking, setPicking] = useState<string | null>(null); // step id choosing an automation
  const [adding, setAdding] = useState(false);

  async function load() {
    const [s, st, sb, stat, fl] = await Promise.all([
      supabase.from("sequence").select("*").eq("id", id).maybeSingle(),
      supabase.from("sequence_step").select("*").eq("sequence_id", id).order("sort"),
      supabase.from("sequence_subscription").select("id", { count: "exact", head: true }).eq("sequence_id", id).eq("status", "active"),
      supabase.rpc("sequence_step_stats"),
      supabase.from("flow").select("id, name"),
    ]);
    if (s.error || !s.data) {
      setError(s.error ? friendlyError(s.error) : "This sequence doesn't exist any more.");
      return;
    }
    setSeq(s.data as Sequence);
    setSteps((st.data ?? []) as Step[]);
    setSubs(sb.count ?? 0);
    setFlows(Object.fromEntries((fl.data ?? []).map((f) => [f.id, f.name])));
    setStats(
      Object.fromEntries(
        ((stat.data ?? []) as Record<string, unknown>[]).map((x) => [
          x.sequence_step_id as string,
          { queued: Number(x.queued), delivered: Number(x.delivered), failed: Number(x.failed) },
        ]),
      ),
    );
  }

  // Edits autosave per row after a pause in typing, one write at a time.
  const pending = useRef(new Map<string, { table: "sequence" | "sequence_step"; patch: Record<string, unknown>; timer: number }>());
  const saving = useRef<Promise<unknown>>(Promise.resolve());

  function queue(table: "sequence" | "sequence_step", rowId: string, patch: Record<string, unknown>) {
    setSaveState("saving");
    const prev = pending.current.get(rowId);
    if (prev) clearTimeout(prev.timer);
    pending.current.set(rowId, {
      table,
      patch: { ...(prev?.patch ?? {}), ...patch },
      timer: window.setTimeout(() => void flushRow(rowId), SAVE_DELAY_MS),
    });
  }

  function flushRow(rowId: string): Promise<unknown> {
    const p = pending.current.get(rowId);
    if (!p) return saving.current;
    clearTimeout(p.timer);
    pending.current.delete(rowId);
    saving.current = saving.current.then(async () => {
      const { error } = await supabase.from(p.table).update(p.patch).eq("id", rowId);
      if (error) {
        setSaveState("failed");
        toast.error(error);
        await load();
      } else if (pending.current.size === 0) {
        setSaveState("saved");
      }
    });
    return saving.current;
  }

  useEffect(() => {
    load();
    const queued = pending.current;
    return () => {
      for (const key of [...queued.keys()]) void flushRow(key);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  function patchStep(stepId: string, patch: Partial<Step>) {
    setSteps((s) => s.map((x) => (x.id === stepId ? { ...x, ...patch } : x)));
    queue("sequence_step", stepId, patch);
  }

  async function addMessage() {
    if (adding || !id) return;
    setAdding(true);
    const sort = steps.length ? Math.max(...steps.map((s) => s.sort)) + 1 : 0;
    // Instagram drops anything sent after the 24-hour window, so follow-ups default to an hour.
    const { data, error } = await supabase
      .from("sequence_step")
      .insert({ sequence_id: id, sort, delay_seconds: steps.length ? 3600 : 0, content: { blocks: [] }, active: false })
      .select()
      .single();
    setAdding(false);
    if (error) return toast.error(error);
    setSteps((s) => [...s, data as Step]);
  }

  async function removeStep(step: Step, index: number) {
    const ok = await confirmDialog({
      title: `Delete message ${index + 1}?`,
      body: "Contacts who haven't reached it yet will skip it. This can't be undone.",
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    const p = pending.current.get(step.id);
    if (p) clearTimeout(p.timer);
    pending.current.delete(step.id);
    const { error } = await supabase.from("sequence_step").delete().eq("id", step.id);
    if (error) return toast.error(error);
    setSteps((s) => s.filter((x) => x.id !== step.id));
  }

  function setActive(step: Step, on: boolean) {
    if (on) {
      const problem = step.flow_id ? null : blocksProblem(toBlocks(step.content));
      if (problem) {
        toast.error(`Message ${steps.indexOf(step) + 1} can't go on yet. ${problem}`);
        setEditing(step.id);
        return;
      }
    }
    patchStep(step.id, { active: on });
  }

  /** Closing a message that just became sendable switches it on, so it isn't forgotten off. */
  function closeEditor() {
    const st = steps.find((s) => s.id === editing);
    if (st && !st.active && !st.flow_id && !blocksProblem(toBlocks(st.content))) patchStep(st.id, { active: true });
    setEditing(null);
  }

  if (error) {
    return (
      <div className="stack" style={{ gap: 12 }}>
        <div className="notice">{error}</div>
        <Link to="/sequences">← Back to Sequences</Link>
      </div>
    );
  }
  if (!seq) return <Loader label="Loading sequence" />;

  const editStep = steps.find((s) => s.id === editing) ?? null;
  // Total time from subscribing to each message; past 24h it only lands if the contact wrote again.
  let elapsed = 0;

  return (
    <div className="stack" style={{ gap: 16 }}>
      <Crumbs
        trail={[{ label: "Sequences", to: "/sequences" }]}
        name={seq.name}
        onRename={(name) => {
          setSeq({ ...seq, name });
          queue("sequence", seq.id, { name });
        }}
        actions={
          <>
            <SaveState state={saveState} />
            <span className="mono">{subs} subscriber{subs === 1 ? "" : "s"}</span>
          </>
        }
      />

      <div className="info-banner">
        Instagram only delivers inside a contact's 24-hour window. A message that comes due more than 24 hours after their
        last message is skipped, so keep the gaps short. Contacts join from an automation's Action step → "Subscribe to a sequence".
      </div>

      <div className="seq-grid">
        <div className="seq-line seq-head-line">
          <span className="sg-schedule">Schedule</span>
          <div className="seq-grid-head">
            <span>Active</span>
            <span />
            <span className="num">Sent</span>
            <span className="num">Delivered (%)</span>
            <span />
          </div>
        </div>

        {steps.map((step, i) => {
          elapsed += step.delay_seconds;
          const late = elapsed >= 24 * 3600;
          const s = stats[step.id];
          const blocks = toBlocks(step.content);
          const empty = !step.flow_id && !blocks.some(hasBody);
          return (
            <div key={step.id} className="seq-line">
              <div className="sg-schedule pop-anchor">
                <button
                  className={`schedule-pill ${late ? "is-late" : ""}`}
                  onClick={() => setScheduling(scheduling === step.id ? null : step.id)}
                  title={late ? "This lands more than 24 hours after subscribing, so it only reaches contacts who wrote again since." : undefined}
                >
                  {scheduleLabel(step.delay_seconds)}
                  {step.send_window && <span className="schedule-sub">{step.send_window.from}–{step.send_window.to}</span>}
                </button>
                <span className="seq-node" aria-hidden="true" />
                {scheduling === step.id && (
                  <SchedulePop
                    first={i === 0}
                    step={step}
                    onClose={() => setScheduling(null)}
                    onSave={(patch) => {
                      patchStep(step.id, patch);
                      setScheduling(null);
                    }}
                  />
                )}
              </div>
              <div className="seq-row-card">
                <span className="sg-active">
                  <Toggle on={step.active} onChange={(on) => setActive(step, on)} label={`Message ${i + 1} on`} />
                </span>
                <span className="sg-msg">
                  {empty ? (
                    <span className="create-or">
                      <button className="link-btn" onClick={() => setEditing(step.id)}>Create New Message</button>
                      <span>or</span>
                      <button className="link-btn" onClick={() => setPicking(step.id)}>Select Existing</button>
                    </span>
                  ) : (
                    <button className="msg-link" onClick={() => (step.flow_id ? navigate(`/flows/${step.flow_id}`) : setEditing(step.id))}>
                      <span className="msg-verb">Send</span>
                      <span className="msg-name">{step.flow_id ? flows[step.flow_id] ?? "Deleted automation" : summarize(step.content)}</span>
                    </button>
                  )}
                </span>
                <span className="num">{s?.queued ?? 0}</span>
                <span className="num">{s ? pct(s.delivered, s.queued) : "—"}</span>
                <span className="sg-tools">
                  {!empty && (
                    <button className="icon-btn" onClick={() => (step.flow_id ? setPicking(step.id) : setEditing(step.id))} aria-label="Edit message" title="Edit">
                      <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
                        <path d="M11.5 2.5l2 2L6 12l-3 1 1-3 7.5-7.5z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
                      </svg>
                    </button>
                  )}
                  <button className="icon-btn" onClick={() => removeStep(step, i)} aria-label={`Delete message ${i + 1}`} title="Delete">
                    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
                      <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
                    </svg>
                  </button>
                </span>
              </div>
            </div>
          );
        })}

        <div className="seq-add">
          <button className={`btn ${adding ? "is-busy" : ""}`} onClick={addMessage} disabled={adding}>+ Message</button>
        </div>
      </div>

      {editStep && (
        <div className="sheet-scrim" onClick={() => closeEditor()}>
          <aside className="msg-drawer" role="dialog" aria-label="Edit message" onClick={(e) => e.stopPropagation()}>
            <header className="msg-drawer-head">
              <div>
                <span className="mono">{seq.name}</span>
                <h2>Message {steps.indexOf(editStep) + 1}</h2>
              </div>
              <div className="cluster" style={{ gap: 8 }}>
                <SaveState state={saveState} />
                <button className="btn btn-primary" onClick={() => closeEditor()}>Done</button>
              </div>
            </header>
            <div className="msg-drawer-body">
              <Composer
                blocks={toBlocks(editStep.content)}
                onChange={(next: Block[]) => patchStep(editStep.id, { content: { blocks: next } })}
                aside={
                  <button className="link-btn" style={{ marginTop: 14 }} onClick={() => setPicking(editStep.id)}>
                    Send an existing automation instead
                  </button>
                }
              />
            </div>
          </aside>
        </div>
      )}

      {picking && (
        <FlowPicker
          title="Send an automation"
          onClose={() => setPicking(null)}
          onPick={(flow) => {
            const stepId = picking;
            setPicking(null);
            setEditing(null);
            patchStep(stepId, { flow_id: flow.id, active: true });
          }}
        />
      )}
    </div>
  );
}

/** ManyChat's schedule pop-over: the delay, an optional time window, and the days. */
function SchedulePop({
  first,
  step,
  onSave,
  onClose,
}: {
  first: boolean;
  step: Step;
  onSave: (patch: Partial<Step>) => void;
  onClose: () => void;
}) {
  const [unit, setUnit] = useState(() => bestUnit(step.delay_seconds));
  const [amount, setAmount] = useState(() => (step.delay_seconds && bestUnit(step.delay_seconds) ? step.delay_seconds / bestUnit(step.delay_seconds) : 1));
  const [windowed, setWindowed] = useState(Boolean(step.send_window));
  const [from, setFrom] = useState(step.send_window?.from ?? "08:00");
  const [to, setTo] = useState(step.send_window?.to ?? "22:00");
  const [days, setDays] = useState<number[]>(step.send_window?.days ?? []);
  // A window keeps the zone it was set in; a new one takes Settings › General's.
  const accountTz = useAccountTimezone();
  const tz = step.send_window?.tz ?? accountTz;

  function save() {
    const seconds = unit === 0 ? 0 : Math.max(1, Math.round(amount)) * unit;
    onSave({
      delay_seconds: seconds,
      send_window: windowed ? { from, to, days, tz } : null,
    });
  }

  return (
    <div className="pop-card schedule-pop" onClick={(e) => e.stopPropagation()}>
      <p style={{ margin: 0 }}>
        This message will be sent at least
      </p>
      <div className="cluster" style={{ gap: 6, flexWrap: "nowrap" }}>
        {unit !== 0 && (
          <input className="input" type="number" min={1} style={{ width: 72 }} value={amount} onChange={(e) => setAmount(Number(e.target.value) || 1)} aria-label="Amount" />
        )}
        <div style={{ flex: 1 }}>
          <Select value={String(unit)} onChange={(v) => setUnit(Number(v))} ariaLabel="Unit" options={UNITS} />
        </div>
      </div>
      <p style={{ margin: 0 }}>{first ? "after the contact subscribes" : "after the previous message"} (a day is 24 hours).</p>

      <Select
        value={windowed ? "between" : "any"}
        onChange={(v) => setWindowed(v === "between")}
        ariaLabel="Send time"
        options={[{ value: "any", label: "Any time" }, { value: "between", label: "Send between" }]}
      />
      {windowed && (
        <>
          <div className="cluster" style={{ gap: 6, flexWrap: "nowrap" }}>
            <span>From</span>
            <input className="input" type="time" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From" />
            <span>to</span>
            <input className="input" type="time" value={to} onChange={(e) => setTo(e.target.value)} aria-label="To" />
          </div>
          <div className="day-picks" role="group" aria-label="Days">
            {DAY_NAMES.map((d, i) => {
              const n = i + 1;
              const on = days.length === 0 || days.includes(n);
              return (
                <button
                  key={d}
                  type="button"
                  className={`day-pick ${on ? "on" : ""}`}
                  aria-pressed={on}
                  onClick={() => {
                    const all = days.length ? days : [1, 2, 3, 4, 5, 6, 7];
                    const next = on ? all.filter((x) => x !== n) : [...all, n].sort();
                    setDays(next.length === 7 ? [] : next);
                  }}
                >
                  {d}
                </button>
              );
            })}
          </div>
          <p className="mono" style={{ margin: 0 }}>Times are in {tz.replace(/_/g, " ")}.</p>
        </>
      )}
      <div className="row-between">
        <button className="btn btn-quiet" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={save}>Save Schedule</button>
      </div>
    </div>
  );
}
