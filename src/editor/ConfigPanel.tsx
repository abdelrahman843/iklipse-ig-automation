import { Fragment, useEffect, useState } from "react";
import { useEditor } from "./store";
import { def } from "./nodeDefs";
import { describeDelay } from "../lib/time";
import { supabase } from "../lib/supabase";
import { Select } from "../components/Select";
import { PostPicker } from "./PostPicker";
import { TRIGGERS, triggerMeta } from "../lib/triggers";
import { toast } from "../components/Toast";
import { ImageField } from "../components/ImageField";
import type { FlowNodeData, TriggerNodeData } from "./adapter";
import type { ActionKind, FlowAction, FlowNode, InputType, MessageButton, TriggerConfig, TriggerType } from "../lib/types";

/** Slide-in drawer from the left with the selected node's settings. Empty when nothing is picked. */
export function ConfigPanel() {
  const nodes = useEditor((s) => s.nodes);
  const selectedId = useEditor((s) => s.selectedId);
  const updateFlowNode = useEditor((s) => s.updateFlowNode);
  const updateTrigger = useEditor((s) => s.updateTrigger);
  const deleteNode = useEditor((s) => s.deleteNode);
  const select = useEditor((s) => s.select);

  const selected = nodes.find((n) => n.id === selectedId);
  if (!selected) return null;
  if (selected.type === "noteNode") return null; // notes are edited in place on the canvas

  const isTrigger = selected.type === "triggerNode";
  const definition = isTrigger ? null : def((selected.data as FlowNodeData).nodeType);
  const flowNode = isTrigger ? null : (selected.data as FlowNodeData).flowNode;

  return (
    <aside className="editor-drawer">
      <div className="drawer-head">
        <span className="drawer-kind">{isTrigger ? "Entry point" : `${definition!.name} · ${selected.id}`}</span>
        <button className="drawer-close" onClick={() => select(null)} aria-label="Close">×</button>
      </div>

      {isTrigger ? (
        <div className="drawer-title-static">Trigger</div>
      ) : (
        <input
          className="drawer-title-input"
          value={flowNode!.title ?? ""}
          placeholder={definition!.name}
          onChange={(e) => updateFlowNode(selected.id, { title: e.target.value })}
          aria-label="Step name"
        />
      )}

      <div className="drawer-body stack" style={{ gap: 16 }}>
        {isTrigger ? (
          <TriggerFields
            data={selected.data as TriggerNodeData}
            onType={(t) => updateTrigger({ trigger_type: t })}
            onConfig={(patch) =>
              updateTrigger({ trigger_config: { ...(selected.data as TriggerNodeData).trigger_config, ...patch } })
            }
          />
        ) : (
          <>
            <NodeFields node={flowNode!} onChange={(patch) => updateFlowNode(selected.id, patch)} />
            <button
              className="btn btn-danger"
              onClick={() => {
                deleteNode(selected.id);
                toast.info("Step deleted. Ctrl+Z brings it back.");
              }}
            >
              Delete step
            </button>
          </>
        )}
      </div>
    </aside>
  );
}

/**
 * Instagram only accepts http(s) links for buttons and media. Warns under the field without
 * blocking typing; an empty value is fine (the field is optional).
 */
