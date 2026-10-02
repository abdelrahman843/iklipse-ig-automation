import { useEffect, useRef, useState } from "react";
import { supabase } from "../lib/supabase";
import { FIELDS, describe, fieldDef, isComplete, type Condition, type ConditionField } from "../lib/conditions";
import { Select } from "./Select";

/**
 * Condition chips ("Tag is VIP ×") plus "+ Condition", ManyChat's filter row. All conditions must
 * hold. The pickers (tags, fields, team) load the first time the pop-over opens.
 */
export function ConditionBuilder({
  conditions,
  onChange,
  disabled,
  exclude = [],
  emptyLabel = "Everyone",
}: {
  conditions: Condition[];
  onChange: (next: Condition[]) => void;
  disabled?: boolean;
  /** Fields that make no sense here (a broadcast already leaves out unsubscribed contacts). */
  exclude?: ConditionField[];
  emptyLabel?: string;
}) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<Condition>({ field: "tag", op: "is", value: "" });
  const [lists, setLists] = useState<{ tags: string[]; fields: string[]; team: string[] } | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!adding || lists) return;
    Promise.all([
      supabase.rpc("tag_counts"),
      supabase.from("custom_field").select("key").order("key"),
      supabase.from("agent").select("name").order("name"),
      supabase.from("contact").select("assigned_to").not("assigned_to", "is", null).limit(500),
    ]).then(([t, f, a, c]) => {
      const team = new Set<string>([...(a.data ?? []).map((x) => x.name as string), ...(c.data ?? []).map((x) => x.assigned_to as string)]);
      setLists({
        tags: (t.data ?? []).map((x: { name: string }) => x.name).sort(),
        fields: (f.data ?? []).map((x) => x.key as string),
        team: [...team].sort(),
      });
    });
  }, [adding, lists]);

  // Close on a click outside or Escape.
  useEffect(() => {
    if (!adding) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setAdding(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setAdding(false);
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [adding]);

  const def = fieldDef(draft.field);
  const op = def.ops.find((o) => o.op === draft.op) ?? def.ops[0];
  const pickField = (field: ConditionField) => {
    const d = fieldDef(field);
    setDraft({ field, op: d.ops[0].op, value: d.value === "days" ? "7" : d.choices?.[0].value ?? "" });
  };

  function add() {
    if (!isComplete(draft)) return;
    onChange([...conditions, op.noValue ? { field: draft.field, op: draft.op, key: draft.key } : draft]);
    setAdding(false);
    pickField(draft.field);
  }

  return (
    <div className="cond-row">
      {conditions.length === 0 && <span className="cond-chip is-all">{emptyLabel}</span>}
      {conditions.map((c, i) => {
        const d = describe(c);
        return (
          <span key={i} className="cond-chip">
            {d.subject} {d.op} {d.value && <strong>{d.value}</strong>}
            {!disabled && (
              <button className="cond-x" onClick={() => onChange(conditions.filter((_, j) => j !== i))} aria-label="Remove condition">×</button>
            )}
          </span>
        );
      })}
      {!disabled && (
        <div className="pop-anchor" ref={ref}>
          <button className="btn btn-quiet" onClick={() => setAdding((a) => !a)} aria-expanded={adding}>+ Condition</button>
          {adding && (
            <div className="pop-card cond-pop" style={{ left: 0, right: "auto" }}>
              <label className="label">Condition</label>
              <Select
                value={draft.field}
                onChange={(v) => pickField(v as ConditionField)}
                ariaLabel="Condition"
                options={FIELDS.filter((f) => !exclude.includes(f.field)).map((f) => ({ value: f.field, label: f.label }))}
              />
              {draft.field === "custom" && (
                lists?.fields.length === 0 ? (
                  <p className="mono" style={{ margin: 0 }}>No custom fields yet. Add one in Settings › Fields.</p>
                ) : (
                  <Select
                    value={draft.key ?? ""}
                    onChange={(key) => setDraft({ ...draft, key })}
                    ariaLabel="Field"
                    options={[{ value: "", label: "Choose a field" }, ...(lists?.fields ?? []).map((k) => ({ value: k, label: k }))]}
                  />
                )
              )}
              <Select
                value={op.op}
                onChange={(v) => setDraft({ ...draft, op: v })}
                ariaLabel="Rule"
                options={def.ops.map((o) => ({ value: o.op, label: o.label }))}
              />
              {!op.noValue && (
                <ValueInput draft={draft} kind={def.value} choices={def.choices} lists={lists} onChange={(value) => setDraft({ ...draft, value })} />
              )}
              <div className="row-between">
                <button className="btn btn-quiet" onClick={() => setAdding(false)}>Cancel</button>
                <button className="btn btn-primary" disabled={!isComplete(draft)} onClick={add}>Add</button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ValueInput({
  draft,
  kind,
  choices,
  lists,
  onChange,
}: {
  draft: Condition;
  kind: string;
  choices?: { value: string; label: string }[];
  lists: { tags: string[]; fields: string[]; team: string[] } | null;
  onChange: (v: string) => void;
}) {
  if (kind === "tag") {
    if (lists && !lists.tags.length) return <p className="mono" style={{ margin: 0 }}>No tags yet. Tag contacts in Live Chat or Settings › Tags.</p>;
    return (
      <Select
        value={draft.value ?? ""}
        onChange={onChange}
        ariaLabel="Tag"
        options={[{ value: "", label: lists ? "Choose a tag" : "Loading tags…" }, ...(lists?.tags ?? []).map((t) => ({ value: t, label: t }))]}
      />
    );
  }
  if (kind === "agent") {
    return (
      <Select
        value={draft.value ?? ""}
        onChange={onChange}
        ariaLabel="Team member"
        options={[{ value: "", label: "Nobody (unassigned)" }, ...(lists?.team ?? []).map((t) => ({ value: t, label: t }))]}
      />
    );
  }
  if (kind === "choice") {
    return <Select value={draft.value ?? ""} onChange={onChange} ariaLabel="Value" options={choices ?? []} />;
  }
  if (kind === "days") {
    return (
      <label className="cond-days">
        <input
          className="input"
          type="number"
          min={1}
          max={99999}
          value={draft.value ?? ""}
          onChange={(e) => onChange(e.target.value.replace(/\D/g, ""))}
          aria-label="Days"
        />
        <span>days{draft.op === "older" ? " ago" : ""}</span>
      </label>
    );
  }
  return <input className="input" value={draft.value ?? ""} placeholder="Value" onChange={(e) => onChange(e.target.value)} aria-label="Value" dir="auto" />;
}
