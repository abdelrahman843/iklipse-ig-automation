import type { ReactNode } from "react";
import { blockKind, hasBody, type Block } from "../lib/content";

/** A phone showing an Instagram DM thread, the way the contact will see it. */
export function PhonePreview({
  blocks = [],
  starters,
  menu,
  footer,
}: {
  blocks?: Block[];
  /** Conversation starters, shown on an empty thread. */
  starters?: string[];
  /** Main-menu items, shown as the "More options" sheet. */
  menu?: string[];
  footer?: ReactNode;
}) {
  const shown = blocks.filter(hasBody);
  return (
    <div className="phone" aria-label="Preview">
      <div className="phone-notch" />
      <div className="phone-head">
        <span className="phone-avatar" />
        <span className="phone-name">Your account</span>
      </div>
      <div className="phone-thread">
        {starters && (
          <div className="phone-empty">
            <span className="phone-avatar is-big" />
            <span className="phone-name">Your account</span>
            <span className="phone-sub">Instagram</span>
          </div>
        )}
        {shown.map((b, i) => (
          <PreviewBubble key={i} block={b} />
        ))}
        {!shown.length && !starters && !menu && <p className="phone-hint">Your message shows up here.</p>}
      </div>
      {starters && starters.length > 0 && (
        <div className="phone-starters">
          {starters.map((q, i) => (
            <span key={i} className="phone-chip">{q || "Question"}</span>
          ))}
        </div>
      )}
      {menu && (
        <div className="phone-sheet">
          <span className="phone-sheet-grip" />
          {menu.length ? (
            menu.map((m, i) => (
              <span key={i} className="phone-sheet-item">{m || "Menu item"}</span>
            ))
          ) : (
            <span className="phone-sheet-item is-empty">No menu items yet</span>
          )}
        </div>
      )}
      <div className="phone-compose">Message…</div>
      {footer}
    </div>
  );
}

function PreviewBubble({ block }: { block: Block }) {
  const kind = blockKind(block);
  if (kind === "image") {
    return <img className="phone-img" src={block.imageUrl} alt="" />;
  }
  if (kind === "gallery") {
    return (
      <div className="phone-gallery">
        {(block.cards ?? []).map((c, i) => (
          <div key={i} className="phone-card">
            {c.imageUrl ? <img src={c.imageUrl} alt="" /> : <div className="phone-card-ph" />}
            <div className="phone-card-body">
              <strong>{c.title || "Title"}</strong>
              {c.subtitle && <span>{c.subtitle}</span>}
            </div>
            {(c.buttons ?? []).map((b, j) => (
              <span key={j} className="phone-btn">{b.title || "Button"}</span>
            ))}
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className={`phone-bubble ${block.buttons?.length ? "has-buttons" : ""}`}>
      <span className="phone-text">{block.text}</span>
      {(block.buttons ?? []).map((b, j) => (
        <span key={j} className="phone-btn">{b.title || "Button"}</span>
      ))}
    </div>
  );
}