function UrlHint({ url, httpsOnly = false }: { url?: string; httpsOnly?: boolean }) {
  const v = (url ?? "").trim();
  if (!v || (httpsOnly ? /^https:\/\//i : /^https?:\/\//i).test(v)) return null;
  return (
    <span className="mono field-warn">
      {httpsOnly ? "Start the link with https://" : "Start the link with https:// or http://"} — Instagram rejects other links.
    </span>
  );
}

/**
 * The trigger config form. Both the trigger list and the per-trigger fields are read from the
 * frontend trigger registry (../lib/triggers), so a new trigger type shows up here with no change
 * to this component. When trigger_type is null (a from-scratch draft) this is a trigger picker.
 */
function TriggerFields({
  data,
  onType,
  onConfig,
}: {
  data: TriggerNodeData;
  onType: (t: TriggerType) => void;
  onConfig: (patch: Partial<TriggerNodeData["trigger_config"]>) => void;
}) {
  const cfg = data.trigger_config ?? {};
  const type = data.trigger_type;
  const meta = triggerMeta(type);
  const fields = meta?.fields ?? {};

  // A placeholder first option so a from-scratch draft (null type) reads "Choose a trigger…".
  const options = [
    ...(type ? [] : [{ value: "", label: "Choose a trigger…" }]),
    ...TRIGGERS.map((t) => ({ value: t.type, label: t.label })),
  ];

  return (
    <>
      <div>
        <label className="label">Starts on</label>
        <Select
          value={type ?? ""}
          onChange={(v) => v && onType(v as TriggerType)}
          ariaLabel="Starts on"
          options={options}
        />
        {meta && <span className="mono">{meta.hint}</span>}
      </div>

      {!type && (
        <p className="mono" style={{ margin: 0 }}>
          Pick what starts this flow. You can change it later while it's a draft.
        </p>
      )}

      {fields.mediaId && (
        <div>
          <label className="label">Which post</label>
          <PostPicker value={cfg.mediaId ?? ""} onChange={(id) => onConfig({ mediaId: id })} />
        </div>
      )}

      {fields.broadcastId && (
        <div>
          <label className="label">Broadcast id</label>
          <input className="input" placeholder="Leave empty for any live" value={cfg.broadcastId ?? ""} onChange={(e) => onConfig({ broadcastId: e.target.value })} />
        </div>
      )}

      {fields.ref && (
        <div>
          <label className="label">Ref value</label>
          <input className="input" placeholder="Leave empty to match any ref" value={cfg.ref ?? ""} onChange={(e) => onConfig({ ref: e.target.value })} />
          <span className="mono">Matches ig.me/m/you?ref=… — mobile only.</span>
        </div>
      )}

      {fields.excludeStoryReplies && (
        <label className="cluster" style={{ gap: 8, cursor: "pointer" }}>
          <input type="checkbox" checked={cfg.excludeStoryReplies ?? false} onChange={(e) => onConfig({ excludeStoryReplies: e.target.checked })} />
          <span className="label" style={{ marginBottom: 0 }}>Skip story replies</span>
        </label>
      )}

      {fields.keywords && (
        <KeywordFields
          cfg={cfg}
          onConfig={onConfig}
          noun={type === "comment" || type === "live_comment" ? "And this comment has" : "And the message has"}
        />
      )}

      {fields.commentReply && <CommentReplyFields cfg={cfg} onConfig={onConfig} />}
    </>
  );
}

const EXAMPLE_WORDS = ["Price", "Link", "Shop"];

/**
 * Keyword matching, shown as ManyChat does: choose "a specific word or words" (with a
 * comma-separated list and example chips) or "any word". Empty keyword list = match anything.
 */
function KeywordFields({ cfg, onConfig, noun }: { cfg: TriggerConfig; onConfig: (patch: Partial<TriggerConfig>) => void; noun: string }) {
  const words = (cfg.keywords ?? []).filter(Boolean);
  const [mode, setMode] = useState<"specific" | "any">(words.length ? "specific" : "any");
  const setWords = (v: string) => onConfig({ keywords: v.split(",").map((s) => s.trim()) });
  const addExample = (w: string) => {
    if (!words.some((x) => x.toLowerCase() === w.toLowerCase())) onConfig({ keywords: [...words, w] });
  };

  return (
    <div className="stack" style={{ gap: 8 }}>
      <label className="label" style={{ margin: 0 }}>{noun}</label>

      <div
        role="radio"
        aria-checked={mode === "specific"}
        tabIndex={0}
        className={`radio-card ${mode === "specific" ? "on" : ""}`}
        onClick={() => setMode("specific")}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && setMode("specific")}
      >
        <span className="radio-dot" />
        <span className="radio-body">
          <span className="radio-label">a specific word or words</span>
          {mode === "specific" && (
            <span className="stack" style={{ gap: 6 }} onClick={(e) => e.stopPropagation()}>
              <input
                className="input"
                placeholder="Enter a word or multiple"
                value={words.join(", ")}
                onChange={(e) => setWords(e.target.value)}
              />
              <span className="mono">Use commas to separate words</span>
              <span className="cluster" style={{ gap: 6 }}>
                <span className="mono">For example:</span>
                {EXAMPLE_WORDS.map((w) => (
                  <button type="button" key={w} className="chip-eg" onClick={() => addExample(w)}>{w}</button>
                ))}
              </span>
              <Select
                value={cfg.match ?? "contains"}
                onChange={(v) => onConfig({ match: v as "contains" | "exact" })}
                ariaLabel="Match"
                options={[
                  { value: "contains", label: "Comment contains the word" },
                  { value: "exact", label: "Comment is exactly the word" },
                ]}
              />
            </span>
          )}
        </span>
      </div>

      <div
        role="radio"
        aria-checked={mode === "any"}
        tabIndex={0}
        className={`radio-card ${mode === "any" ? "on" : ""}`}
        onClick={() => { setMode("any"); onConfig({ keywords: [] }); }}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (setMode("any"), onConfig({ keywords: [] }))}
      >
        <span className="radio-dot" />
        <span className="radio-label">any word</span>
      </div>
    </div>
  );
}

