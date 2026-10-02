import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { Loader } from "../components/Loader";
import { friendlyError, toast } from "../components/Toast";
import { FlowPicker } from "../components/FlowPicker";
import { PhonePreview } from "../components/PhonePreview";
import { Crumbs, Toggle } from "../components/PageBits";
import { callOauth, InstagramConnection } from "../components/InstagramConnection";
import { clockTime, relativeTime } from "../lib/time";
import {
  createFlow,
  FLOW_PAYLOAD,
  flowOf,
  loadProfile,
  saveProfile,
  tapCounts,
  type MenuEntry,
  type OptSetting,
  type Profile,
  type Starter,
} from "../lib/profile";
import type { TriggerType } from "../lib/types";

const TRAIL = [
  { label: "Settings", to: "/settings/instagram" },
  { label: "Instagram", to: "/settings/instagram" },
];

/** Flow names by id, for showing which automation a starter or menu item runs. */
function useFlowNames(): Record<string, string> {
  const [names, setNames] = useState<Record<string, string>>({});
  useEffect(() => {
    supabase.from("flow").select("id, name").then(({ data }) => setNames(Object.fromEntries((data ?? []).map((f) => [f.id, f.name]))));
  }, []);
  return names;
}

/** Warn before closing the tab with edits that aren't on Instagram yet. */
function useUnloadGuard(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return;
    const onUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, [dirty]);
}

// ================================================================ Settings › Instagram

interface Handler {
  id: string;
  name: string;
  status: "draft" | "live";
}

/**
 * Settings › Instagram, like ManyChat: the connected account, then one row per account-wide
 * behaviour (default reply, main menu, conversation starters, opt-in / opt-out, story mention
 * reply), each with its own action. Shown inside the Settings layout.
 */
export function InstagramSettings() {
  const navigate = useNavigate();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [handlers, setHandlers] = useState<Partial<Record<TriggerType, Handler[]>>>({});
  const [error, setError] = useState<string | null>(null);
  const [openOpt, setOpenOpt] = useState<"opt_in" | "opt_out" | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const [p, flows] = await Promise.all([
          loadProfile(),
          supabase
            .from("flow")
            .select("id, name, status, trigger_type")
            .in("trigger_type", ["default_reply", "story_mention"])
            .is("deleted_at", null),
        ]);
        setProfile(p);
        const by: Partial<Record<TriggerType, Handler[]>> = {};
        for (const f of flows.data ?? []) (by[f.trigger_type as TriggerType] ??= []).push(f as Handler);
        setHandlers(by);
      } catch (err) {
        setError(friendlyError(err));
      }
    })();
  }, []);

  async function createReply(trigger: TriggerType, name: string) {
    try {
      navigate(`/flows/${await createFlow(name, trigger)}`);
    } catch (err) {
      toast.error(err);
    }
  }

  if (error) return <div className="notice">{error}</div>;
  if (!profile) return <Loader label="Loading settings" />;

  const replyRow = (trigger: TriggerType, title: string, name: string, about: string) => {
    const list = handlers[trigger] ?? [];
    const live = list.filter((h) => h.status === "live");
    return (
      <SettingRow title={title} about={about}>
        {list.length ? (
          <div className="stack" style={{ gap: 6 }}>
            {list.map((h) => (
              <Link key={h.id} className="handler-link" to={`/flows/${h.id}`}>
                <span className={`dot ${h.status === "live" ? "is-on" : ""}`} />
                {h.name}
                <span className="mono">{h.status === "live" ? "Active" : "Inactive"}</span>
              </Link>
            ))}
            {!live.length && <span className="mono field-warn">None is active, so nothing runs yet.</span>}
          </div>
        ) : (
          <button className="btn" onClick={() => createReply(trigger, name)}>Create New Reply</button>
        )}
      </SettingRow>
    );
  };

  return (
    <>
      <InstagramConnection />

      <div className="mc-card settings-list">
        {replyRow(
          "default_reply",
          "Default Reply",
          "Default Reply",
          "Runs when someone sends a message no keyword matched. Use it to greet new contacts and point them to what you can help with.",
        )}
        <SettingRow
          title="Main Menu"
          about="The menu people can open from the DM thread at any time. Each item runs an automation or opens a link."
          status={profile.persistent_menu.length ? `${profile.menu_enabled ? "On" : "Off"} · ${profile.persistent_menu.length} item${profile.persistent_menu.length === 1 ? "" : "s"}` : "Not set up"}
        >
          <Link className="btn btn-wide" to="/settings/menu">Edit</Link>
        </SettingRow>
        <SettingRow
          title="Conversation Starters"
          about="Up to 4 questions shown when someone opens a new chat with you. Each one runs an automation when tapped."
          status={profile.ice_breakers.length ? `${profile.ice_enabled ? "On" : "Off"} · ${profile.ice_breakers.length} question${profile.ice_breakers.length === 1 ? "" : "s"}` : "Not set up"}
        >
          <Link className="btn btn-wide" to="/settings/starters">Edit</Link>
        </SettingRow>
        <OptRow
          kind="opt_in"
          title="Opt-in Automation"
          about="Runs when someone types one of these words. It takes them back into your broadcasts and sequences."
          value={profile.opt_in}
          other={profile.opt_out}
          open={openOpt === "opt_in"}
          onOpen={(o) => setOpenOpt(o ? "opt_in" : null)}
          onSaved={(v) => setProfile({ ...profile, opt_in: v })}
        />
        <OptRow
          kind="opt_out"
          title="Opt-out Automation"
          about="Runs when someone types one of these words. They stop getting broadcasts and sequence messages; replies to their own messages still work."
          value={profile.opt_out}
          other={profile.opt_in}
          open={openOpt === "opt_out"}
          onOpen={(o) => setOpenOpt(o ? "opt_out" : null)}
          onSaved={(v) => setProfile({ ...profile, opt_out: v })}
        />
        {replyRow(
          "story_mention",
          "Story Mention Reply",
          "Story Mention Reply",
          "Runs when someone mentions your account in their story, so you can thank them or send something back.",
        )}
      </div>

      <SendingSafety />
    </>
  );
}

