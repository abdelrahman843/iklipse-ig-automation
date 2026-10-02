import type { ReactNode } from "react";
import { blankBlock, blockKind, type Block, type BlockKind } from "../lib/content";
import type { MessageButton, MessageCard } from "../lib/types";
import { ImageField } from "./ImageField";
import { PhonePreview } from "./PhonePreview";
import { LINK_IN_TEXT_HINT, linkInText, SHORTENED_LINK_HINT, shortenedLink } from "../lib/spamHints";

const KINDS: { kind: BlockKind; name: string; hint: string; icon: ReactNode }[] = [
  {
    kind: "text",
    name: "Text",
    hint: "Add simple text and buttons",
    icon: (
      <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
        <path d="M3 5h14M3 9h14M3 13h9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    kind: "image",
    name: "Image",
    hint: "Boost engagement with visuals",
    icon: (
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
        <rect x="2.5" y="3.5" width="15" height="13" rx="2.5" stroke="currentColor" strokeWidth="1.6" />
        <circle cx="7.5" cy="8" r="1.5" fill="currentColor" />
        <path d="M3.5 15l4-3.5 3 2.5 2.5-2 3.5 3" stroke="currentColor" strokeWidth="1.6" />
      </svg>
    ),
  },
  {
    kind: "gallery",
    name: "Gallery",
    hint: "Add up to 10 images with buttons",
    icon: (
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
        <rect x="2" y="5" width="11" height="10" rx="2" stroke="currentColor" strokeWidth="1.6" />
        <path d="M15.5 6.5v7M18 8v4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    ),
  },
];

const MAX_BLOCKS = 10;

/**
 * ManyChat's Basic Builder: a "Send Message" column of content blocks on the left, the phone
 * preview on the right. Each block is sent as its own bubble, in order.
 */
export function Composer({
  blocks,
  onChange,
  disabled,
  aside,
}: {
  blocks: Block[];
  onChange: (blocks: Block[]) => void;
  disabled?: boolean;
  /** Extra controls shown under the blocks (e.g. "Send an automation instead"). */
  aside?: ReactNode;
}) {
  const set = (i: number, b: Block) => onChange(blocks.map((x, j) => (j === i ? b : x)));
  const move = (i: number, by: number) => {
    const next = [...blocks];
    const [b] = next.splice(i, 1);
    next.splice(i + by, 0, b);
    onChange(next);
  };

  return (
    <div className="bb">
      <div className="bb-left">
        <div className="bb-title">Send Message</div>
        <div className="bb-blocks">
          {blocks.map((b, i) => (
            <div key={i} className="block-card">
              <div className="block-head">
                <span className="block-kind">{KINDS.find((k) => k.kind === blockKind(b))?.name}</span>
                {!disabled && (
                  <span className="block-tools">
                    <button type="button" className="icon-btn" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up">↑</button>
                    <button type="button" className="icon-btn" disabled={i === blocks.length - 1} onClick={() => move(i, 1)} aria-label="Move down">↓</button>
                    <button type="button" className="icon-btn" onClick={() => onChange(blocks.filter((_, j) => j !== i))} aria-label="Remove block">×</button>
                  </span>
                )}
              </div>
              <BlockEditor block={b} onChange={(nb) => set(i, nb)} disabled={disabled} />
            </div>
          ))}
        </div>
        {!disabled && blocks.length < MAX_BLOCKS && (
          <>
            <p className="bb-add-label">Add one of the content blocks:</p>
            <div className="stack" style={{ gap: 8 }}>
              {KINDS.map((k) => (
                <button key={k.kind} type="button" className="block-add" onClick={() => onChange([...blocks, blankBlock(k.kind)])}>
                  <span className="block-add-ic">{k.icon}</span>
                  <span className="block-add-text">
                    <strong>{k.name}</strong>
                    <span>{k.hint}</span>
                  </span>
                </button>
              ))}
            </div>
          </>
        )}
        {aside}
      </div>
      <div className="bb-right">
        <PhonePreview blocks={blocks} />
      </div>
    </div>
  );
}

function BlockEditor({ block, onChange, disabled }: { block: Block; onChange: (b: Block) => void; disabled?: boolean }) {
  const kind = blockKind(block);

  if (kind === "image") {
    return <ImageField value={block.imageUrl ?? ""} onChange={(imageUrl) => onChange({ imageUrl })} disabled={disabled} />;
  }

  if (kind === "gallery") {
    const cards = block.cards ?? [];
    const setCard = (i: number, patch: Partial<MessageCard>) =>
      onChange({ cards: cards.map((c, j) => (j === i ? { ...c, ...patch } : c)) });
    return (
      <div className="stack" style={{ gap: 10 }}>
        {cards.map((c, i) => (
          <div key={i} className="gallery-card">
            <div className="row-between">
              <span className="mono">Card {i + 1}</span>
              {!disabled && cards.length > 1 && (
                <button type="button" className="link-btn" onClick={() => onChange({ cards: cards.filter((_, j) => j !== i) })}>
                  Remove card
                </button>
              )}
            </div>
            <ImageField compact value={c.imageUrl ?? ""} onChange={(imageUrl) => setCard(i, { imageUrl })} disabled={disabled} />
            <input className="input" placeholder="Title" maxLength={80} value={c.title} disabled={disabled} onChange={(e) => setCard(i, { title: e.target.value })} />
            <input className="input" placeholder="Subtitle (optional)" maxLength={80} value={c.subtitle ?? ""} disabled={disabled} onChange={(e) => setCard(i, { subtitle: e.target.value })} />
            <Buttons buttons={c.buttons ?? []} onChange={(buttons) => setCard(i, { buttons })} disabled={disabled} />
          </div>
        ))}
        {!disabled && cards.length < 10 && (
          <button type="button" className="btn btn-quiet" onClick={() => onChange({ cards: [...cards, { title: "", subtitle: "", imageUrl: "", buttons: [] }] })}>
            + Add card
          </button>
        )}
      </div>
    );
  }

  const limit = block.buttons?.length ? 640 : 1000;
  const len = (block.text ?? "").length;
  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="counted">
        <textarea
          className="textarea"
          placeholder="Enter your text…"
          value={block.text ?? ""}
          disabled={disabled}
          onChange={(e) => onChange({ ...block, text: e.target.value })}
        />
        <span className={`counted-n ${len > limit ? "is-over" : ""}`}>{limit - len}</span>
      </div>
      {linkInText(block.text) && <span className="mono field-warn">{LINK_IN_TEXT_HINT}</span>}
      <Buttons buttons={block.buttons ?? []} onChange={(buttons) => onChange({ ...block, buttons })} disabled={disabled} />
    </div>
  );
}

/** Up to three link buttons under a text or a card. */
function Buttons({ buttons, onChange, disabled }: { buttons: MessageButton[]; onChange: (b: MessageButton[]) => void; disabled?: boolean }) {
  const set = (i: number, patch: Partial<MessageButton>) => onChange(buttons.map((b, j) => (j === i ? { ...b, ...patch } : b)));
  return (
    <div className="stack" style={{ gap: 6 }}>
      {buttons.map((b, i) => (
        <div key={i}>
          <div className="btn-edit">
            <input className="input" placeholder="Button title" maxLength={20} value={b.title} disabled={disabled} onChange={(e) => set(i, { title: e.target.value })} />
            <input className="input" placeholder="https://…" value={b.url ?? ""} disabled={disabled} onChange={(e) => set(i, { url: e.target.value })} />
            {!disabled && (
              <button type="button" className="icon-btn" onClick={() => onChange(buttons.filter((_, j) => j !== i))} aria-label="Remove button">×</button>
            )}
          </div>
          {shortenedLink(b.url) && <span className="mono field-warn">{SHORTENED_LINK_HINT}</span>}
        </div>
      ))}
      {!disabled && buttons.length < 3 && (
        <button type="button" className="add-button-row" onClick={() => onChange([...buttons, { title: "", url: "", payload: "" }])}>
          + Add Button
        </button>
      )}
    </div>
  );
}