/**
 * "Reply to their comments under the post": a toggle that reveals public reply lines. One line is
 * picked at random each time it fires, so keep a few variations to avoid reading as a bot.
 */
function CommentReplyFields({ cfg, onConfig }: { cfg: TriggerConfig; onConfig: (patch: Partial<TriggerConfig>) => void }) {
  const replies = cfg.commentReply ?? [];
  const on = replies.length > 0;
  const set = (next: string[]) => onConfig({ commentReply: next });

  return (
    <div className="stack" style={{ gap: 10 }}>
      <div className="row-between">
        <span className="label" style={{ margin: 0 }}>Reply to their comments under the post</span>
        <button
          type="button"
          className={`switch ${on ? "on" : ""}`}
          role="switch"
          aria-checked={on}
          aria-label="Reply publicly under the comment"
          onClick={() => (on ? set([]) : set([""]))}
        >
          <span className="switch-knob" />
        </button>
      </div>
      {on && (
        <div className="stack" style={{ gap: 6 }}>
          <span className="mono">Posted publicly under the comment, alongside the DM. One is picked at random.</span>
          {replies.map((r, i) => (
            <div className="button-row" key={i}>
              <input
                className="input"
                placeholder="Sent! Check your DMs 📩"
                value={r}
                onChange={(e) => set(replies.map((x, j) => (i === j ? e.target.value : x)))}
              />
              <button className="btn btn-quiet" onClick={() => set(replies.filter((_, j) => j !== i))}>Remove</button>
            </div>
          ))}
          <div><button className="btn btn-quiet" onClick={() => set([...replies, ""])}>Add reply</button></div>
        </div>
      )}
    </div>
  );
}

function NodeFields({ node, onChange }: { node: FlowNode; onChange: (patch: Partial<FlowNode>) => void }) {
  switch (node.type) {
    case "send_message":
      return <SendMessageFields node={node} onChange={onChange} />;
    case "wait_reply":
      return (
        <>
          <div>
            <label className="label">Save the reply as</label>
            <input className="input" value={node.saveTo ?? ""} placeholder="user_reply" onChange={(e) => onChange({ saveTo: e.target.value })} />
          </div>
          <div>
            <label className="label">Give up after (seconds)</label>
            <input
              className="input"
              type="number"
              min={60}
              value={node.timeoutSeconds ?? 3600}
              onChange={(e) => onChange({ timeoutSeconds: Number(e.target.value) })}
            />
            <span className="mono">{describeDelay(node.timeoutSeconds ?? 3600)}</span>
          </div>
        </>
      );
    case "check_follow":
      return (
        <p className="mono" style={{ margin: 0 }}>
          Asks Meta whether this contact follows the account, then takes one of the two paths.
          Only works after the contact has replied at least once.
        </p>
      );
    case "condition": {
      const isTag = node.op === "has_tag" || node.op === "not_has_tag";
      return (
        <>
          {!isTag && (
            <div>
              <label className="label">Value</label>
              <input className="input" placeholder="state.user_reply" value={node.left ?? ""} onChange={(e) => onChange({ left: e.target.value })} />
            </div>
          )}
          <div>
            <label className="label">Test</label>
            <Select
              value={node.op ?? "eq"}
              onChange={(v) => onChange({ op: v as FlowNode["op"] })}
              ariaLabel="Test"
              options={[
                { value: "eq", label: "is" },
                { value: "neq", label: "is not" },
                { value: "contains", label: "contains" },
                { value: "gt", label: "greater than" },
                { value: "lt", label: "less than" },
                { value: "exists", label: "has any value" },
                { value: "has_tag", label: "contact has tag" },
                { value: "not_has_tag", label: "contact lacks tag" },
              ]}
            />
          </div>
          {node.op !== "exists" && (
            <div>
              <label className="label">{isTag ? "Tag" : "Compare with"}</label>
              <input className="input" placeholder={isTag ? "vip" : ""} value={node.right ?? ""} onChange={(e) => onChange({ right: e.target.value })} />
            </div>
          )}
        </>
      );
    }
    case "delay":
      return (
        <div>
          <label className="label">Wait for (seconds)</label>
          <input className="input" type="number" min={0} value={node.seconds ?? 0} onChange={(e) => onChange({ seconds: Number(e.target.value) })} />
          <span className="mono">{describeDelay(node.seconds ?? 0)} · must land inside the 24-hour window</span>
        </div>
      );
    case "collect":
      return <CollectFields node={node} onChange={onChange} />;
    case "action":
      return <ActionFields node={node} onChange={onChange} />;
    case "randomize":
      return <RandomizeFields node={node} onChange={onChange} />;
    case "smart_delay":
      return <SmartDelayFields node={node} onChange={onChange} />;
    case "http_request":
      return <HttpFields node={node} onChange={onChange} />;
    case "go_to_flow":
      return <GoToFlowFields node={node} onChange={onChange} />;
    case "end":
    default:
      return <p className="mono" style={{ margin: 0 }}>Closes the run.</p>;
  }
}

