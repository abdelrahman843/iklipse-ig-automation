import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { relativeTime } from "../lib/time";
import { isComplete, matchContacts, matchingIds, type Condition } from "../lib/conditions";
import { ConditionBuilder } from "../components/ConditionBuilder";
import { ContactProfile } from "../components/ContactProfile";
import { ContactAvatar, nameOf } from "../components/ContactBits";
import { Select } from "../components/Select";
import { Loader } from "../components/Loader";
import { friendlyError, toast } from "../components/Toast";
import { confirmDialog, promptDialog } from "../components/Confirm";
import type { Contact } from "../lib/types";

const PAGE = 50;

interface Segment {
  id: string;
  name: string;
  conditions: Condition[];
}

type SortKey = "last_interaction_at" | "created_at";

type Bulk = "tag_add" | "tag_remove" | "seq_add" | "seq_remove" | "field_set" | "field_clear" | "unsubscribe" | "resubscribe";

const BULK: { kind: Bulk | "export" | "delete"; label: string; danger?: boolean }[] = [
  { kind: "tag_add", label: "Add Tag" },
  { kind: "tag_remove", label: "Remove Tag" },
  { kind: "seq_add", label: "Subscribe to Sequence" },
  { kind: "seq_remove", label: "Unsubscribe from Sequence" },
  { kind: "field_set", label: "Set Custom Field" },
  { kind: "field_clear", label: "Clear Custom Field" },
  { kind: "unsubscribe", label: "Unsubscribe from Broadcasts" },
  { kind: "resubscribe", label: "Resubscribe to Broadcasts" },
  { kind: "export", label: "Export CSV" },
  { kind: "delete", label: "Delete Contacts", danger: true },
];

// Field by field: the database hands JSON back with its keys in its own order.
const condKey = (list: Condition[]) => JSON.stringify(list.map((c) => [c.field, c.op, c.key ?? "", c.value ?? ""]));
const sameConditions = (a: Condition[], b: Condition[]) => condKey(a) === condKey(b);

/**
 * Contacts, like ManyChat's Audience: everyone who has messaged or commented, filtered by
 * conditions (saved as segments), with bulk actions on a selection or on everyone matching.
 */
