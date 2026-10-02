import { useEffect, useSyncExternalStore } from "react";
import { errorText } from "../lib/supabase";

type Kind = "success" | "error" | "info";

interface ToastItem {
  id: number;
  kind: Kind;
  text: string;
  leaving: boolean;
}

// A tiny module-level store: any screen can call toast.* without a provider or a hook.
let items: ToastItem[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

function emit() {
  items = [...items];
  listeners.forEach((l) => l());
}

function dismiss(id: number) {
  const t = items.find((x) => x.id === id);
  if (!t || t.leaving) return;
  t.leaving = true;
  emit();
  // Let the exit animation play before the node goes away.
  setTimeout(() => {
    items = items.filter((x) => x.id !== id);
    emit();
  }, 180);
}

function push(kind: Kind, text: string) {
  // The same message twice in a row just refreshes, it does not stack.
  const dup = items.find((x) => x.text === text && x.kind === kind && !x.leaving);
  if (dup) dismiss(dup.id);
  const id = nextId++;
  items = [...items.slice(-3), { id, kind, text, leaving: false }];
  emit();
  setTimeout(() => dismiss(id), kind === "error" ? 6000 : 3200);
}

/** Turn raw transport/database failures into something a person can act on. */
export function friendlyError(err: unknown): string {
  const msg = errorText(err);
  if (/failed to fetch|networkerror|load failed/i.test(msg)) return "Can't reach the server. Check your connection and try again.";
  if (/timeout|aborted|signal is aborted/i.test(msg)) return "The server took too long to answer. Try again.";
  if (/PGRST205|could not find the table|relation .* does not exist/i.test(msg))
    return "This feature's database table is missing. Run the latest migrations (supabase db push).";
  if (/JWT|not signed in|401/i.test(msg)) return "Your session expired. Sign in again.";
  if (/duplicate key|already exists|23505/i.test(msg)) return "That already exists.";
  if (/violates foreign key|23503/i.test(msg)) return "Something this depends on was deleted. Refresh and try again.";
  return msg || "Something went wrong.";
}

export const toast = {
  success: (text: string) => push("success", text),
  info: (text: string) => push("info", text),
  error: (err: unknown) => push("error", friendlyError(err)),
};

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

const ICON: Record<Kind, string> = { success: "✓", error: "!", info: "i" };

export function Toaster() {
  const list = useSyncExternalStore(subscribe, () => items);

  // Escape clears every toast.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") items.forEach((t) => dismiss(t.id));
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="toaster" role="region" aria-label="Notifications">
      {list.map((t) => (
        <div
          key={t.id}
          className={`toast toast-${t.kind} ${t.leaving ? "is-leaving" : ""}`}
          role={t.kind === "error" ? "alert" : "status"}
        >
          <span className="toast-ic" aria-hidden="true">{ICON[t.kind]}</span>
          <span className="toast-text">{t.text}</span>
          <button className="toast-x" onClick={() => dismiss(t.id)} aria-label="Dismiss">×</button>
        </div>
      ))}
    </div>
  );
}