/** Send-message config: text + image + buttons, plus a gallery/carousel, a media attachment,
 *  and additional message bubbles sent after the first. */
function SendMessageFields({ node, onChange }: { node: FlowNode; onChange: (patch: Partial<FlowNode>) => void }) {
  const content = node.content ?? {};
  const buttons = content.buttons ?? [];
  const cards = content.cards ?? [];
  const extras = node.extras ?? [];
  const setContent = (p: Partial<typeof content>) => onChange({ content: { ...content, ...p } });
  const setButtons = (next: MessageButton[]) => setContent({ buttons: next });

  return (
    <>
      <div>
        <label className="label">Message</label>
        <textarea
          className="textarea"
          value={content.text ?? ""}
          placeholder="What the contact reads"
          onChange={(e) => setContent({ text: e.target.value })}
        />
      </div>
      <div>
        <label className="label">Image (optional)</label>
        <ImageField value={content.imageUrl ?? ""} onChange={(imageUrl) => setContent({ imageUrl: imageUrl || undefined })} />
      </div>

      <div className="stack">
        <span className="label" style={{ marginBottom: 0 }}>Buttons</span>
        <span className="mono">
          Up to three, drawn under the message. A link button opens the browser and does not open
          the 24-hour window; leave the link empty for a button that replies.
        </span>
        {buttons.map((button, i) => (
          <Fragment key={i}>
            <div className="button-row">
              <input className="input" placeholder="Button text" value={button.title} onChange={(e) => setButtons(buttons.map((b, j) => (i === j ? { ...b, title: e.target.value } : b)))} />
              <input className="input" placeholder="REPLY_PAYLOAD" value={button.payload} disabled={Boolean(button.url)} onChange={(e) => setButtons(buttons.map((b, j) => (i === j ? { ...b, payload: e.target.value } : b)))} />
              <input className="input" placeholder="Link (optional)" value={button.url ?? ""} onChange={(e) => setButtons(buttons.map((b, j) => (i === j ? { ...b, url: e.target.value || undefined } : b)))} />
              <button className="btn btn-quiet" onClick={() => setButtons(buttons.filter((_, j) => j !== i))}>Remove</button>
            </div>
            <UrlHint url={button.url} />
          </Fragment>
        ))}
        <div>
          <button className="btn btn-quiet" disabled={buttons.length >= 3} onClick={() => setButtons([...buttons, { title: "Yes", payload: "YES" }])}>Add button</button>
        </div>
      </div>

      {/* Media attachment (audio / video / file) */}
      <div className="stack">
        <span className="label" style={{ marginBottom: 0 }}>Attachment</span>
        <div className="grid-2">
          <Select
            value={content.attachment?.type ?? "none"}
            onChange={(v) => setContent({ attachment: v === "none" ? undefined : { type: v as "audio" | "video" | "file", url: content.attachment?.url ?? "" } })}
            ariaLabel="Attachment type"
            options={[
              { value: "none", label: "None" },
              { value: "audio", label: "Audio" },
              { value: "video", label: "Video" },
              { value: "file", label: "File" },
            ]}
          />
          {content.attachment && (
            <input className="input" placeholder="https://… media URL" value={content.attachment.url} onChange={(e) => setContent({ attachment: { type: content.attachment!.type, url: e.target.value } })} />
          )}
        </div>
        <UrlHint url={content.attachment?.url} />
      </div>

      {/* Gallery / carousel */}
      <div className="stack">
        <span className="label" style={{ marginBottom: 0 }}>Gallery (carousel)</span>
        <span className="mono">Swipeable cards, each with an image, text and its own buttons. When set, it replaces the plain text+buttons above.</span>
        {cards.map((card, ci) => {
          const cardBtns = card.buttons ?? [];
          const setCard = (p: Partial<typeof card>) => setContent({ cards: cards.map((c, j) => (ci === j ? { ...c, ...p } : c)) });
          const setCardBtns = (next: MessageButton[]) => setCard({ buttons: next });
          return (
            <div key={ci} className="action-item stack" style={{ gap: 8 }}>
              <div className="cluster" style={{ justifyContent: "space-between" }}>
                <span className="label" style={{ margin: 0 }}>Card {ci + 1}</span>
                <button className="btn btn-quiet" onClick={() => setContent({ cards: cards.filter((_, j) => j !== ci) })}>Remove</button>
              </div>
              <input className="input" placeholder="Title" value={card.title} onChange={(e) => setCard({ title: e.target.value })} />
              <input className="input" placeholder="Subtitle" value={card.subtitle ?? ""} onChange={(e) => setCard({ subtitle: e.target.value })} />
              <ImageField compact value={card.imageUrl ?? ""} onChange={(imageUrl) => setCard({ imageUrl })} />
              {cardBtns.map((b, bi) => (
                <Fragment key={bi}>
                  <div className="button-row">
                    <input className="input" placeholder="Button" value={b.title} onChange={(e) => setCardBtns(cardBtns.map((x, j) => (bi === j ? { ...x, title: e.target.value } : x)))} />
                    <input className="input" placeholder="PAYLOAD" value={b.payload} disabled={Boolean(b.url)} onChange={(e) => setCardBtns(cardBtns.map((x, j) => (bi === j ? { ...x, payload: e.target.value } : x)))} />
                    <input className="input" placeholder="Link" value={b.url ?? ""} onChange={(e) => setCardBtns(cardBtns.map((x, j) => (bi === j ? { ...x, url: e.target.value || undefined } : x)))} />
                    <button className="btn btn-quiet" onClick={() => setCardBtns(cardBtns.filter((_, j) => j !== bi))} aria-label="Remove button">×</button>
                  </div>
                  <UrlHint url={b.url} />
                </Fragment>
              ))}
              <div><button className="btn btn-quiet" disabled={cardBtns.length >= 3} onClick={() => setCardBtns([...cardBtns, { title: "Open", payload: "OPEN" }])}>Add card button</button></div>
            </div>
          );
        })}
        <div>
          <button className="btn btn-quiet" disabled={cards.length >= 10} onClick={() => setContent({ cards: [...cards, { title: "", buttons: [] }] })}>Add card</button>
        </div>
      </div>

      {/* Additional message bubbles */}
      <div className="stack">
        <span className="label" style={{ marginBottom: 0 }}>More bubbles</span>
        <span className="mono">Each is sent as its own message, in order, after the one above.</span>
        {extras.map((ex, i) => (
          <div key={i} className="button-row">
            <textarea className="textarea" style={{ minHeight: 40 }} placeholder={`Bubble ${i + 2}`} value={ex.text ?? ""} onChange={(e) => onChange({ extras: extras.map((x, j) => (i === j ? { ...x, text: e.target.value } : x)) })} />
            <button className="btn btn-quiet" onClick={() => onChange({ extras: extras.filter((_, j) => j !== i) })}>Remove</button>
          </div>
        ))}
        <div>
          <button className="btn btn-quiet" disabled={extras.length >= 4} onClick={() => onChange({ extras: [...extras, { text: "" }] })}>Add bubble</button>
        </div>
      </div>
    </>
  );
}

