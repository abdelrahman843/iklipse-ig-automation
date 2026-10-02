import { useRef, useState } from "react";
import { IMAGE_TYPES, uploadImage } from "../lib/content";
import { toast } from "./Toast";

/**
 * "Upload image or insert URL" — ManyChat's inline image control. Uploading puts the file in the
 * public media bucket (Instagram fetches images by link) and fills in its link.
 */
export function ImageField({
  value,
  onChange,
  disabled,
  compact,
}: {
  value: string;
  onChange: (url: string) => void;
  disabled?: boolean;
  /** Smaller drop area, for gallery cards. */
  compact?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const [typing, setTyping] = useState(false);

  async function take(file: File | undefined) {
    if (!file || busy || disabled) return;
    setBusy(true);
    try {
      onChange(await uploadImage(file));
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }

  const bad = value.trim() !== "" && !/^https:\/\/\S+$/i.test(value.trim());

  if (value && !typing) {
    return (
      <div className={`imgf has-image ${compact ? "is-compact" : ""}`}>
        <img src={value} alt="" />
        {!disabled && (
          <div className="imgf-over">
            <button type="button" className="btn" onClick={() => input.current?.click()} disabled={busy}>
              {busy ? "Uploading…" : "Replace"}
            </button>
            <button type="button" className="btn" onClick={() => onChange("")}>Remove</button>
          </div>
        )}
        <input ref={input} className="visually-hidden" type="file" accept={IMAGE_TYPES.join(",")} onChange={(e) => take(e.target.files?.[0])} />
        {bad && <span className="mono field-warn">Use a public https:// link.</span>}
      </div>
    );
  }

  return (
    <div className="stack" style={{ gap: 6 }}>
      <label
        className={`imgf ${compact ? "is-compact" : ""} ${over ? "is-over" : ""} ${disabled ? "is-disabled" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          take(e.dataTransfer.files?.[0]);
        }}
      >
        <input
          ref={input}
          className="visually-hidden"
          type="file"
          accept={IMAGE_TYPES.join(",")}
          disabled={disabled || busy}
          onChange={(e) => take(e.target.files?.[0])}
        />
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <rect x="3" y="4" width="18" height="16" rx="3" stroke="currentColor" strokeWidth="1.6" />
          <circle cx="9" cy="10" r="1.8" fill="currentColor" />
          <path d="M4 18l5-4.5 3.5 3 3-2.5L20 17" stroke="currentColor" strokeWidth="1.6" />
        </svg>
        <span className="imgf-title">{busy ? "Uploading…" : "Upload image"}</span>
        {!compact && <span className="imgf-sub">JPG, PNG or GIF · up to 8 MB</span>}
      </label>
      {typing ? (
        <div className="cluster" style={{ gap: 6, flexWrap: "nowrap" }}>
          <input
            className="input"
            autoFocus
            placeholder="https://…"
            value={value}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value)}
          />
          <button type="button" className="btn btn-quiet" onClick={() => setTyping(false)}>Done</button>
        </div>
      ) : (
        !disabled && (
          <button type="button" className="link-btn" onClick={() => setTyping(true)}>
            or insert URL
          </button>
        )
      )}
      {bad && <span className="mono field-warn">Use a public https:// link.</span>}
    </div>
  );
}
