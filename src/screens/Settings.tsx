import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Navigate, NavLink, useParams } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { loadFlowRefs, renameInFlows, usage } from "../lib/references";
import { BROWSER_TZ, forgetAccountTimezone } from "../lib/settings";
import { relativeTime } from "../lib/time";
import { Loader } from "../components/Loader";
import { Select } from "../components/Select";
import { toast } from "../components/Toast";
import { confirmDialog, promptDialog } from "../components/Confirm";
import { RowMenu, SaveState } from "../components/PageBits";
import { InstagramSettings } from "./InstagramSettings";

const TABS = [
  { id: "general", label: "General" },
  { id: "instagram", label: "Instagram" },
  { id: "livechat", label: "Live Chat" },
  { id: "team", label: "Team" },
  { id: "fields", label: "Fields" },
  { id: "tags", label: "Tags" },
] as const;

type TabId = (typeof TABS)[number]["id"];

/** Settings, like ManyChat: a tab list on the left, one area of the account on the right. */
export function Settings() {
  const { tab } = useParams<{ tab: string }>();
  if (!TABS.some((t) => t.id === tab)) return <Navigate to="/settings/instagram" replace />;
  const id = tab as TabId;

  return (
    <>
      <header className="page-bar">
        <h1 className="page-title">Settings</h1>
      </header>
      <div className="st-layout">
        <nav className="st-nav" aria-label="Settings">
          {TABS.map((t) => (
            <NavLink key={t.id} to={`/settings/${t.id}`} className={({ isActive }) => `st-tab ${isActive ? "is-current" : ""}`}>
              {t.label}
            </NavLink>
          ))}
        </nav>
        <div className="st-body">
          {id === "general" && <GeneralTab />}
          {id === "instagram" && <InstagramSettings />}
          {id === "livechat" && <LiveChatTab />}
          {id === "team" && <TeamTab />}
          {id === "fields" && <FieldsTab />}
          {id === "tags" && <TagsTab />}
        </div>
      </div>
    </>
  );
}

function Panel({ title, about, children, right }: { title: string; about?: ReactNode; children: ReactNode; right?: ReactNode }) {
  return (
    <section className="mc-card st-panel">
      <header className="st-panel-head">
        <div>
          <h2 className="st-panel-title">{title}</h2>
          {about && <p className="st-panel-about">{about}</p>}
        </div>
        {right}
      </header>
      <div className="st-panel-body">{children}</div>
    </section>
  );
}

/** The single settings row (id = 1), saved field by field. */
function useAppSettings() {
  const [row, setRow] = useState<{ timezone: string | null; human_pause_minutes: number } | null>(null);
  const [state, setState] = useState<"idle" | "saving" | "saved" | "failed">("idle");
  useEffect(() => {
    supabase.from("app_settings").select("timezone, human_pause_minutes").eq("id", 1).maybeSingle().then(({ data, error }) => {
      if (error) toast.error(error);
      setRow(data ?? { timezone: null, human_pause_minutes: 30 });
    });
  }, []);
  async function save(patch: Partial<{ timezone: string | null; human_pause_minutes: number }>) {
    const before = row;
    setRow((r) => (r ? { ...r, ...patch } : r));
    setState("saving");
    const { error } = await supabase.from("app_settings").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", 1);
    if (error) {
      setRow(before);
      setState("failed");
      return toast.error(error);
    }
    setState("saved");
  }
  return { row, state, save };
}

// ================================================================ General

function GeneralTab() {
  const { row, state, save } = useAppSettings();
  const zones = useMemo(() => {
    const all = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone") ?? [BROWSER_TZ];
    return all.includes(BROWSER_TZ) ? all : [BROWSER_TZ, ...all];
  }, []);
  if (!row) return <Loader label="Loading settings" />;

  return (
    <Panel
      title="Time zone"
      about="New sequence messages with a “send between” window use this time zone, so contacts get them in your working hours."
      right={<SaveState state={state} />}
    >
      <select
        className="input st-select"
        value={row.timezone ?? ""}
        onChange={(e) => {
          forgetAccountTimezone();
          save({ timezone: e.target.value || null });
        }}
        aria-label="Time zone"
      >
        <option value="">This browser's time zone ({BROWSER_TZ})</option>
        {zones.map((z) => (
          <option key={z} value={z}>{z.replace(/_/g, " ")}</option>
        ))}
      </select>
    </Panel>
  );
}