const INPUT_TYPES: InputType[] = ["email", "phone", "text", "number", "url", "choice"];

/** Collect node config, with a field picker that lists known custom fields or creates a new one. */
function CollectFields({ node, onChange }: { node: FlowNode; onChange: (patch: Partial<FlowNode>) => void }) {
  const [known, setKnown] = useState<{ key: string; type: string }[]>([]);
  useEffect(() => {
    supabase
      .from("custom_field")
      .select("key, type")
      .then(({ data, error }) => {
        if (error) toast.error(error);
        setKnown(data ?? []);
      });
  }, []);

  const quicks = node.quickReplies ?? [];
  const setQuicks = (next: string[]) => onChange({ quickReplies: next });

  return (
    <>
      <div>
        <label className="label">Ask for</label>
        <Select
          value={node.inputType ?? "email"}
          onChange={(v) => onChange({ inputType: v as InputType })}
          ariaLabel="Ask for"
          options={INPUT_TYPES.map((t) => ({ value: t, label: t }))}
        />
      </div>

      <div>
        <label className="label">Question</label>
        <textarea
          className="textarea"
          placeholder="What's your email?"
          value={node.promptText ?? ""}
          onChange={(e) => onChange({ promptText: e.target.value })}
        />
      </div>

      {node.inputType === "choice" && (
        <div className="stack">
          <span className="label" style={{ marginBottom: 0 }}>Options</span>
          <span className="mono">Up to 12 (plus Skip). 20 characters each.</span>
          {quicks.map((q, i) => (
            <div className="button-row" key={i}>
              <input
                className="input"
                value={q}
                maxLength={20}
                onChange={(e) => setQuicks(quicks.map((x, j) => (i === j ? e.target.value : x)))}
              />
              <button className="btn btn-quiet" onClick={() => setQuicks(quicks.filter((_, j) => j !== i))}>
                Remove
              </button>
            </div>
          ))}
          <div>
            <button className="btn btn-quiet" disabled={quicks.length >= 12} onClick={() => setQuicks([...quicks, ""])}>
              Add option
            </button>
          </div>
        </div>
      )}

      <div>
        <label className="label">Save to field</label>
        <input
          className="input"
          list="known-custom-fields"
          placeholder="email"
          value={node.saveTo ?? ""}
          onChange={(e) => onChange({ saveTo: e.target.value.trim() })}
        />
        <datalist id="known-custom-fields">
          {known.map((f) => (
            <option key={f.key} value={f.key} />
          ))}
        </datalist>
        <span className="mono">Pick an existing field, or type a new name to create one.</span>
      </div>

      <div>
        <label className="label">If invalid, say</label>
        <input
          className="input"
          value={node.retryMessage ?? ""}
          onChange={(e) => onChange({ retryMessage: e.target.value })}
        />
      </div>

      <div className="grid-2">
        <div>
          <label className="label">Max tries</label>
          <input
            className="input"
            type="number"
            min={1}
            value={node.maxAttempts ?? 3}
            onChange={(e) => onChange({ maxAttempts: Number(e.target.value) })}
          />
        </div>
        <div>
          <label className="label">Give up after (seconds)</label>
          <input
            className="input"
            type="number"
            min={60}
            value={node.timeoutSeconds ?? 3600}
            onChange={(e) => onChange({ timeoutSeconds: Number(e.target.value) })}
          />
        </div>
      </div>

      <div className="stack">
        <label className="cluster" style={{ gap: 8, cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={node.skipEnabled ?? false}
            onChange={(e) => onChange({ skipEnabled: e.target.checked })}
          />
          <span className="label" style={{ marginBottom: 0 }}>Offer a Skip button</span>
        </label>
        {node.skipEnabled && (
          <input
            className="input"
            maxLength={20}
            placeholder="Skip"
            value={node.skipTitle ?? "Skip"}
            onChange={(e) => onChange({ skipTitle: e.target.value })}
          />
        )}
      </div>
    </>
  );
}

const ACTION_KINDS: { value: ActionKind; label: string }[] = [
  { value: "add_tag", label: "Add a tag" },
  { value: "remove_tag", label: "Remove a tag" },
  { value: "set_field", label: "Set a field" },
  { value: "clear_field", label: "Clear a field" },
  { value: "assign", label: "Assign the conversation" },
  { value: "mark_done", label: "Mark conversation done" },
  { value: "notify", label: "Notify an admin (internal note)" },
  { value: "subscribe_sequence", label: "Subscribe to a sequence" },
  { value: "unsubscribe_sequence", label: "Unsubscribe from a sequence" },
];

/** Action node: an ordered list of things to do (tags, fields, assign, notify) — no message. */
function ActionFields({ node, onChange }: { node: FlowNode; onChange: (patch: Partial<FlowNode>) => void }) {
  const [tags, setTags] = useState<string[]>([]);
  const [fields, setFields] = useState<string[]>([]);
  const [sequences, setSequences] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    // Suggestions only: a failed read leaves the lists empty but the fields still accept typing.
    supabase.from("tag").select("name").then(({ data, error }) => {
      if (error) toast.error(error);
      setTags((data ?? []).map((t) => t.name as string));
    });
    supabase.from("custom_field").select("key").then(({ data, error }) => {
      if (error) toast.error(error);
      setFields((data ?? []).map((f) => f.key as string));
    });
    supabase.from("sequence").select("id, name").then(({ data, error }) => {
      if (error) toast.error(error);
      setSequences(data ?? []);
    });
  }, []);

  const actions = node.actions ?? [];
  const set = (next: FlowAction[]) => onChange({ actions: next });
  const patch = (i: number, p: Partial<FlowAction>) => set(actions.map((a, j) => (i === j ? { ...a, ...p } : a)));

  return (
    <div className="stack" style={{ gap: 12 }}>
      <span className="mono">Runs each action in order, then continues. No message is sent.</span>
      {actions.map((a, i) => (
        <div key={i} className="action-item stack" style={{ gap: 8 }}>
          <div className="cluster" style={{ justifyContent: "space-between" }}>
            <span className="label" style={{ margin: 0 }}>Action {i + 1}</span>
            <button className="btn btn-quiet" onClick={() => set(actions.filter((_, j) => j !== i))}>Remove</button>
          </div>
          <Select
            value={a.kind}
            onChange={(v) => patch(i, { kind: v as ActionKind })}
            ariaLabel="Action type"
            options={ACTION_KINDS}
          />
          {(a.kind === "add_tag" || a.kind === "remove_tag") && (
            <>
              <input className="input" list="known-tags" placeholder="vip" value={a.tag ?? ""} onChange={(e) => patch(i, { tag: e.target.value.trim() })} />
              <datalist id="known-tags">{tags.map((t) => <option key={t} value={t} />)}</datalist>
            </>
          )}
          {a.kind === "set_field" && (
            <>
              <input className="input" list="known-fields" placeholder="field key" value={a.field ?? ""} onChange={(e) => patch(i, { field: e.target.value.trim() })} />
              <datalist id="known-fields">{fields.map((f) => <option key={f} value={f} />)}</datalist>
              <input className="input" placeholder="value (supports {{state.x}})" value={a.value ?? ""} onChange={(e) => patch(i, { value: e.target.value })} />
            </>
          )}
          {a.kind === "clear_field" && (
            <input className="input" list="known-fields" placeholder="field key" value={a.field ?? ""} onChange={(e) => patch(i, { field: e.target.value.trim() })} />
          )}
          {a.kind === "assign" && (
            <input className="input" placeholder="agent@email or name" value={a.assignee ?? ""} onChange={(e) => patch(i, { assignee: e.target.value })} />
          )}
          {a.kind === "notify" && (
            <input className="input" placeholder="Note for the admin" value={a.message ?? ""} onChange={(e) => patch(i, { message: e.target.value })} />
          )}
          {(a.kind === "subscribe_sequence" || a.kind === "unsubscribe_sequence") && (
            <Select
              value={a.sequenceId ?? ""}
              onChange={(v) => patch(i, { sequenceId: v })}
              ariaLabel="Sequence"
              options={[{ value: "", label: "Pick a sequence…" }, ...sequences.map((s) => ({ value: s.id, label: s.name || s.id }))]}
            />
          )}
        </div>
      ))}
      <div>
        <button className="btn btn-quiet" onClick={() => set([...actions, { kind: "add_tag", tag: "" }])}>Add action</button>
      </div>
    </div>
  );
}

