import { useEffect, useRef, useState, type ReactNode } from "react";
import { supabase } from "../lib/supabase";
import { relativeTime } from "../lib/time";
import { Select } from "./Select";
import { toast } from "./Toast";
import { promptDialog } from "./Confirm";
import { RunPill } from "./StatusPill";
import { ContactAvatar, FOREVER, HUMAN_MS, WINDOW_MS, nameOf, pausedUntil, timeLeft, windowState, type WinState } from "./ContactBits";
import type { Contact, FlowRun } from "../lib/types";

interface Sub {
  id: string;
  sequence_id: string;
  status: string;
}

const WIN_TEXT: Record<WinState, string> = {
  open: "Open",
  human_only: "Human agent only",
  closed: "Closed",
};

const PAUSES: { label: string; ms: number | null }[] = [
  { label: "30 minutes", ms: 30 * 60_000 },
  { label: "1 hour", ms: 60 * 60_000 },
  { label: "1 day", ms: 24 * 60 * 60_000 },
  { label: "Until I resume it", ms: null },
];

/** Lists the profile picks from, read once per mount. */
interface Lists {
  agents: string[];
  sequences: { id: string; name: string }[];
  fields: string[];
  tags: string[];
  flows: Record<string, string>;
  pauseMinutes: number;
}

/**
 * A contact's profile, as in ManyChat's Live Chat and Contacts: automation pause, subscription,
 * tags, custom fields, sequences and recent automations. Every change saves at once; the parent
 * hears about it through onChange so its own list stays in step.
 */