// ================================================================ Live Chat

const PAUSE_CHOICES = [
  { value: "0", label: "Don't pause" },
  { value: "15", label: "15 minutes" },
  { value: "30", label: "30 minutes" },
  { value: "60", label: "1 hour" },
  { value: "120", label: "2 hours" },
  { value: "1440", label: "1 day" },
];

interface Reply {
  id: string;
  title: string;
  body: string;
}

function LiveChatTab() {
  const { row, state, save } = useAppSettings();
  const [replies, setReplies] = useState<Reply[] | null>(null);
  const [editing, setEditing] = useState<Reply | "new" | null>(null);

  useEffect(() => {
    supabase.from("saved_reply").select("id, title, body").order("title").then(({ data, error }) => {
      if (error) toast.error(error);
      setReplies(data ?? []);
    });
  }, []);

  async function remove(r: Reply) {
    const ok = await confirmDialog({ title: `Delete saved reply “${r.title}”?`, confirmLabel: "Delete", danger: true });
    if (!ok) return;
    const { error } = await supabase.from("saved_reply").delete().eq("id", r.id);
    if (error) return toast.error(error);
    setReplies((list) => (list ?? []).filter((x) => x.id !== r.id));
  }

  if (!row || !replies) return <Loader label="Loading settings" />;
  const minutes = String(row.human_pause_minutes);

  return (
    <div className="stack" style={{ gap: 18 }}>
      <Panel
        title="Pause automation after a human reply"
        about="When someone on your team replies from Live Chat, automations wait this long for that contact so the bot doesn't talk over you."
        right={<SaveState state={state} />}
      >
        <div className="st-narrow">
          <Select
            value={PAUSE_CHOICES.some((c) => c.value === minutes) ? minutes : "30"}
            onChange={(v) => save({ human_pause_minutes: Number(v) })}
            ariaLabel="Pause length"
            options={PAUSE_CHOICES}
          />
        </div>
      </Panel>

      <Panel
        title="Saved replies"
        about="Ready-made answers your team inserts from the bookmark button in Live Chat."
        right={<button className="btn" onClick={() => setEditing("new")}>+ New Reply</button>}
      >
        {editing === "new" && <ReplyForm onDone={(r) => { if (r) setReplies((l) => [...(l ?? []), r].sort((a, b) => a.title.localeCompare(b.title))); setEditing(null); }} />}
        {replies.length === 0 && editing !== "new" ? (
          <p className="mc-empty" style={{ padding: 0 }}>No saved replies yet.</p>
        ) : (
          <ul className="st-list">
            {replies.map((r) =>
              editing !== "new" && editing?.id === r.id ? (
                <li key={r.id}>
                  <ReplyForm
                    reply={r}
                    onDone={(next) => {
                      if (next) setReplies((l) => (l ?? []).map((x) => (x.id === next.id ? next : x)));
                      setEditing(null);
                    }}
                  />
                </li>
              ) : (
                <li key={r.id} className="st-item">
                  <div className="st-item-main">
                    <strong>{r.title}</strong>
                    <span className="st-item-sub" dir="auto">{r.body}</span>
                  </div>
                  <div className="cluster" style={{ gap: 4 }}>
                    <button className="btn btn-quiet" onClick={() => setEditing(r)}>Edit</button>
                    <button className="btn btn-quiet st-danger" onClick={() => remove(r)}>Delete</button>
                  </div>
                </li>
              ),
            )}
          </ul>
        )}
      </Panel>
    </div>
  );
}

function ReplyForm({ reply, onDone }: { reply?: Reply; onDone: (saved: Reply | null) => void }) {
  const [title, setTitle] = useState(reply?.title ?? "");
  const [body, setBody] = useState(reply?.body ?? "");
  const [busy, setBusy] = useState(false);

  async function save() {
    if (!title.trim() || !body.trim()) return;
    setBusy(true);
    const values = { title: title.trim(), body: body.trim() };
    const { data, error } = reply
      ? await supabase.from("saved_reply").update(values).eq("id", reply.id).select("id, title, body").single()
      : await supabase.from("saved_reply").insert(values).select("id, title, body").single();
    setBusy(false);
    if (error) return toast.error(error);
    onDone(data as Reply);
  }

  return (
    <div className="st-form">
      <input className="input" placeholder="Name, e.g. Shipping times" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
      <textarea className="textarea" rows={3} placeholder="The reply text" value={body} onChange={(e) => setBody(e.target.value)} dir="auto" />
      <div className="cluster" style={{ gap: 8, justifyContent: "flex-end" }}>
        <button className="btn btn-quiet" onClick={() => onDone(null)}>Cancel</button>
        <button className={`btn btn-primary ${busy ? "is-busy" : ""}`} disabled={!title.trim() || !body.trim() || busy} onClick={save}>
          {reply ? "Save" : "Add Reply"}
        </button>
      </div>
    </div>
  );
}

