import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";

/** The ⋮ menu at the start of a table row. */
export function RowMenu({ items, label = "Actions" }: { items: { label: string; onSelect: () => void; danger?: boolean }[]; label?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="row-menu" ref={ref} onClick={(e) => e.stopPropagation()}>
      <button className="kebab" aria-label={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <svg width="4" height="16" viewBox="0 0 4 16" aria-hidden="true">
          <circle cx="2" cy="2" r="1.6" fill="currentColor" />
          <circle cx="2" cy="8" r="1.6" fill="currentColor" />
          <circle cx="2" cy="14" r="1.6" fill="currentColor" />
        </svg>
      </button>
      {open && (
        <div className="dd-menu row-menu-pop" role="menu">
          {items.map((it) => (
            <button
              key={it.label}
              role="menuitem"
              className={`dd-item ${it.danger ? "is-danger" : ""}`}
              onClick={() => {
                setOpen(false);
                it.onSelect();
              }}
            >
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * ManyChat's page header: "Broadcasts › Drafts › Name ✎". The last crumb is the page's own name
 * and edits in place when onRename is given.
 */
export function Crumbs({
  trail,
  name,
  onRename,
  actions,
}: {
  trail: { label: string; to?: string }[];
  name: string;
  onRename?: (name: string) => void;
  actions?: ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  useEffect(() => setDraft(name), [name]);

  function commit() {
    setEditing(false);
    const next = draft.trim();
    if (next && next !== name) onRename?.(next);
    else setDraft(name);
  }

  return (
    <header className="crumbs-bar">
      <nav className="crumbs" aria-label="Breadcrumb">
        {trail.map((c) => (
          <span key={c.label} className="crumb">
            {c.to ? <Link to={c.to}>{c.label}</Link> : c.label}
            <span className="crumb-sep" aria-hidden="true">›</span>
          </span>
        ))}
        {editing ? (
          <input
            className="crumb-input"
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
              if (e.key === "Escape") {
                setDraft(name);
                setEditing(false);
              }
            }}
          />
        ) : (
          <h1 className="crumb-name">
            {name}
            {onRename && (
              <button className="crumb-edit" onClick={() => setEditing(true)} aria-label="Rename">
                <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M11.5 2.5l2 2L6 12l-3 1 1-3 7.5-7.5z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
                </svg>
              </button>
            )}
          </h1>
        )}
      </nav>
      {actions && <div className="crumbs-actions">{actions}</div>}
    </header>
  );
}

/** ManyChat-style on/off switch. */
export function Toggle({ on, onChange, label, disabled }: { on: boolean; onChange: (on: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      className={`switch ${on ? "on" : ""}`}
      onClick={(e) => {
        e.stopPropagation();
        onChange(!on);
      }}
    >
      <span className="switch-knob" />
    </button>
  );
}

/** "✓ Saved" / "Saving…" / "Not saved" next to the page actions. */
export function SaveState({ state }: { state: "idle" | "saving" | "saved" | "failed" }) {
  if (state === "idle") return null;
  return (
    <span className={`save-state ${state === "failed" ? "is-failed" : ""}`} role="status">
      {state === "saving" ? "Saving…" : state === "saved" ? "✓ Saved" : "Not saved"}
    </span>
  );
}