/** Randomize node: weighted branches. Weights are relative; the engine normalizes them. */
function RandomizeFields({ node, onChange }: { node: FlowNode; onChange: (patch: Partial<FlowNode>) => void }) {
  const branches = node.branches ?? [{ key: "b0", weight: 50 }, { key: "b1", weight: 50 }];
  const set = (next: typeof branches) => onChange({ branches: next });
  const total = branches.reduce((s, b) => s + (b.weight || 0), 0) || 1;

  return (
    <div className="stack" style={{ gap: 12 }}>
      <span className="mono">Splits traffic down each path by weight. Handles are labelled A, B, C… on the node.</span>
      {branches.map((b, i) => (
        <div key={b.key} className="cluster" style={{ gap: 8 }}>
          <span className="state-chip" style={{ minWidth: 30, justifyContent: "center" }}>{String.fromCharCode(65 + i)}</span>
          <input
            className="input"
            type="number"
            min={0}
            style={{ maxWidth: 90 }}
            value={b.weight}
            onChange={(e) => set(branches.map((x, j) => (i === j ? { ...x, weight: Number(e.target.value) } : x)))}
          />
          <span className="mono">{Math.round(((b.weight || 0) / total) * 100)}%</span>
          {branches.length > 2 && (
            <button className="btn btn-quiet" onClick={() => set(branches.filter((_, j) => j !== i))}>Remove</button>
          )}
        </div>
      ))}
      <div>
        <button
          className="btn btn-quiet"
          disabled={branches.length >= 8}
          onClick={() => set([...branches, { key: `b${branches.length}`, weight: 50 }])}
        >
          Add path
        </button>
      </div>
    </div>
  );
}

