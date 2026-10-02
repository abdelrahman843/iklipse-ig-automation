/**
 * A bouncing-cube loader, shown while a screen fetches its data.
 * By default it fills the space left on the screen and sits in its middle; `inline` keeps it
 * small for use inside a card or a modal.
 */
export function Loader({ label, inline }: { label?: string; inline?: boolean }) {
  return (
    <div className={`loader-wrap ${inline ? "is-inline" : ""}`} role="status" aria-live="polite">
      <div className="loader" aria-hidden="true" />
      {label && <span className="loader-label">{label}</span>}
    </div>
  );
}