export function ContactProfile({
  contact,
  onChange,
  onClose,
  className = "",
  actions,
  assignAlways = false,
  refreshKey,
}: {
  contact: Contact;
  onChange: (next: Contact) => void;
  /** Shows a × that calls this (overlay and drawer layouts). */
  onClose?: () => void;
  className?: string;
  /** Buttons under the name, e.g. "Open in Live Chat". */
  actions?: ReactNode;
  /** Live Chat puts the assignee in its header and only shows it here on phones. */
  assignAlways?: boolean;
  /** Reload the sequences and automations lists when this changes. */
  refreshKey?: unknown;
}) {
  const [lists, setLists] = useState<Lists>({ agents: [], sequences: [], fields: [], tags: [], flows: {}, pauseMinutes: 30 });
  const [runs, setRuns] = useState<FlowRun[]>([]);
  const [subs, setSubs] = useState<Sub[]>([]);
  const [newTag, setNewTag] = useState("");
  const [showPause, setShowPause] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const pauseRef = useRef<HTMLDivElement>(null);
  // Writes read the newest contact, not the one from the render that started them.
  const latest = useRef(contact);
  latest.current = contact;

  useEffect(() => {
    Promise.all([
      supabase.from("agent").select("name").order("name"),
      supabase.from("sequence").select("id, name").order("name"),
      supabase.from("custom_field").select("key").order("key"),
      supabase.from("tag").select("name").order("name"),
      supabase.from("flow").select("id, name"),
      supabase.from("app_settings").select("human_pause_minutes").eq("id", 1).maybeSingle(),
    ]).then(([a, s, f, t, fl, st]) => {
      const failed = a.error ?? s.error ?? f.error ?? t.error ?? fl.error;
      if (failed) toast.error(failed);
      setLists({
        agents: (a.data ?? []).map((x) => x.name as string),
        sequences: s.data ?? [],
        fields: (f.data ?? []).map((x) => x.key as string),
        tags: (t.data ?? []).map((x) => x.name as string),
        flows: Object.fromEntries((fl.data ?? []).map((x) => [x.id, x.name])),
        pauseMinutes: Number(st.data?.human_pause_minutes ?? 30),
      });
    });
  }, []);

  async function loadActivity(id: string) {
    const [r, s] = await Promise.all([
      supabase.from("flow_run").select("*").eq("contact_id", id).order("created_at", { ascending: false }).limit(5),
      supabase.from("sequence_subscription").select("id, sequence_id, status").eq("contact_id", id).eq("status", "active"),
    ]);
    if (latest.current.id !== id) return;
    if (!r.error) setRuns((r.data ?? []) as FlowRun[]);
    if (!s.error) setSubs((s.data ?? []) as Sub[]);
  }

  useEffect(() => {
    setNewTag("");
    setShowPause(false);
    loadActivity(contact.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contact.id, refreshKey]);

  useEffect(() => {
    if (!showPause) return;
    const onDown = (e: MouseEvent) => {
      if (!pauseRef.current?.contains(e.target as Node)) setShowPause(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [showPause]);

  /** Show the change now, save it, put it back if the save fails. */
  async function save(key: string, patch: Partial<Contact>, persist: () => PromiseLike<{ error: unknown }>, success?: string) {
    if (busy) return;
    const before = latest.current;
    onChange({ ...before, ...patch });
    setBusy(key);
    try {
      const { error } = await persist();
      if (error) throw error;
      if (success) toast.success(success);
    } catch (err) {
      onChange(before);
      toast.error(err);
    } finally {
      setBusy(null);
    }
  }

  const update = (key: string, patch: Partial<Contact>, success?: string) =>
    save(key, patch, () => supabase.from("contact").update(patch).eq("id", contact.id), success);

  async function assign(value: string) {
    if (value === "__add__") {
      const name = await promptDialog({
        title: "Add a team member",
        body: "They join the assignee list, and this contact is assigned to them.",
        placeholder: "Name or email",
        confirmLabel: "Add and Assign",
      });
      if (!name) return;
      if (!lists.agents.includes(name)) {
        const { error } = await supabase.from("agent").upsert({ name }, { onConflict: "name" });
        if (error) return toast.error(error);
        setLists((l) => ({ ...l, agents: [...l.agents, name].sort() }));
      }
      value = name;
    }
    const next = value || null;
    if (next === latest.current.assigned_to) return;
    await update("assign", { assigned_to: next }, next ? `Assigned to ${next}` : "Unassigned");
  }

  function pause(ms: number | null | "resume") {
    setShowPause(false);
    const until = ms === "resume" ? null : ms === null ? FOREVER : new Date(Date.now() + ms).toISOString();
    return update("pause", { pause_until: until }, until ? "Automation paused for this contact" : "Automation resumed");
  }

  async function addTag(raw: string) {
    const tag = raw.trim();
    setNewTag("");
    const c = latest.current;
    if (!tag || (c.tags ?? []).includes(tag)) return;
    await save("tag", { tags: [...(c.tags ?? []), tag] }, () => supabase.rpc("add_contact_tag", { p_contact: c.id, p_tag: tag }));
    if (!lists.tags.includes(tag)) setLists((l) => ({ ...l, tags: [...l.tags, tag].sort() }));
  }

  const removeTag = (tag: string) => {
    const c = latest.current;
    return save("tag", { tags: (c.tags ?? []).filter((t) => t !== tag) }, () => supabase.rpc("remove_contact_tag", { p_contact: c.id, p_tag: tag }));
  };

  const saveField = (key: string, value: string) =>
    update("field", { custom_fields: { ...(latest.current.custom_fields ?? {}), [key]: value } });

  async function subscribeTo(sequenceId: string) {
    if (!sequenceId || busy) return;
    const id = contact.id;
    const name = lists.sequences.find((s) => s.id === sequenceId)?.name ?? "the sequence";
    setBusy("seq");
    // Same as an automation's "Subscribe to sequence" action: start at the first message.
    const { error } = await supabase.from("sequence_subscription").upsert(
      { sequence_id: sequenceId, contact_id: id, step: 0, next_send_at: new Date().toISOString(), status: "active" },
      { onConflict: "sequence_id,contact_id" },
    );
    setBusy(null);
    if (error) return toast.error(error);
    toast.success(`Subscribed to ${name}`);
    loadActivity(id);
  }

  async function unsubscribeFrom(sub: Sub) {
    if (busy) return;
    setBusy("seq");
    const { error } = await supabase.from("sequence_subscription").update({ status: "cancelled" }).eq("id", sub.id);
    setBusy(null);
    if (error) return toast.error(error);
    setSubs((s) => s.filter((x) => x.id !== sub.id));
    toast.success("Unsubscribed from the sequence");
  }

  const c = contact;
  const state = windowState(c.last_interaction_at);
  const paused = pausedUntil(c);
  const team = [...new Set([...lists.agents, ...(c.assigned_to ? [c.assigned_to] : [])])].sort();
  const openSequences = lists.sequences.filter((q) => !subs.some((s) => s.sequence_id === q.id));

  return (
    <aside className={`lc-profile ${className}`} aria-label="Contact profile">
      {onClose && <button className="icon-btn lc-profile-close" onClick={onClose} aria-label="Close profile">×</button>}
      <div className="lc-profile-top">
        <ContactAvatar contact={c} size={72} />
        <strong className="lc-profile-name" dir="auto">{nameOf(c)}</strong>
        {c.username ? (
          <a className="lc-profile-handle" href={`https://instagram.com/${c.username}`} target="_blank" rel="noreferrer">
            @{c.username} ↗
          </a>
        ) : (
          <span className="lc-profile-handle">Instagram</span>
        )}
        {actions && <div className="lc-profile-actions">{actions}</div>}
      </div>

      <section className={`lc-section ${assignAlways ? "" : "lc-assign-mobile"}`}>
        <h3 className="lc-section-title">Assigned to</h3>
        <Select
          value={c.assigned_to ?? ""}
          onChange={assign}
          ariaLabel="Assign to"
          options={[
            { value: "", label: "Unassigned" },
            ...team.map((a) => ({ value: a, label: a })),
            { value: "__add__", label: "+ Add team member…" },
          ]}
        />
      </section>

      <Section title="Automation">
        <div className="lc-auto-row">
          <span className={`lc-state ${paused ? "is-paused" : "is-on"}`}>{paused ? "Paused" : "Active"}</span>
          <div className="menu-wrap" ref={pauseRef}>
            {paused ? (
              <button className="btn btn-quiet" onClick={() => pause("resume")} disabled={busy === "pause"}>Resume</button>
            ) : (
              <button className="btn btn-quiet" onClick={() => setShowPause((s) => !s)} aria-expanded={showPause} disabled={busy === "pause"}>
                Pause…
              </button>
            )}
            {showPause && (
              <div className="menu-pop pop-in" role="menu">
                {PAUSES.map((p) => (
                  <button key={p.label} role="menuitem" className="menu-item" onClick={() => pause(p.ms)}>
                    {p.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
        <p className="lc-help">
          {lists.pauseMinutes > 0
            ? `Replying from Live Chat pauses automation for ${lists.pauseMinutes} minutes on its own.`
            : "Replying from Live Chat doesn't pause automation (Settings › Live Chat)."}
        </p>
      </Section>

      <dl className="lc-facts">
        <dt>Messaging window</dt>
        <dd>
          {WIN_TEXT[state]}
          {state !== "closed" && c.last_interaction_at && ` · ${timeLeft(c.last_interaction_at, state === "open" ? WINDOW_MS : HUMAN_MS)} left`}
        </dd>
        <dt>Follows you</dt>
        <dd>{c.follows_account === null ? "Unknown" : c.follows_account ? "Yes" : "No"}</dd>
        <dt>Last seen</dt>
        <dd>{c.last_interaction_at ? relativeTime(c.last_interaction_at) : "Never wrote"}</dd>
        <dt>Contact since</dt>
        <dd>{new Date(c.created_at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}</dd>
        <dt>Broadcasts</dt>
        <dd>
          {c.opted_out_at ? `Unsubscribed ${relativeTime(c.opted_out_at)}` : "Subscribed"}
          {" · "}
          <button
            className="link-btn"
            disabled={busy === "sub"}
            onClick={() =>
              update(
                "sub",
                { opted_out_at: c.opted_out_at ? null : new Date().toISOString() },
                c.opted_out_at ? "Subscribed to broadcasts and sequences" : "Unsubscribed from broadcasts and sequences",
              )
            }
          >
            {c.opted_out_at ? "Resubscribe" : "Unsubscribe"}
          </button>
        </dd>
        <dt>Instagram ID</dt>
        <dd className="lc-mono">{c.igsid}</dd>
      </dl>

      <Section title="Tags">
        <div className="lc-tags">
          {(c.tags ?? []).map((t) => (
            <span className="tag-chip" key={t}>
              {t}
              <button className="tag-chip-x" onClick={() => removeTag(t)} aria-label={`Remove tag ${t}`}>×</button>
            </span>
          ))}
          <input
            className="tag-add"
            list="profile-known-tags"
            placeholder="+ Add tag"
            value={newTag}
            onChange={(e) => setNewTag(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addTag(newTag)}
            onBlur={() => newTag.trim() && addTag(newTag)}
            aria-label="Add a tag"
          />
          <datalist id="profile-known-tags">
            {lists.tags.filter((t) => !(c.tags ?? []).includes(t)).map((t) => <option key={t} value={t} />)}
          </datalist>
        </div>
      </Section>

      <Section title="Custom fields">
        <FieldList contact={c} keys={lists.fields} onSave={saveField} />
      </Section>

      <Section title="Sequences">
        {subs.length === 0 ? (
          <p className="lc-help" style={{ marginTop: 0 }}>Not subscribed to any sequence.</p>
        ) : (
          <ul className="lc-list-plain">
            {subs.map((s) => (
              <li key={s.id}>
                <span>{lists.sequences.find((q) => q.id === s.sequence_id)?.name ?? "Deleted sequence"}</span>
                <button className="link-btn" onClick={() => unsubscribeFrom(s)} disabled={busy === "seq"}>Unsubscribe</button>
              </li>
            ))}
          </ul>
        )}
        {openSequences.length > 0 && (
          <div style={{ marginTop: 8 }}>
            <Select
              value=""
              onChange={subscribeTo}
              ariaLabel="Subscribe to a sequence"
              options={[{ value: "", label: "+ Subscribe to a sequence" }, ...openSequences.map((q) => ({ value: q.id, label: q.name }))]}
            />
          </div>
        )}
      </Section>

      <Section title="Recent automations">
        {runs.length === 0 ? (
          <p className="lc-help" style={{ marginTop: 0 }}>No automation has run for this contact yet.</p>
        ) : (
          <ul className="lc-list-plain">
            {runs.map((r) => (
              <li key={r.id}>
                <span className="lc-run-name">{lists.flows[r.flow_id] ?? "Deleted automation"}</span>
                <span className="lc-run-meta">
                  <RunPill status={r.status} /> {relativeTime(r.created_at)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </aside>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="lc-section">
      <h3 className="lc-section-title">{title}</h3>
      {children}
    </section>
  );
}

/** Every known field plus whatever this contact has, editable in place (saves on blur). */
function FieldList({ contact, keys, onSave }: { contact: Contact; keys: string[]; onSave: (key: string, value: string) => void }) {
  const values = contact.custom_fields ?? {};
  // Timestamps that travel with a field ("ref_at") are bookkeeping, not something to edit.
  const all = [...new Set([...keys, ...Object.keys(values)])].filter((k) => !k.endsWith("_at")).sort();
  if (!all.length) return <p className="lc-help" style={{ marginTop: 0 }}>No fields yet. Add one in Settings › Fields.</p>;
  return (
    <div className="lc-fields">
      {all.map((k) => {
        const v = values[k];
        return (
          <label className="lc-field" key={k}>
            <span className="lc-field-k">{k}</span>
            {typeof v === "boolean" ? (
              <span className="lc-field-v">{v ? "Yes" : "No"}</span>
            ) : (
              <input
                className="input"
                key={`${contact.id}-${k}-${String(v ?? "")}`}
                defaultValue={v == null ? "" : String(v)}
                placeholder="Empty"
                dir="auto"
                onBlur={(e) => e.target.value !== (v == null ? "" : String(v)) && onSave(k, e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
              />
            )}
          </label>
        );
      })}
    </div>
  );
}