/** Smart delay: a plain duration, or wait until a local time of day. */
function SmartDelayFields({ node, onChange }: { node: FlowNode; onChange: (patch: Partial<FlowNode>) => void }) {
  const mode = node.delayMode ?? "duration";
  return (
    <div className="stack" style={{ gap: 12 }}>
      <div>
        <label className="label">Mode</label>
        <Select
          value={mode}
          onChange={(v) => onChange({ delayMode: v as "duration" | "until_time" })}
          ariaLabel="Delay mode"
          options={[
            { value: "duration", label: "Wait a duration" },
            { value: "until_time", label: "Wait until a time of day" },
          ]}
        />
      </div>
      {mode === "duration" ? (
        <div>
          <label className="label">Wait for (seconds)</label>
          <input className="input" type="number" min={0} value={node.seconds ?? 3600} onChange={(e) => onChange({ seconds: Number(e.target.value) })} />
          <span className="mono">{describeDelay(node.seconds ?? 3600)} · must land inside the 24-hour window</span>
        </div>
      ) : (
        <div className="grid-2">
          <div>
            <label className="label">Hour (0–23)</label>
            <input className="input" type="number" min={0} max={23} value={node.untilHour ?? 9} onChange={(e) => onChange({ untilHour: Number(e.target.value) })} />
          </div>
          <div>
            <label className="label">Minute</label>
            <input className="input" type="number" min={0} max={59} value={node.untilMinute ?? 0} onChange={(e) => onChange({ untilMinute: Number(e.target.value) })} />
          </div>
        </div>
      )}
      {mode === "until_time" && (
        <span className="mono">Waits until the next {String(node.untilHour ?? 9).padStart(2, "0")}:{String(node.untilMinute ?? 0).padStart(2, "0")} UTC. If that is past the 24-hour window, the send is blocked.</span>
      )}
    </div>
  );
}