export function Contacts() {
  const [conditions, setConditions] = useState<Condition[]>([]);
  const [searchText, setSearchText] = useState("");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; asc: boolean }>({ key: "last_interaction_at", asc: false });
  const [page, setPage] = useState(0);
  const [rows, setRows] = useState<Contact[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [grand, setGrand] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Picked by checkbox, kept across pages. "All matching" swaps the picks for the whole filter.
  const [picked, setPicked] = useState<Map<string, Contact>>(() => new Map());
  const [allMatching, setAllMatching] = useState(false);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Bulk | null>(null);
  const [working, setWorking] = useState(false);
  const loadSeq = useRef(0);

  // Typing settles for a moment before the search runs.
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchText), 300);
    return () => clearTimeout(t);
  }, [searchText]);

  // A new filter starts from the first page with nothing picked.
  useEffect(() => {
    setPage(0);
    setPicked(new Map());
    setAllMatching(false);
  }, [conditions, search]);

  async function load() {
    const seq = ++loadSeq.current;
    setLoading(true);
    try {
      const from = page * PAGE;
      const { data, count, error } = await matchContacts(conditions, search, { count: "exact" })
        .select("*")
        .order(sort.key, { ascending: sort.asc, nullsFirst: false })
        .order("id")
        .range(from, from + PAGE - 1);
      if (error) throw error;
      if (seq !== loadSeq.current) return;
      setRows((data ?? []) as Contact[]);
      setTotal(count ?? 0);
      setError(null);
    } catch (err) {
      if (seq === loadSeq.current) setError(`Could not load contacts: ${friendlyError(err)}`);
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conditions, search, sort, page]);

  useEffect(() => {
    supabase.from("contact").select("id", { count: "exact", head: true }).then(({ count }) => setGrand(count ?? 0));
    supabase.from("contact_segment").select("*").order("name").then(({ data, error }) => {
      if (error) toast.error(error);
      else setSegments((data ?? []) as Segment[]);
    });
  }, []);

  // ---- selection --------------------------------------------------------------------------------

  const pageAllPicked = rows.length > 0 && rows.every((r) => picked.has(r.id));
  const count = allMatching ? total ?? 0 : picked.size;

  function togglePick(c: Contact) {
    setAllMatching(false);
    setPicked((m) => {
      const next = new Map(m);
      if (next.has(c.id)) next.delete(c.id);
      else next.set(c.id, c);
      return next;
    });
  }

  function togglePage() {
    setAllMatching(false);
    setPicked((m) => {
      const next = new Map(m);
      if (pageAllPicked) rows.forEach((r) => next.delete(r.id));
      else rows.forEach((r) => next.set(r.id, r));
      return next;
    });
  }

  const clearPicks = () => {
    setPicked(new Map());
    setAllMatching(false);
  };

  /** The ids a bulk action applies to: the picks, or everyone matching. */
  const targetIds = () => (allMatching ? matchingIds(conditions, search) : Promise.resolve([...picked.keys()]));

  // ---- segments ---------------------------------------------------------------------------------

  const active = segments.find((s) => sameConditions(s.conditions, conditions.filter(isComplete)));

  async function saveSegment() {
    const name = await promptDialog({
      title: "Save as segment",
      body: "Name these conditions so you can come back to this group of contacts.",
      placeholder: "e.g. Ordered in the last 30 days",
      confirmLabel: "Save Segment",
    });
    if (!name) return;
    const { data, error } = await supabase.from("contact_segment").insert({ name, conditions }).select().single();
    if (error) return toast.error(error);
    setSegments((s) => [...s, data as Segment].sort((a, b) => a.name.localeCompare(b.name)));
    toast.success(`Segment “${name}” saved`);
  }

  async function deleteSegment(seg: Segment) {
    const ok = await confirmDialog({ title: `Delete segment “${seg.name}”?`, body: "Only the saved filter goes. No contact is changed.", confirmLabel: "Delete", danger: true });
    if (!ok) return;
    const { error } = await supabase.from("contact_segment").delete().eq("id", seg.id);
    if (error) return toast.error(error);
    setSegments((s) => s.filter((x) => x.id !== seg.id));
  }

  // ---- bulk actions ---------------------------------------------------------------------------

  /** Runs `fn` over the target ids in chunks, then reloads. */
  async function apply(label: string, fn: (ids: string[]) => PromiseLike<{ error: unknown }>, chunk = 1000) {
    setWorking(true);
    try {
      const ids = await targetIds();
      for (let i = 0; i < ids.length; i += chunk) {
        const { error } = await fn(ids.slice(i, i + chunk));
        if (error) throw error;
      }
      toast.success(`${label}: ${ids.length} contact${ids.length === 1 ? "" : "s"}`);
      setDialog(null);
      clearPicks();
      await load();
    } catch (err) {
      toast.error(err);
    } finally {
      setWorking(false);
    }
  }

  async function runBulk(kind: Bulk | "export" | "delete") {
    if (kind === "export") return exportCsv(true);
    if (kind === "delete") {
      const ok = await confirmDialog({
        title: `Delete ${count} contact${count === 1 ? "" : "s"}?`,
        body: "Their messages, notes, automation history and sequence subscriptions are removed for good. If they message you again they come back as new contacts. This can't be undone.",
        confirmLabel: "Delete Contacts",
        danger: true,
      });
      if (!ok) return;
      return apply("Deleted", (ids) => supabase.from("contact").delete().in("id", ids), 100);
    }
    if (kind === "unsubscribe") {
      return apply("Unsubscribed", (ids) =>
        supabase.from("contact").update({ opted_out_at: new Date().toISOString() }).in("id", ids).is("opted_out_at", null),
      100);
    }
    if (kind === "resubscribe") {
      return apply("Resubscribed", (ids) => supabase.from("contact").update({ opted_out_at: null }).in("id", ids), 100);
    }
    setDialog(kind);
  }

  async function exportCsv(onlyTargets: boolean) {
    setWorking(true);
    try {
      let list: Contact[] = [];
      if (onlyTargets && !allMatching) {
        list = [...picked.values()];
      } else {
        for (let from = 0; from < 50_000; from += 1000) {
          const { data, error } = await matchContacts(conditions, search).select("*").order("created_at").range(from, from + 999);
          if (error) throw error;
          list.push(...((data ?? []) as Contact[]));
          if (!data || data.length < 1000) break;
        }
      }
      downloadCsv(list);
      toast.success(`Exported ${list.length} contact${list.length === 1 ? "" : "s"}`);
    } catch (err) {
      toast.error(err);
    } finally {
      setWorking(false);
    }
  }

  const open = rows.find((r) => r.id === openId) ?? null;
  const filtered = conditions.length > 0 || search.trim() !== "";
  const pages = Math.max(1, Math.ceil((total ?? 0) / PAGE));

  const sortHead = (key: SortKey, label: string) => (
    <th className="ct-sort" aria-sort={sort.key === key ? (sort.asc ? "ascending" : "descending") : "none"}>
      <button onClick={() => setSort((s) => (s.key === key ? { key, asc: !s.asc } : { key, asc: false }))}>
        {label} {sort.key === key ? (sort.asc ? "↑" : "↓") : ""}
      </button>
    </th>
  );

  return (
    <>
      <header className="page-bar">
        <h1 className="page-title">
          Contacts {grand !== null && <span className="ct-total">{grand}</span>}
        </h1>
        <button className={`btn ${working ? "is-busy" : ""}`} onClick={() => exportCsv(false)} disabled={working || !total}>
          Export CSV
        </button>
      </header>

      <div className="mc-card ct-filter">
        <div className="ct-filter-top">
          <input
            className="input ct-search"
            placeholder="Search by name, username or Instagram ID"
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            aria-label="Search contacts"
          />
          <SegmentMenu segments={segments} active={active} onPick={(s) => setConditions(s.conditions)} onDelete={deleteSegment} />
          {conditions.some(isComplete) && !active && (
            <button className="btn btn-quiet" onClick={saveSegment}>Save as Segment</button>
          )}
        </div>
        <div className="ct-filter-conds">
          {active && <span className="ct-seg-name">Segment: <strong>{active.name}</strong></span>}
          <ConditionBuilder conditions={conditions} onChange={setConditions} emptyLabel="All contacts" />
          {filtered && (
            <button className="link-btn" onClick={() => { setConditions([]); setSearchText(""); }}>Clear filter</button>
          )}
        </div>
      </div>

      {error && <div className="notice" style={{ marginBottom: 16 }}>{error}</div>}

      {count > 0 && (
        <div className="ct-bulkbar" role="region" aria-label="Bulk actions">
          <span>
            <strong>{count}</strong> selected
            {!allMatching && pageAllPicked && (total ?? 0) > picked.size && (
              <>
                {" · "}
                <button className="link-btn" onClick={() => setAllMatching(true)}>Select all {total} matching</button>
              </>
            )}
            {" · "}
            <button className="link-btn" onClick={clearPicks}>Clear</button>
          </span>
          <BulkMenu disabled={working} onPick={runBulk} />
        </div>
      )}

      <div className="mc-card">
        {loading && !rows.length ? (
          <Loader label="Loading contacts" inline />
        ) : rows.length === 0 ? (
          <p className="mc-empty">
            {grand === 0
              ? "No contacts yet. Everyone who messages you or comments on a post with an automation lands here."
              : "Nobody matches this filter."}
          </p>
        ) : (
          <table className={`mc-table ct-table ${loading ? "is-loading" : ""}`}>
            <thead>
              <tr>
                <th className="ct-check">
                  <input type="checkbox" checked={pageAllPicked || allMatching} onChange={togglePage} aria-label="Select this page" />
                </th>
                <th>Name</th>
                <th>Subscribed</th>
                <th>Tags</th>
                {sortHead("last_interaction_at", "Last interaction")}
                {sortHead("created_at", "Contact since")}
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id} onClick={() => setOpenId(c.id)} tabIndex={0} onKeyDown={(e) => e.key === "Enter" && e.target === e.currentTarget && setOpenId(c.id)}>
                  <td className="ct-check" onClick={(e) => e.stopPropagation()}>
                    <input type="checkbox" checked={allMatching || picked.has(c.id)} onChange={() => togglePick(c)} aria-label={`Select ${nameOf(c)}`} />
                  </td>
                  <td>
                    <div className="ct-who">
                      <ContactAvatar contact={c} size={32} />
                      <span className="ct-who-text">
                        <span className="cell-name" dir="auto">{nameOf(c)}</span>
                        <span className="cell-muted">{c.username ? `@${c.username}` : c.igsid}</span>
                      </span>
                    </div>
                  </td>
                  <td>{c.opted_out_at ? <span className="pill">Unsubscribed</span> : <span className="ct-yes">Subscribed</span>}</td>
                  <td>
                    <span className="ct-tags">
                      {(c.tags ?? []).slice(0, 3).map((t) => <span key={t} className="ct-tag">{t}</span>)}
                      {(c.tags ?? []).length > 3 && <span className="cell-muted">+{c.tags.length - 3}</span>}
                      {(c.tags ?? []).length === 0 && <span className="cell-muted">—</span>}
                    </span>
                  </td>
                  <td className="cell-muted">{c.last_interaction_at ? relativeTime(c.last_interaction_at) : "Never wrote"}</td>
                  <td className="cell-muted">{new Date(c.created_at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {(total ?? 0) > PAGE && (
          <div className="ct-pager">
            <span>
              {page * PAGE + 1}–{Math.min((page + 1) * PAGE, total ?? 0)} of {total}
            </span>
            <button className="btn" disabled={page === 0 || loading} onClick={() => setPage((p) => p - 1)}>Previous</button>
            <button className="btn" disabled={page + 1 >= pages || loading} onClick={() => setPage((p) => p + 1)}>Next</button>
          </div>
        )}
      </div>

      {open && (
        <>
          <div className="sheet-scrim" onClick={() => setOpenId(null)} aria-hidden="true" />
          <div className="ct-drawer" role="dialog" aria-label={`${nameOf(open)} profile`}>
            <ContactProfile
              contact={open}
              className="ct-profile"
              assignAlways
              onChange={(next) => setRows((list) => list.map((r) => (r.id === next.id ? next : r)))}
              onClose={() => setOpenId(null)}
              actions={<Link className="btn btn-primary" to={`/conversations?contact=${open.id}`}>Open in Live Chat</Link>}
            />
          </div>
        </>
      )}

      {dialog && (
        <BulkDialog
          kind={dialog}
          count={count}
          working={working}
          onClose={() => setDialog(null)}
          onTag={(tag, add) => apply(add ? `Tag “${tag}” added` : `Tag “${tag}” removed`, (ids) => supabase.rpc("bulk_tag", { p_ids: ids, p_tag: tag, p_add: add }))}
          onField={(key, value) =>
            apply(value === null ? `“${key}” cleared` : `“${key}” set`, (ids) => supabase.rpc("bulk_set_field", { p_ids: ids, p_key: key, p_value: value }))
          }
          onSequence={(seq, add) =>
            add
              ? apply("Subscribed", async (ids) => {
                  // Already-running subscriptions keep their place; everyone else starts at message 1.
                  const { data, error } = await supabase
                    .from("sequence_subscription")
                    .select("contact_id")
                    .eq("sequence_id", seq)
                    .eq("status", "active")
                    .in("contact_id", ids);
                  if (error) return { error };
                  const running = new Set((data ?? []).map((r) => r.contact_id));
                  const now = new Date().toISOString();
                  const fresh = ids.filter((id) => !running.has(id));
                  if (!fresh.length) return { error: null };
                  return supabase.from("sequence_subscription").upsert(
                    fresh.map((id) => ({ sequence_id: seq, contact_id: id, step: 0, next_send_at: now, status: "active" })),
                    { onConflict: "sequence_id,contact_id" },
                  );
                }, 100)
              : apply("Unsubscribed from the sequence", (ids) =>
                  supabase.from("sequence_subscription").update({ status: "cancelled" }).eq("sequence_id", seq).eq("status", "active").in("contact_id", ids),
                100)
          }
        />
      )}
    </>
  );
}

function SegmentMenu({
  segments,
  active,
  onPick,
  onDelete,
}: {
  segments: Segment[];
  active?: Segment;
  onPick: (s: Segment) => void;
  onDelete: (s: Segment) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useOutside(ref, open, () => setOpen(false));
  return (
    <div className="menu-wrap" ref={ref}>
      <button className={`btn ${open ? "is-on" : ""}`} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        Segments{segments.length ? ` (${segments.length})` : ""} ▾
      </button>
      {open && (
        <div className="menu-pop ct-seg-pop pop-in" role="menu">
          {segments.length === 0 && <p className="lc-pop-empty" style={{ margin: 8 }}>No segments yet. Add conditions, then Save as Segment.</p>}
          {segments.map((s) => (
            <div key={s.id} className={`ct-seg-row ${active?.id === s.id ? "is-current" : ""}`}>
              <button role="menuitem" className="menu-item" onClick={() => { onPick(s); setOpen(false); }}>{s.name}</button>
              <button className="icon-btn" onClick={() => onDelete(s)} aria-label={`Delete segment ${s.name}`}>×</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function BulkMenu({ disabled, onPick }: { disabled: boolean; onPick: (k: Bulk | "export" | "delete") => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useOutside(ref, open, () => setOpen(false));
  return (
    <div className="menu-wrap" ref={ref}>
      <button className={`btn btn-primary ${disabled ? "is-busy" : ""}`} disabled={disabled} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        Bulk Actions ▾
      </button>
      {open && (
        <div className="menu-pop ct-bulk-pop pop-in" role="menu">
          {BULK.map((b) => (
            <button
              key={b.kind}
              role="menuitem"
              className={`menu-item ${b.danger ? "is-danger" : ""}`}
              onClick={() => {
                setOpen(false);
                onPick(b.kind);
              }}
            >
              {b.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** The small form a bulk action needs: which tag, sequence or field. */
function BulkDialog({
  kind,
  count,
  working,
  onClose,
  onTag,
  onField,
  onSequence,
}: {
  kind: Bulk;
  count: number;
  working: boolean;
  onClose: () => void;
  onTag: (tag: string, add: boolean) => void;
  onField: (key: string, value: string | null) => void;
  onSequence: (id: string, add: boolean) => void;
}) {
  const [tags, setTags] = useState<string[]>([]);
  const [fields, setFields] = useState<string[]>([]);
  const [sequences, setSequences] = useState<{ id: string; name: string }[]>([]);
  // a: the tag, sequence or field picked; fresh: a new field's name; value: what to set it to.
  const [a, setA] = useState("");
  const [fresh, setFresh] = useState("");
  const [value, setValue] = useState("");

  useEffect(() => {
    supabase.rpc("tag_counts").then(({ data }) => setTags((data ?? []).map((t: { name: string }) => t.name).sort()));
    supabase.from("custom_field").select("key").order("key").then(({ data }) => setFields((data ?? []).map((f) => f.key as string)));
    supabase.from("sequence").select("id, name").order("name").then(({ data }) => setSequences(data ?? []));
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const who = `${count} contact${count === 1 ? "" : "s"}`;
  const fieldKey = a === "__new__" ? fresh.trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "") : a;
  let title = "";
  let body: ReactNode = null;
  let ready = false;
  let go = () => {};

  if (kind === "tag_add" || kind === "tag_remove") {
    const add = kind === "tag_add";
    title = add ? `Add a tag to ${who}` : `Remove a tag from ${who}`;
    ready = Boolean(a.trim());
    go = () => onTag(a.trim(), add);
    body = add ? (
      <>
        <input className="input" list="bulk-tags" placeholder="Tag name" value={a} onChange={(e) => setA(e.target.value)} autoFocus />
        <datalist id="bulk-tags">{tags.map((t) => <option key={t} value={t} />)}</datalist>
      </>
    ) : (
      <Select value={a} onChange={setA} ariaLabel="Tag" options={[{ value: "", label: tags.length ? "Choose a tag" : "No tags yet" }, ...tags.map((t) => ({ value: t, label: t }))]} />
    );
  } else if (kind === "seq_add" || kind === "seq_remove") {
    const add = kind === "seq_add";
    title = add ? `Subscribe ${who} to a sequence` : `Unsubscribe ${who} from a sequence`;
    ready = Boolean(a);
    go = () => onSequence(a, add);
    body = (
      <>
        <Select value={a} onChange={setA} ariaLabel="Sequence" options={[{ value: "", label: sequences.length ? "Choose a sequence" : "No sequences yet" }, ...sequences.map((s) => ({ value: s.id, label: s.name }))]} />
        {add && <p className="lc-help">Contacts already in it keep their place. Everyone else starts at the first message.</p>}
      </>
    );
  } else if (kind === "field_set" || kind === "field_clear") {
    const set = kind === "field_set";
    title = set ? `Set a custom field for ${who}` : `Clear a custom field for ${who}`;
    ready = Boolean(fieldKey);
    go = () => onField(fieldKey, set ? value : null);
    body = (
      <>
        <Select
          value={a}
          onChange={setA}
          ariaLabel="Field"
          options={[
            { value: "", label: "Choose a field" },
            ...fields.map((f) => ({ value: f, label: f })),
            ...(set ? [{ value: "__new__", label: "+ New field…" }] : []),
          ]}
        />
        {set && a === "__new__" && (
          <input className="input" placeholder="New field name, e.g. city" value={fresh} onChange={(e) => setFresh(e.target.value)} autoFocus />
        )}
        {set && a && (
          <input className="input" placeholder="Value (leave empty to blank it)" value={value} onChange={(e) => setValue(e.target.value)} dir="auto" />
        )}
      </>
    );
  }

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="pick-modal ct-dialog" role="dialog" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <header className="pick-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">×</button>
        </header>
        <div className="ct-dialog-body">{body}</div>
        <footer className="pick-foot">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className={`btn btn-primary ${working ? "is-busy" : ""}`} disabled={!ready || working} onClick={go}>
            Apply to {who}
          </button>
        </footer>
      </div>
    </div>
  );
}

function useOutside(ref: React.RefObject<HTMLElement | null>, open: boolean, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [ref, open, close]);
}

/** One row per contact, every custom field as its own column. */
function downloadCsv(list: Contact[]) {
  const keys = [...new Set(list.flatMap((c) => Object.keys(c.custom_fields ?? {})))].sort();
  const head = ["Name", "Username", "Instagram ID", "Subscribed", "Tags", "Assigned to", "Conversation", "Follows you", "Last interaction", "Contact since", ...keys];
  const cell = (v: unknown) => {
    const s = v == null ? "" : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = list.map((c) =>
    [
      c.name ?? "",
      c.username ?? "",
      c.igsid,
      c.opted_out_at ? "No" : "Yes",
      (c.tags ?? []).join("; "),
      c.assigned_to ?? "",
      c.status === "done" ? "Closed" : "Open",
      c.follows_account === null ? "" : c.follows_account ? "Yes" : "No",
      c.last_interaction_at ?? "",
      c.created_at,
      ...keys.map((k) => (c.custom_fields ?? {})[k]),
    ].map(cell).join(","),
  );
  // The byte-order mark lets Excel read Arabic names correctly.
  const blob = new Blob(["﻿" + [head.join(","), ...lines].join("\r\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `contacts-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