interface Limit {
  minute: number;
  hour: number;
}

interface Health {
  paused_until: string | null;
  pause_reason: string | null;
  public_paused_until: string | null;
  public_pause_reason: string | null;
  last_event_at: string | null;
  sent_last_hour: number;
  limits: {
    reactive: Limit;
    private_reply: Limit;
    public_reply: Limit;
    proactive: Limit;
    per_contact_hour: number;
    viral_comments_hour: number;
    viral_pause_hours: number;
  };
}

/**
 * The limits that keep the account clear of Meta's spam checks (send_guard, migration 24), and
 * whether anything is holding sends back right now. Read-only: the limits are set server-side.
 */
function SendingSafety() {
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    supabase.rpc("sending_health").then(({ data, error }) => {
      if (error) setError(friendlyError(error));
      else setHealth(data as Health);
    });
  }, []);

  async function resubscribe() {
    setBusy(true);
    try {
      await callOauth("resubscribe");
      toast.success("Instagram events resubscribed");
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  }

  if (error) return <div className="notice">Could not load sending safety: {error}</div>;
  if (!health) return null;
  const l = health.limits;

  return (
    <div className="mc-card settings-list">
      <SettingRow
        title="Sending"
        status={health.paused_until ? `Paused until ${clockTime(health.paused_until)}` : `Normal · ${health.sent_last_hour} sent in the last hour`}
        about={
          health.paused_until
            ? `${health.pause_reason ?? "Meta pushed back"}. Every automated send waits until then and goes out after; nothing is lost unless its time runs out first.`
            : "If Meta ever answers with a rate limit or a block, every automated send stops on its own instead of retrying into it."
        }
      >
        <span className={`dot ${health.paused_until ? "" : "is-on"}`} />
      </SettingRow>
      <SettingRow
        title="Replies under comments"
        status={health.public_paused_until ? `Off until ${clockTime(health.public_paused_until)}` : "On"}
        about={
          health.public_paused_until
            ? `${health.public_pause_reason ?? "Too many comments at once"}, so public replies are off while the post is busy. The DMs to commenters still go out.`
            : `Turns itself off for ${l.viral_pause_hours} hours when more than ${l.viral_comments_hour} comments start automations within an hour, the moment a post goes viral.`
        }
      >
        <span className={`dot ${health.public_paused_until ? "" : "is-on"}`} />
      </SettingRow>
      <SettingRow
        title="Speed limits"
        about={
          `DMs to commenters: ${l.private_reply.minute} a minute. ` +
          `Replies under comments: ${l.public_reply.minute} a minute, ${l.public_reply.hour} an hour. ` +
          `Broadcasts and sequences: ${l.proactive.hour} an hour. ` +
          `Any one contact: ${l.per_contact_hour} messages an hour. ` +
          "The DM to a commenter waits 10–45 seconds and the reply under the comment 30–120 seconds, as a person would. " +
          "Anything over a limit waits for the next minute rather than going out in a burst."
        }
      >
        <span className="mono">Set by the server</span>
      </SettingRow>
      <SettingRow
        title="Events from Instagram"
        status={`Last received ${relativeTime(health.last_event_at)}`}
        about="Instagram stops sending messages and comments here if it can't reach the server for an hour. If people are messaging you and this stays old, resubscribe."
      >
        <button className={`btn ${busy ? "is-busy" : ""}`} onClick={resubscribe} disabled={busy}>Resubscribe</button>
      </SettingRow>
    </div>
  );
}