/** HTTP request node: call an external API, save the JSON response, branch on success/error. */
function HttpFields({ node, onChange }: { node: FlowNode; onChange: (patch: Partial<FlowNode>) => void }) {
  const headers = node.headers ?? [];
  const setHeaders = (next: typeof headers) => onChange({ headers: next });
  const hasBody = node.method && node.method !== "GET";
  return (
    <div className="stack" style={{ gap: 12 }}>
      <div className="grid-2">
        <div>
          <label className="label">Method</label>
          <Select
            value={node.method ?? "GET"}
            onChange={(v) => onChange({ method: v as FlowNode["method"] })}
            ariaLabel="Method"
            options={["GET", "POST", "PUT", "PATCH", "DELETE"].map((m) => ({ value: m, label: m }))}
          />
        </div>
        <div>
          <label className="label">Save response to</label>
          <input className="input" placeholder="response" value={node.saveTo ?? ""} onChange={(e) => onChange({ saveTo: e.target.value.trim() })} />
        </div>
      </div>
      <div>
        <label className="label">URL</label>
        <input className="input" placeholder="https://api.example.com/… (https only)" value={node.url ?? ""} onChange={(e) => onChange({ url: e.target.value })} />
        <UrlHint url={node.url} httpsOnly />
      </div>
      <div className="stack">
        <span className="label" style={{ marginBottom: 0 }}>Headers</span>
        {headers.map((h, i) => (
          <div className="button-row" key={i}>
            <input className="input" placeholder="Header" value={h.key} onChange={(e) => setHeaders(headers.map((x, j) => (i === j ? { ...x, key: e.target.value } : x)))} />
            <input className="input" placeholder="Value" value={h.value} onChange={(e) => setHeaders(headers.map((x, j) => (i === j ? { ...x, value: e.target.value } : x)))} />
            <button className="btn btn-quiet" onClick={() => setHeaders(headers.filter((_, j) => j !== i))}>Remove</button>
          </div>
        ))}
        <div><button className="btn btn-quiet" onClick={() => setHeaders([...headers, { key: "", value: "" }])}>Add header</button></div>
      </div>
      {hasBody && (
        <div>
          <label className="label">Body (JSON, supports {"{{state.x}}"})</label>
          <textarea className="textarea" placeholder='{"name": "{{contact.username}}"}' value={node.body ?? ""} onChange={(e) => onChange({ body: e.target.value })} />
        </div>
      )}
      <span className="mono">On success the JSON response is saved to the field above; branch on "On error" if the call fails.</span>
    </div>
  );
}

/** Go to flow: hand the contact off to another flow's start, ending this run. */
function GoToFlowFields({ node, onChange }: { node: FlowNode; onChange: (patch: Partial<FlowNode>) => void }) {
  const [flows, setFlows] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    supabase
      .from("flow")
      .select("id, name")
      .is("deleted_at", null)
      .order("updated_at", { ascending: false })
      .then(({ data, error }) => {
        if (error) toast.error(error);
        setFlows(data ?? []);
      });
  }, []);
  return (
    <div className="stack" style={{ gap: 12 }}>
      <div>
        <label className="label">Go to flow</label>
        <Select
          value={node.targetFlowId ?? ""}
          onChange={(v) => onChange({ targetFlowId: v })}
          ariaLabel="Target flow"
          options={[{ value: "", label: "Pick a flow…" }, ...flows.map((f) => ({ value: f.id, label: f.name || f.id }))]}
        />
      </div>
      <span className="mono">This run ends and a fresh run of the chosen flow starts for the contact, carrying the same saved values.</span>
    </div>
  );
}