// ================================================================ Team

function TeamTab() {
  const [agents, setAgents] = useState<string[] | null>(null);
  const [open, setOpen] = useState<Record<string, number>>({});
  const [refs, setRefs] = useState<Map<string, string[]>>(new Map());
  const [name, setName] = useState("");

  async function load() {
    const [a, c, f] = await Promise.all([
      supabase.from("agent").select("name").order("name"),
      supabase.from("contact").select("assigned_to").not("assigned_to", "is", null).neq("status", "done").limit(5000),
      loadFlowRefs().catch(() => []),
    ]);
    if (a.error) toast.error(a.error);
    const counts: Record<string, number> = {};
    for (const r of c.data ?? []) counts[r.assigned_to as string] = (counts[r.assigned_to as string] ?? 0) + 1;
    // Anyone conversations are assigned to belongs on the list, even if they were never added.
    setAgents([...new Set([...(a.data ?? []).map((x) => x.name as string), ...Object.keys(counts)])].sort());
    setOpen(counts);
    setRefs(usage(f, "agent"));
  }

  useEffect(() => {
    load();
  }, []);

  async function add() {
    const n = name.trim();
    if (!n) return;
    const { error } = await supabase.from("agent").upsert({ name: n }, { onConflict: "name" });
    if (error) return toast.error(error);
    setName("");
    load();
  }

  async function rename(old: string) {
    const next = await promptDialog({ title: `Rename ${old}`, initial: old, confirmLabel: "Rename" });
    if (!next || next === old) return;
    try {
      const up = await supabase.from("agent").upsert({ name: next }, { onConflict: "name" });
      if (up.error) throw up.error;
      const c = await supabase.from("contact").update({ assigned_to: next }).eq("assigned_to", old);
      if (c.error) throw c.error;
      const flows = await renameInFlows("agent", old, next);
      const d = await supabase.from("agent").delete().eq("name", old);
      if (d.error) throw d.error;
      toast.success(`Renamed to ${next}${flows ? ` in ${flows} automation${flows === 1 ? "" : "s"} too` : ""}`);
    } catch (err) {
      toast.error(err);
    }
    load();
  }

  async function remove(who: string) {
    const used = refs.get(who) ?? [];
    const ok = await confirmDialog({
      title: `Remove ${who}?`,
      body:
        `${open[who] ? `${open[who]} open conversation${open[who] === 1 ? "" : "s"} assigned to them become Unassigned. ` : ""}` +
        (used.length ? `These automations still assign to them: ${used.join(", ")}.` : "No automation assigns to them."),
      confirmLabel: "Remove",
      danger: true,
    });
    if (!ok) return;
    const c = await supabase.from("contact").update({ assigned_to: null }).eq("assigned_to", who);
    if (c.error) return toast.error(c.error);
    const d = await supabase.from("agent").delete().eq("name", who);
    if (d.error) return toast.error(d.error);
    toast.success(`${who} removed`);
    load();
  }

  if (!agents) return <Loader label="Loading team" />;

  return (
    <Panel
      title="Team members"
      about="The people you assign conversations to in Live Chat and with an automation's Assign action. Their own logins and permissions come back when the panel's login is turned on again."
    >
      <div className="st-add">
        <input className="input" placeholder="Name or email" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} />
        <button className="btn btn-primary" disabled={!name.trim()} onClick={add}>Add Member</button>
      </div>
      {agents.length === 0 ? (
        <p className="mc-empty" style={{ padding: "14px 0 0" }}>No team members yet.</p>
      ) : (
        <table className="mc-table st-table">
          <thead>
            <tr><th className="col-menu" /><th>Name</th><th className="num">Open conversations</th><th className="num">Automations</th></tr>
          </thead>
          <tbody>
            {agents.map((a) => (
              <tr key={a} className="is-static">
                <td className="col-menu">
                  <RowMenu label={`Actions for ${a}`} items={[
                    { label: "Rename", onSelect: () => rename(a) },
                    { label: "Remove", onSelect: () => remove(a), danger: true },
                  ]} />
                </td>
                <td className="cell-name">{a}</td>
                <td className="num">{open[a] ?? 0}</td>
                <td className="num" title={(refs.get(a) ?? []).join(", ")}>{refs.get(a)?.length ?? 0}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}

// ================================================================ Fields

const FIELD_TYPES = [
  { value: "text", label: "Text" },
  { value: "number", label: "Number" },
  { value: "email", label: "Email" },
  { value: "phone", label: "Phone" },
  { value: "url", label: "URL" },
];

function FieldsTab() {
  const [fields, setFields] = useState<{ key: string; type: string; created_at: string }[] | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [key, setKey] = useState("");
  const [type, setType] = useState("text");

  async function load() {
    const [f, c] = await Promise.all([
      supabase.from("custom_field").select("key, type, created_at").order("key"),
      supabase.rpc("field_counts"),
    ]);
    if (f.error) toast.error(f.error);
    const byKey = Object.fromEntries(((c.data ?? []) as { key: string; contacts: number }[]).map((r) => [r.key, Number(r.contacts)]));
    // Values contacts already carry (a ref link, an older collect) show up even if never registered.
    const known = new Map((f.data ?? []).map((r) => [r.key as string, r as { key: string; type: string; created_at: string }]));
    for (const k of Object.keys(byKey)) if (!known.has(k) && !k.endsWith("_at")) known.set(k, { key: k, type: "text", created_at: "" });
    setFields([...known.values()].sort((a, b) => a.key.localeCompare(b.key)));
    setCounts(byKey);
  }

  useEffect(() => {
    load();
  }, []);

  const clean = key.trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");

  async function add() {
    if (!clean) return;
    const { error } = await supabase.from("custom_field").upsert({ key: clean, type }, { onConflict: "key" });
    if (error) return toast.error(error);
    setKey("");
    toast.success(`Field “${clean}” added`);
    load();
  }

  async function remove(k: string) {
    const n = counts[k] ?? 0;
    const ok = await confirmDialog({
      title: `Delete field “${k}”?`,
      body: `${n ? `Its value is removed from ${n} contact${n === 1 ? "" : "s"}. ` : ""}An automation that saves to it creates it again. This can't be undone.`,
      confirmLabel: "Delete Field",
      danger: true,
    });
    if (!ok) return;
    const { error } = await supabase.rpc("delete_custom_field", { p_key: k });
    if (error) return toast.error(error);
    toast.success(`Field “${k}” deleted`);
    load();
  }

  if (!fields) return <Loader label="Loading fields" />;

  return (
    <Panel
      title="Custom fields"
      about={<>What you know about each contact: answers a Collect step saved, or values you set. Put <code>{"{{contact.field_name}}"}</code> in a message to insert it.</>}
    >
      <div className="st-add">
        <input className="input" placeholder="New field, e.g. city" value={key} onChange={(e) => setKey(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} />
        <div className="st-type"><Select value={type} onChange={setType} ariaLabel="Type" options={FIELD_TYPES} /></div>
        <button className="btn btn-primary" disabled={!clean} onClick={add}>Add Field</button>
      </div>
      {key.trim() && clean !== key.trim() && <p className="lc-help">Saved as <code>{clean || "…"}</code>: lowercase letters, numbers and _.</p>}
      {fields.length === 0 ? (
        <p className="mc-empty" style={{ padding: "14px 0 0" }}>No fields yet.</p>
      ) : (
        <table className="mc-table st-table">
          <thead>
            <tr><th className="col-menu" /><th>Field</th><th>Type</th><th className="num">Contacts with a value</th><th>Added</th></tr>
          </thead>
          <tbody>
            {fields.map((f) => (
              <tr key={f.key} className="is-static">
                <td className="col-menu">
                  <RowMenu label={`Actions for ${f.key}`} items={[{ label: "Delete", onSelect: () => remove(f.key), danger: true }]} />
                </td>
                <td><span className="cell-name">{f.key}</span> <code className="st-code">{`{{contact.${f.key}}}`}</code></td>
                <td className="cell-muted">{FIELD_TYPES.find((t) => t.value === f.type)?.label ?? f.type}</td>
                <td className="num">{counts[f.key] ?? 0}</td>
                <td className="cell-muted">{f.created_at ? relativeTime(f.created_at) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}

// ================================================================ Tags

function TagsTab() {
  const [tags, setTags] = useState<{ name: string; contacts: number }[] | null>(null);
  const [refs, setRefs] = useState<Map<string, string[]>>(new Map());
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    const [t, f] = await Promise.all([supabase.rpc("tag_counts"), loadFlowRefs().catch(() => [])]);
    if (t.error) toast.error(t.error);
    const r = usage(f, "tag");
    const list = ((t.data ?? []) as { name: string; contacts: number }[]).map((x) => ({ name: x.name, contacts: Number(x.contacts) }));
    // Tags automations add but nobody carries yet still belong on the list.
    for (const n of r.keys()) if (!list.some((x) => x.name === n)) list.push({ name: n, contacts: 0 });
    setTags(list.sort((a, b) => a.name.localeCompare(b.name)));
    setRefs(r);
  }

  useEffect(() => {
    load();
  }, []);

  async function add() {
    const n = name.trim();
    if (!n) return;
    const { error } = await supabase.from("tag").upsert({ name: n }, { onConflict: "name" });
    if (error) return toast.error(error);
    setName("");
    load();
  }

  async function rename(old: string) {
    const next = await promptDialog({
      title: `Rename tag “${old}”`,
      body: "Contacts, automations, broadcast audiences and saved segments all follow the new name.",
      initial: old,
      confirmLabel: "Rename",
    });
    if (!next || next === old) return;
    setBusy(true);
    try {
      const { error } = await supabase.rpc("rename_tag", { p_old: old, p_new: next });
      if (error) throw error;
      const flows = await renameInFlows("tag", old, next);
      toast.success(`Renamed to “${next}”${flows ? ` in ${flows} automation${flows === 1 ? "" : "s"} too` : ""}`);
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
    load();
  }

  async function remove(t: { name: string; contacts: number }) {
    const used = refs.get(t.name) ?? [];
    const ok = await confirmDialog({
      title: `Delete tag “${t.name}”?`,
      body:
        `${t.contacts ? `It comes off ${t.contacts} contact${t.contacts === 1 ? "" : "s"}. ` : ""}` +
        (used.length ? `These automations still use it and will add it back: ${used.join(", ")}. ` : "") +
        "Broadcasts and segments that ask for it match nobody until you change them.",
      confirmLabel: "Delete Tag",
      danger: true,
    });
    if (!ok) return;
    const { error } = await supabase.rpc("delete_tag", { p_name: t.name });
    if (error) return toast.error(error);
    toast.success(`Tag “${t.name}” deleted`);
    load();
  }

  if (!tags) return <Loader label="Loading tags" />;

  return (
    <Panel title="Tags" about="Labels on contacts. Automations add and check them, Live Chat and Contacts filter by them, broadcasts target them.">
      <div className="st-add">
        <input className="input" placeholder="New tag" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} />
        <button className="btn btn-primary" disabled={!name.trim()} onClick={add}>Add Tag</button>
      </div>
      {tags.length === 0 ? (
        <p className="mc-empty" style={{ padding: "14px 0 0" }}>No tags yet.</p>
      ) : (
        <table className={`mc-table st-table ${busy ? "is-loading" : ""}`}>
          <thead>
            <tr><th className="col-menu" /><th>Tag</th><th className="num">Contacts</th><th className="num">Automations</th></tr>
          </thead>
          <tbody>
            {tags.map((t) => (
              <tr key={t.name} className="is-static">
                <td className="col-menu">
                  <RowMenu label={`Actions for ${t.name}`} items={[
                    { label: "Rename", onSelect: () => rename(t.name) },
                    { label: "Delete", onSelect: () => remove(t), danger: true },
                  ]} />
                </td>
                <td><span className="ct-tag">{t.name}</span></td>
                <td className="num">{t.contacts}</td>
                <td className="num" title={(refs.get(t.name) ?? []).join(", ")}>{refs.get(t.name)?.length ?? 0}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}