function SettingRow({ title, about, status, children }: { title: string; about: string; status?: string; children: ReactNode }) {
  return (
    <div className="setting-row">
      <div className="setting-name">
        <strong>{title}</strong>
        {status && <span className="mono">{status}</span>}
      </div>
      <div className="setting-action">{children}</div>
      <p className="setting-about">{about}</p>
    </div>
  );
}

function OptRow({
  kind,
  title,
  about,
  value,
  other,
  open,
  onOpen,
  onSaved,
}: {
  kind: "opt_in" | "opt_out";
  title: string;
  about: string;
  value: OptSetting;
  other: OptSetting;
  open: boolean;
  onOpen: (open: boolean) => void;
  onSaved: (v: OptSetting) => void;
}) {
  const [draft, setDraft] = useState(value);
  const [words, setWords] = useState(value.keywords.join(", "));
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    setDraft(value);
    setWords(value.keywords.join(", "));
  }, [value, open]);

  async function save() {
    const keywords = words.split(",").map((w) => w.trim().toLowerCase()).filter(Boolean);
    if (!keywords.length) return toast.error("Add at least one word.");
    const next = { ...draft, keywords };
    setSaving(true);
    try {
      await saveProfile({ section: "opt", [kind]: next, [kind === "opt_in" ? "opt_out" : "opt_in"]: other });
      onSaved(next);
      onOpen(false);
      toast.success(`${title} saved`);
    } catch (err) {
      toast.error(err);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={`setting-row ${open ? "is-open" : ""}`}>
      <div className="setting-name">
        <strong>{title}</strong>
        <span className="mono">{value.enabled ? `On · "${value.keywords.join('", "')}"` : "Off"}</span>
      </div>
      <div className="setting-action">
        <button className="btn btn-wide" onClick={() => onOpen(!open)}>{open ? "Close" : "Edit"}</button>
      </div>
      <p className="setting-about">{about}</p>
      {open && (
        <div className="setting-edit">
          <div className="cluster" style={{ gap: 10 }}>
            <Toggle on={draft.enabled} onChange={(enabled) => setDraft({ ...draft, enabled })} label={`${title} on`} />
            <span>{draft.enabled ? "Enabled" : "Disabled"}</span>
          </div>
          <label className="label">Words that trigger it (comma separated, whole message only)</label>
          <input className="input" value={words} onChange={(e) => setWords(e.target.value)} />
          <label className="label">Reply</label>
          <textarea className="textarea" maxLength={1000} value={draft.reply} onChange={(e) => setDraft({ ...draft, reply: e.target.value })} />
          <div className="row-between">
            <span className="mono">Leave the reply empty to change the setting silently.</span>
            <button className={`btn btn-primary ${saving ? "is-busy" : ""}`} disabled={saving} onClick={save}>Save</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ================================================================ shared reply picker

/** "Reply message: + Create New Message / Select Existing", ManyChat's pop-over. */
function ReplyPop({
  label,
  onCreate,
  onSelect,
  onDelete,
  onClose,
}: {
  label: string;
  onCreate: () => void;
  onSelect: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  return (
    <div className="pop-card reply-pop" onClick={(e) => e.stopPropagation()}>
      <span className="mono">{label}</span>
      <strong>Reply message</strong>
      <div className="reply-pop-opts">
        <button className="link-btn" onClick={onCreate}>+ Create New Message</button>
        <button className="link-btn" onClick={onSelect}>Select Existing</button>
      </div>
      <div className="row-between">
        <button className="btn" onClick={onDelete}>Delete</button>
        <button className="btn btn-primary" onClick={onClose}>Done</button>
      </div>
    </div>
  );
}

/** Create a fresh automation for a starter/menu item and open it in a new tab, so edits here stay. */
async function newReplyFlow(name: string): Promise<string | null> {
  try {
    const id = await createFlow(name || "Reply");
    window.open(`/flows/${id}`, "_blank", "noopener");
    toast.success("Automation created. Build it in the new tab, then publish here.");
    return id;
  } catch (err) {
    toast.error(err);
    return null;
  }
}

// ================================================================ Conversation Starters

export function ConversationStarters() {
  const flows = useFlowNames();
  const [items, setItems] = useState<Starter[] | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [saved, setSaved] = useState("");
  const [clicks, setClicks] = useState<Record<string, number>>({});
  const [popFor, setPopFor] = useState<number | null>(null);
  const [pickFor, setPickFor] = useState<number | null>(null);
  const [publishing, setPublishing] = useState(false);

  useEffect(() => {
    loadProfile().then(
      (p) => {
        setItems(p.ice_breakers);
        setEnabled(p.ice_enabled);
        setSaved(JSON.stringify({ i: p.ice_breakers, e: p.ice_enabled }));
        tapCounts(p.ice_breakers.map((s) => s.payload)).then(setClicks);
      },
      (err) => toast.error(err),
    );
  }, []);

  const snapshot = JSON.stringify({ i: items, e: enabled });
  const dirty = items !== null && snapshot !== saved;
  useUnloadGuard(dirty);

  if (!items) return <Loader label="Loading conversation starters" />;
  const set = (i: number, patch: Partial<Starter>) => setItems(items.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  async function publish() {
    if (!items) return;
    for (const [i, s] of items.entries()) {
      if (!s.question.trim()) return toast.error(`Question ${i + 1} is empty.`);
      if (!s.payload) return toast.error(`"${s.question}" has no reply yet. Pick one with the chat icon.`);
    }
    setPublishing(true);
    try {
      await saveProfile({ section: "starters", enabled, ice_breakers: items });
      setSaved(snapshot);
      toast.success(enabled ? "Conversation starters published" : "Conversation starters turned off");
    } catch (err) {
      toast.error(err);
    } finally {
      setPublishing(false);
    }
  }

  return (
    <div className="stack" style={{ gap: 16 }}>
      <Crumbs
        trail={TRAIL}
        name="Conversation Starters"
        actions={
          <>
            <span className="switch-label">
              Disabled <Toggle on={enabled} onChange={setEnabled} label="Conversation starters enabled" /> Enabled
            </span>
            <button className={`btn btn-primary ${publishing ? "is-busy" : ""}`} disabled={!dirty || publishing} onClick={publish}>
              Publish
            </button>
          </>
        }
      />
      <div className="settings-split">
        <div className="stack" style={{ gap: 10 }}>
          <div className="q-head">
            <span>Questions</span>
            <span>Clicks</span>
          </div>
          {items.map((s, i) => {
            const flowId = flowOf(s.payload);
            return (
              <div key={i} className="q-row pop-anchor">
                <div className="q-field">
                  <input
                    className="q-input"
                    placeholder="Type your question here"
                    maxLength={80}
                    value={s.question}
                    onChange={(e) => set(i, { question: e.target.value })}
                  />
                  <span className="q-count">{80 - s.question.length}</span>
                </div>
                <span className="q-clicks">{clicks[s.payload] ?? 0}</span>
                <button
                  className={`q-reply ${flowId ? "is-set" : ""}`}
                  onClick={() => setPopFor(popFor === i ? null : i)}
                  title={flowId ? `Runs: ${flows[flowId] ?? "deleted automation"}` : "Choose the reply"}
                  aria-label="Reply"
                >
                  <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                    <path d="M10 3c4 0 7 2.7 7 6s-3 6-7 6c-.9 0-1.7-.1-2.5-.4L4 16l.9-3A5.6 5.6 0 0 1 3 9c0-3.3 3-6 7-6Z" stroke="currentColor" strokeWidth="1.5" />
                    <path d="M7 9h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                  </svg>
                </button>
                {flowId && <span className="q-runs mono">Runs “{flows[flowId] ?? "deleted automation"}”</span>}
                {popFor === i && (
                  <ReplyPop
                    label={s.question || `Question ${i + 1}`}
                    onCreate={async () => {
                      const id = await newReplyFlow(s.question);
                      if (id) set(i, { payload: FLOW_PAYLOAD + id });
                      setPopFor(null);
                    }}
                    onSelect={() => {
                      setPickFor(i);
                      setPopFor(null);
                    }}
                    onDelete={() => {
                      setItems(items.filter((_, j) => j !== i));
                      setPopFor(null);
                    }}
                    onClose={() => setPopFor(null)}
                  />
                )}
              </div>
            );
          })}
          {items.length < 4 && (
            <button className="q-add" onClick={() => setItems([...items, { question: "", payload: "" }])}>+ Add Question</button>
          )}
          <p className="setting-about" style={{ margin: 0 }}>
            Write a question and choose the automation that answers it. The list is limited to 4 items, and people see it
            when they open a new chat with you on the Instagram app.
          </p>
        </div>
        <PhonePreview starters={enabled ? items.map((s) => s.question) : []} />
      </div>
      {pickFor !== null && (
        <FlowPicker
          title="Reply with an automation"
          onClose={() => setPickFor(null)}
          onPick={(f) => {
            set(pickFor, { payload: FLOW_PAYLOAD + f.id });
            setPickFor(null);
          }}
        />
      )}
    </div>
  );
}

// ================================================================ Main Menu

const MAX_MENU = 20;

export function MainMenu() {
  const flows = useFlowNames();
  const [items, setItems] = useState<MenuEntry[] | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [saved, setSaved] = useState("");
  const [popFor, setPopFor] = useState<number | null>(null);
  const [pickFor, setPickFor] = useState<number | null>(null);
  const [publishing, setPublishing] = useState(false);

  useEffect(() => {
    loadProfile().then(
      (p) => {
        setItems(p.persistent_menu);
        setEnabled(p.menu_enabled);
        setSaved(JSON.stringify({ i: p.persistent_menu, e: p.menu_enabled }));
      },
      (err) => toast.error(err),
    );
  }, []);

  const snapshot = JSON.stringify({ i: items, e: enabled });
  const dirty = items !== null && snapshot !== saved;
  useUnloadGuard(dirty);
  const titles = useMemo(() => (items ?? []).map((m) => m.title), [items]);

  if (!items) return <Loader label="Loading menu" />;
  const set = (i: number, patch: Partial<MenuEntry>) => setItems(items.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  async function publish() {
    if (!items) return;
    for (const [i, m] of items.entries()) {
      if (!m.title.trim()) return toast.error(`Menu item ${i + 1} needs a title.`);
      if (m.type === "postback" && !m.payload) return toast.error(`"${m.title}" has no reply yet.`);
      if (m.type === "web_url" && !/^https:\/\/\S+$/i.test(m.url ?? "")) return toast.error(`"${m.title}" needs a link starting with https://.`);
    }
    setPublishing(true);
    try {
      await saveProfile({ section: "menu", enabled, persistent_menu: items });
      setSaved(snapshot);
      toast.success(enabled ? "Menu updated on Instagram" : "Menu turned off");
    } catch (err) {
      toast.error(err);
    } finally {
      setPublishing(false);
    }
  }

  return (
    <div className="stack" style={{ gap: 16 }}>
      <Crumbs
        trail={TRAIL}
        name="Main Menu"
        actions={
          <>
            <span className="switch-label">
              Disabled <Toggle on={enabled} onChange={setEnabled} label="Main menu enabled" /> Enabled
            </span>
            <span className="save-state">{dirty ? "Unsaved changes" : "✓ Saved"}</span>
            <button className={`btn btn-primary ${publishing ? "is-busy" : ""}`} disabled={!dirty || publishing} onClick={publish}>
              Update Menu
            </button>
          </>
        }
      />
      <div className="settings-split">
        <div className="stack" style={{ gap: 10 }}>
          {items.map((m, i) => {
            const flowId = flowOf(m.payload);
            return (
              <div key={i} className="menu-line pop-anchor">
                <div className="q-field">
                  <input className="q-input" placeholder="Menu item title" maxLength={30} value={m.title} onChange={(e) => set(i, { title: e.target.value })} />
                  <span className="q-count">{30 - m.title.length}</span>
                </div>
                <div className="seg menu-type">
                  <button className={`seg-btn ${m.type === "postback" ? "on" : ""}`} onClick={() => set(i, { type: "postback", url: undefined })}>Reply</button>
                  <button className={`seg-btn ${m.type === "web_url" ? "on" : ""}`} onClick={() => set(i, { type: "web_url", payload: undefined })}>Link</button>
                </div>
                {m.type === "web_url" ? (
                  <input className="input menu-url" placeholder="https://…" value={m.url ?? ""} onChange={(e) => set(i, { url: e.target.value })} />
                ) : (
                  <button className={`btn menu-reply ${flowId ? "" : "is-missing"}`} onClick={() => setPopFor(popFor === i ? null : i)}>
                    {flowId ? flows[flowId] ?? "Deleted automation" : "Choose reply"}
                  </button>
                )}
                <button className="icon-btn" onClick={() => setItems(items.filter((_, j) => j !== i))} aria-label={`Remove ${m.title || "item"}`}>×</button>
                {popFor === i && (
                  <ReplyPop
                    label={m.title || `Menu item ${i + 1}`}
                    onCreate={async () => {
                      const id = await newReplyFlow(m.title);
                      if (id) set(i, { payload: FLOW_PAYLOAD + id });
                      setPopFor(null);
                    }}
                    onSelect={() => {
                      setPickFor(i);
                      setPopFor(null);
                    }}
                    onDelete={() => {
                      setItems(items.filter((_, j) => j !== i));
                      setPopFor(null);
                    }}
                    onClose={() => setPopFor(null)}
                  />
                )}
              </div>
            );
          })}
          {items.length < MAX_MENU && (
            <button className="q-add" onClick={() => setItems([...items, { title: "", type: "postback", payload: "" }])}>+ Menu Item</button>
          )}
          <p className="setting-about" style={{ margin: 0 }}>
            Up to {MAX_MENU} items, one level deep. A reply item runs an automation; a link item opens a web page.
          </p>
        </div>
        <PhonePreview menu={enabled ? titles : []} />
      </div>
      {pickFor !== null && (
        <FlowPicker
          title="Reply with an automation"
          onClose={() => setPickFor(null)}
          onPick={(f) => {
            set(pickFor, { payload: FLOW_PAYLOAD + f.id });
            setPickFor(null);
          }}
        />
      )}
    </div>
  );
}
