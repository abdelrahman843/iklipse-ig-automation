import { useEffect, useRef, useState, useSyncExternalStore } from "react";

interface Request {
  title: string;
  body?: string;
  confirmLabel?: string;
  danger?: boolean;
  /** When set, the dialog asks for a line of text and resolves with it. */
  input?: { placeholder?: string; initial?: string };
  resolve: (value: string | null) => void;
}

let current: Request | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

function open(req: Omit<Request, "resolve">): Promise<string | null> {
  current?.resolve(null);
  return new Promise((resolve) => {
    current = { ...req, resolve };
    emit();
  });
}

/**
 * A styled replacement for window.confirm. Resolves true when the person confirms.
 *   if (!(await confirmDialog({ title: "Delete this flow?", danger: true }))) return;
 */
export async function confirmDialog(opts: Omit<Request, "resolve" | "input">): Promise<boolean> {
  return (await open(opts)) !== null;
}

/**
 * A styled replacement for window.prompt. Resolves the trimmed text, or null when cancelled
 * or left empty.
 */
export async function promptDialog(
  opts: Omit<Request, "resolve" | "input" | "danger"> & { placeholder?: string; initial?: string },
): Promise<string | null> {
  const { placeholder, initial, ...rest } = opts;
  const value = await open({ ...rest, input: { placeholder, initial } });
  return value?.trim() || null;
}

function close(value: string | null) {
  current?.resolve(value);
  current = null;
  emit();
}

export function ConfirmHost() {
  const req = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
  const okRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState("");

  useEffect(() => {
    if (!req) return;
    setValue(req.input?.initial ?? "");
    (req.input ? inputRef.current : okRef.current)?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") close(null);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [req]);

  if (!req) return null;
  const blocked = Boolean(req.input) && !value.trim();
  const submit = () => !blocked && close(req.input ? value : "");
  return (
    <div className="modal-scrim" onMouseDown={(e) => e.target === e.currentTarget && close(null)}>
      <form
        className="modal confirm"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <h2 id="confirm-title" className="confirm-title">{req.title}</h2>
        {req.body && <p className="confirm-body">{req.body}</p>}
        {req.input && (
          <input
            ref={inputRef}
            className="input confirm-input"
            placeholder={req.input.placeholder}
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        )}
        <div className="confirm-actions">
          <button type="button" className="btn" onClick={() => close(null)}>Cancel</button>
          <button
            ref={okRef}
            type="submit"
            className={`btn ${req.danger ? "btn-danger-solid" : "btn-primary"}`}
            disabled={blocked}
          >
            {req.confirmLabel ?? "Confirm"}
          </button>
        </div>
      </form>
    </div>
  );
}
