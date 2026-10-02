import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject, type UIEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { useSession } from "../lib/auth";
import { IMAGE_TYPES, uploadImage } from "../lib/content";
import { clockTime } from "../lib/time";
import { Loader } from "../components/Loader";
import { Select } from "../components/Select";
import { friendlyError, toast } from "../components/Toast";
import { promptDialog } from "../components/Confirm";
import { FlowPicker } from "../components/FlowPicker";
import { ContactProfile } from "../components/ContactProfile";
import { ContactAvatar, HUMAN_MS, WINDOW_MS, isForever, nameOf, pausedUntil, timeLeft, windowState } from "../components/ContactBits";
import { IgLogo } from "../editor/nodes/icons";
import type { Contact, Flow, Message, MessageButton, MessageCard } from "../lib/types";

interface Note {
  id: string;
  body: string;
  author: string | null;
  created_at: string;
}

type Preview = { text: string; out: boolean; at: string };
/** Which conversations the list shows: everyone's, nobody's, mine, or one teammate's. */
type Folder = "all" | "unassigned" | "mine" | `agent:${string}`;
type Entry = { kind: "msg"; at: string; m: Message } | { kind: "note"; at: string; n: Note };

const EMOJIS = ["👍","🙏","🔥","❤️","😊","😍","🎉","✅","👏","💯","🙌","😅","🤝","👀","💪","✨","🚀","😂","🥳","📩","🛒","💬","⭐","🎁"];

/** Close a popover on a click outside it or on Escape. */
function useDismiss(ref: RefObject<HTMLElement | null>, open: boolean, onClose: () => void) {
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [ref, open, onClose]);
}

/** POST to the inbox-send edge function. Throws a readable Error on any failure. */
async function callInbox(body: Record<string, unknown>): Promise<void> {
  const { data } = await supabase.auth.getSession();
  const bearer = data.session?.access_token ?? (import.meta.env.VITE_SUPABASE_ANON_KEY as string);
  let res: Response;
  try {
    res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/inbox-send`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${bearer}` },
      body: JSON.stringify(body),
      // A raw fetch never gives up on its own; without a deadline the Send button spins forever.
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "TimeoutError") throw new Error("The server took too long to answer. Try again.");
    throw new Error("Can't reach the server. The inbox-send function may not be deployed yet.");
  }
  const out = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(out.error ?? `Could not send (HTTP ${res.status}).`);
}

/**
 * Live Chat, laid out like ManyChat: inbox folders (all, unassigned, mine, each teammate), the
 * conversation list, the chat with Reply / Note tabs, and the contact's profile on the right.
 */
export function Conversations() {
  const { session } = useSession();
  const me = session?.user.email ?? null;

  const [contacts, setContacts] = useState<Contact[]>([]);
  const [previews, setPreviews] = useState<Record<string, Preview>>({});
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [folder, setFolder] = useState<Folder>("all");
  const [statusFilter, setStatusFilter] = useState<"open" | "done" | "all">("open");
  const [sort, setSort] = useState<"newest" | "oldest">("newest");
  const [query, setQuery] = useState("");

  const [messages, setMessages] = useState<Message[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  // Which automation sent each engine message (flow_run id -> flow id), filled as threads load.
  const [runFlow, setRunFlow] = useState<Record<string, string>>({});
  // Which contact the thread on screen belongs to, and whether its last load failed. Until it
  // matches the open contact, the pane says "Loading" instead of showing someone else's thread.
  const [threadOf, setThreadOf] = useState<{ id: string; failed: boolean } | null>(null);

  const [agents, setAgents] = useState<string[]>([]);
  const [savedReplies, setSavedReplies] = useState<{ id: string; title: string; body: string }[]>([]);
  const [flowNames, setFlowNames] = useState<Record<string, string>>({});

  const [mode, setMode] = useState<"reply" | "note">("reply");
  const [text, setText] = useState("");
  const [showReplies, setShowReplies] = useState(false);
  const [showEmoji, setShowEmoji] = useState(false);
  const [pickFlow, setPickFlow] = useState(false);
  // Narrow screens: the profile slides over the chat instead of sitting beside it.
  const [showProfile, setShowProfile] = useState(false);
  // Phones show one pane at a time: the list, or the open conversation.
  const [mobileChat, setMobileChat] = useState(false);

  // Keys of async actions in flight ("send", "status", "image", "flow", "note", "reply", "pause",
  // "sub"). The ref answers synchronously, so a fast double click cannot submit twice.
  const [busy, setBusy] = useState<Set<string>>(() => new Set());
  const busyRef = useRef(new Set<string>());

  const repliesRef = useRef<HTMLDivElement>(null);
  const emojiRef = useRef<HTMLDivElement>(null);
  useDismiss(repliesRef, showReplies, useCallback(() => setShowReplies(false), []));
  useDismiss(emojiRef, showEmoji, useCallback(() => setShowEmoji(false), []));

  const current = useMemo(() => contacts.find((c) => c.id === currentId) ?? null, [contacts, currentId]);
  const currentRef = useRef<string | null>(null);
  currentRef.current = currentId;

  // Unsent drafts per contact, so switching conversations never carries a reply to the wrong person.
  const drafts = useRef<Record<string, string>>({});
  const textRef = useRef(text);
  textRef.current = text;
  const lastOpen = useRef<string | null>(null);

  /** Run one async action under a busy key; ignores re-entry and toasts anything it throws. */
  async function run(key: string, fn: () => Promise<void>) {
    if (busyRef.current.has(key)) return;
    busyRef.current.add(key);
    setBusy(new Set(busyRef.current));
    try {
      await fn();
    } catch (err) {
      toast.error(err);
    } finally {
      busyRef.current.delete(key);
      setBusy(new Set(busyRef.current));
    }
  }

  // ---- scrolling ------------------------------------------------------------------------------
  // Keep the thread pinned to the newest message: jump to the bottom on open and on new messages,
  // but leave the scroll alone if the agent has scrolled up to read history.
  const threadRef = useRef<HTMLDivElement>(null);
  const prevCount = useRef(0);
  const prevContact = useRef<string | null>(null);
  const atBottom = useRef(true);
  const [showJump, setShowJump] = useState(false);

  function scrollToLatest(smooth = false) {
    const el = threadRef.current;
    if (!el) return;
    // Effects run after the DOM is committed, so the height is already there; a background tab
    // may never run animation frames.
    if (smooth) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    else el.scrollTop = el.scrollHeight;
    atBottom.current = true;
    setShowJump(false);
  }

  // Pictures load after the jump to the bottom and push the thread up; follow them down.
  const onMedia = useCallback(() => {
    if (atBottom.current) scrollToLatest();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function onThreadScroll(e: UIEvent<HTMLDivElement>) {
    const el = e.currentTarget;
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 140;
    if (atBottom.current) setShowJump(false);
  }

  const entryCount = messages.length + notes.length;
  useEffect(() => {
    const switched = prevContact.current !== currentId;
    prevContact.current = currentId;
    const firstLoad = prevCount.current === 0;
    const grew = entryCount > prevCount.current;
    prevCount.current = entryCount;
    if (switched) {
      atBottom.current = true;
      scrollToLatest();
    } else if (grew) {
      if (firstLoad) scrollToLatest();
      else if (atBottom.current) scrollToLatest(true);
      else setShowJump(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entryCount, currentId]);

  // A thread that loaded while its pane was hidden had no height to scroll; jump on reveal.
  useEffect(() => {
    if (mobileChat) scrollToLatest();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mobileChat]);

  // ---- loading --------------------------------------------------------------------------------

  async function loadContacts() {
    try {
      const { data, error } = await supabase
        .from("contact")
        .select("*")
        .order("last_interaction_at", { ascending: false, nullsFirst: false })
        .limit(200);
      if (error) throw error;
      const rows = (data ?? []) as Contact[];
      setContacts(rows);
      setError(null);

      // One query for last-message previews across the list, reduced to newest-per-contact.
      // Previews are decoration: on a failed read keep the ones already shown.
      if (rows.length) {
        const { data: msgs, error: previewError } = await supabase
          .from("message")
          .select("contact_id, payload, direction, created_at")
          .in("contact_id", rows.map((r) => r.id))
          .order("created_at", { ascending: false })
          .limit(600);
        if (!previewError) {
          const map: Record<string, Preview> = {};
          for (const m of (msgs ?? []) as { contact_id: string; payload: Message["payload"]; direction: string; created_at: string }[]) {
            if (!map[m.contact_id]) map[m.contact_id] = { text: previewText(m.payload), out: m.direction === "out", at: m.created_at };
          }
          setPreviews(map);
        }
      }
    } catch (err) {
      setError(`Could not load conversations: ${friendlyError(err)}`);
    } finally {
      setLoading(false);
    }
  }

  /** Load one contact's messages and notes. `quiet` is for the poll. */
  async function loadThread(contactId: string, quiet = false) {
    try {
      const [thread, note] = await Promise.all([
        supabase.from("message").select("*").eq("contact_id", contactId).order("created_at", { ascending: true }).limit(300),
        supabase.from("contact_note").select("*").eq("contact_id", contactId).order("created_at", { ascending: true }),
      ]);
      if (currentRef.current !== contactId) return; // switched away mid-fetch
      const failed = thread.error ?? note.error;
      if (failed && !quiet) toast.error(failed);
      // A failed read keeps what is on screen rather than blanking the thread.
      if (!note.error) setNotes((note.data ?? []) as Note[]);
      if (thread.error) {
        setThreadOf((t) => (t?.id === contactId && !t.failed ? t : { id: contactId, failed: true }));
        return;
      }
      const rows = (thread.data ?? []) as Message[];
      setMessages(rows);
      setThreadOf({ id: contactId, failed: false });

      // Label automation messages with the automation that sent them.
      const missing = [...new Set(rows.map((m) => m.flow_run_id).filter((id): id is string => Boolean(id)))].filter(
        (id) => !runFlowRef.current[id],
      );
      if (missing.length) {
        const { data } = await supabase.from("flow_run").select("id, flow_id").in("id", missing.slice(0, 200));
        if (data?.length) setRunFlow((m) => ({ ...m, ...Object.fromEntries(data.map((r) => [r.id, r.flow_id])) }));
      }
    } catch (err) {
      if (!quiet) toast.error(err);
    }
  }
  const runFlowRef = useRef(runFlow);
  runFlowRef.current = runFlow;

  useEffect(() => {
    loadContacts();
    const quiet = <T,>(p: PromiseLike<{ data: T | null; error: unknown }>, set: (d: T) => void) =>
      p.then(({ data, error }) => (error ? toast.error(error) : data && set(data)));
    quiet(supabase.from("agent").select("name").order("name"), (d) => setAgents(d.map((a) => a.name as string)));
    quiet(supabase.from("saved_reply").select("id, title, body").order("title"), setSavedReplies);
    quiet(supabase.from("flow").select("id, name"), (d) => setFlowNames(Object.fromEntries(d.map((f) => [f.id, f.name]))));
  }, []);

  // "Open in Live Chat" from Contacts lands here with ?contact=<id>. A contact outside the newest
  // 200 conversations is fetched on its own and put at the top.
  const [params, setParams] = useSearchParams();
  const wanted = params.get("contact");
  useEffect(() => {
    if (!wanted || loading) return;
    setParams({}, { replace: true });
    setCurrentId(wanted);
    setMobileChat(true);
    setStatusFilter("all");
    setFolder("all");
    if (contacts.some((c) => c.id === wanted)) return;
    supabase.from("contact").select("*").eq("id", wanted).maybeSingle().then(({ data }) => {
      if (data) setContacts((list) => (list.some((c) => c.id === data.id) ? list : [data as Contact, ...list]));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wanted, loading]);

  // When a conversation is opened: swap drafts, reset per-thread UI, load it.
  useEffect(() => {
    if (!currentId) return;
    if (lastOpen.current) drafts.current[lastOpen.current] = textRef.current;
    lastOpen.current = currentId;
    setText(drafts.current[currentId] ?? "");
    setShowReplies(false);
    setShowEmoji(false);
    setMessages([]);
    setNotes([]);
    loadThread(currentId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentId]);

  // The open conversation is read: clear its unread mark, now and whenever a new message lands
  // while it's on screen.
  const unreadOpen = Boolean(current?.unread);
  useEffect(() => {
    if (!currentId || !unreadOpen || document.visibilityState !== "visible") return;
    if (window.matchMedia("(max-width: 860px)").matches && !mobileChat) return;
    const id = currentId;
    setContacts((list) => list.map((c) => (c.id === id ? { ...c, unread: false } : c)));
    supabase.from("contact").update({ unread: false }).eq("id", id).then(({ error }) => {
      if (error) toast.error(error);
    });
  }, [currentId, unreadOpen, mobileChat]);

  // Poll for new messages every few seconds (no Realtime; Meta logic stays server-side).
  // Skip a tick while the previous one is still in flight so slow networks do not pile up.
  const polling = useRef(false);
  useEffect(() => {
    const t = setInterval(async () => {
      if (polling.current) return;
      polling.current = true;
      try {
        await Promise.all([loadContacts(), currentRef.current ? loadThread(currentRef.current, true) : null]);
      } finally {
        polling.current = false;
      }
    }, 4000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- the list -------------------------------------------------------------------------------

  // Everyone who can be assigned: the roster, plus anyone a conversation is already assigned to.
  const team = useMemo(
    () => [...new Set([...agents, ...contacts.map((c) => c.assigned_to).filter((a): a is string => Boolean(a))])].sort(),
    [agents, contacts],
  );
  const openOnes = useMemo(() => contacts.filter((c) => (c.status ?? "open") !== "done"), [contacts]);
  const countIn = (f: Folder) => openOnes.filter((c) => inFolder(c, f, me)).length;

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rows = contacts.filter((c) => {
      if (!inFolder(c, folder, me)) return false;
      if (statusFilter !== "all" && (c.status === "done" ? "done" : "open") !== statusFilter) return false;
      if (!q) return true;
      return `${c.name ?? ""} ${c.username ?? ""} ${c.igsid} ${(c.tags ?? []).join(" ")}`.toLowerCase().includes(q);
    });
    const at = (c: Contact) => previews[c.id]?.at ?? c.last_interaction_at ?? c.created_at;
    rows.sort((a, b) => (sort === "newest" ? at(b).localeCompare(at(a)) : at(a).localeCompare(at(b))));
    return rows;
  }, [contacts, folder, statusFilter, query, sort, previews, me]);

  // Desktop opens the top conversation straight away, like ManyChat. Phones start on the list.
  useEffect(() => {
    if (currentId || !shown.length || window.matchMedia("(max-width: 860px)").matches) return;
    setCurrentId(shown[0].id);
  }, [shown, currentId]);

  const folderOptions = [
    { value: "all", label: `All (${countIn("all")})` },
    { value: "unassigned", label: `Unassigned (${countIn("unassigned")})` },
    ...(me ? [{ value: "mine", label: `Mine (${countIn("mine")})` }] : []),
    ...team.map((a) => ({ value: `agent:${a}`, label: `${a} (${countIn(`agent:${a}`)})` })),
  ];

  // ---- actions --------------------------------------------------------------------------------

  /**
   * Apply a change to the open contact at once, then persist it. If the server refuses, put the
   * old values back and say why. Resolves true when it saved.
   */
  async function mutateContact(patch: Partial<Contact>, persist: () => PromiseLike<{ error: unknown }>, success?: string): Promise<boolean> {
    if (!current) return false;
    const id = current.id;
    const before = Object.fromEntries(Object.keys(patch).map((k) => [k, current[k as keyof Contact]])) as Partial<Contact>;
    const apply = (p: Partial<Contact>) => setContacts((list) => list.map((c) => (c.id === id ? { ...c, ...p } : c)));
    apply(patch);
    let error: unknown = null;
    try {
      ({ error } = await persist());
    } catch (err) {
      error = err;
    }
    if (error) {
      apply(before);
      toast.error(error);
    } else if (success) {
      toast.success(success);
    }
    return !error;
  }

  const update = (patch: Partial<Contact>, success?: string) => {
    const id = current?.id;
    return mutateContact(patch, () => supabase.from("contact").update(patch).eq("id", id), success);
  };

  async function assign(value: string) {
    if (!current) return;
    if (value === "__add__") {
      const name = await promptDialog({
        title: "Add a team member",
        body: "They join the assignee list, and this conversation is assigned to them.",
        placeholder: "Name or email",
        confirmLabel: "Add and Assign",
      });
      if (!name) return;
      if (!agents.includes(name)) {
        const { error } = await supabase.from("agent").upsert({ name }, { onConflict: "name" });
        if (error) return toast.error(error);
        setAgents((a) => [...a, name].sort());
      }
      value = name;
    }
    const next = value || null;
    if (next === current.assigned_to) return;
    await update({ assigned_to: next }, next ? `Assigned to ${next}` : "Unassigned");
  }

  function setStatus(status: "open" | "done") {
    return run("status", async () => {
      await update(status === "done" ? { status, unread: false } : { status }, status === "done" ? "Conversation closed" : "Conversation reopened");
    });
  }

  const resume = () => run("pause", async () => {
    await update({ pause_until: null }, "Automation resumed");
  });

  function send() {
    if (!current || !text.trim()) return;
    if (mode === "note") return addNote();
    const id = current.id;
    const body = text;
    return run("send", async () => {
      await callInbox({ contactId: id, text: body });
      // The person may have opened someone else while this was in flight.
      if (currentRef.current === id) setText("");
      else delete drafts.current[id];
      if (currentRef.current === id) await loadThread(id);
      loadContacts();
    });
  }

  function sendImage(file: File) {
    if (!current) return;
    const id = current.id;
    return run("image", async () => {
      const url = await uploadImage(file);
      await callInbox({ contactId: id, content: { imageUrl: url } });
      if (currentRef.current === id) await loadThread(id);
      loadContacts();
    });
  }

  function addNote() {
    const body = text.trim();
    if (!current || !body) return;
    const id = current.id;
    return run("note", async () => {
      const { error } = await supabase.from("contact_note").insert({ contact_id: id, body, author: me });
      if (error) throw error;
      if (currentRef.current === id) setText("");
      if (currentRef.current === id) await loadThread(id);
    });
  }

  /** Send an automation to this contact (a manual run). */
  function sendFlow(flow: Flow) {
    setPickFlow(false);
    if (!current) return;
    const id = current.id;
    return run("flow", async () => {
      await callInbox({ contactId: id, flowId: flow.id });
      toast.success(`“${flow.name}” started`);
      if (currentRef.current === id) await loadThread(id);
    });
  }

  async function saveReply() {
    const body = text.trim();
    if (!body) return;
    setShowReplies(false);
    const title = await promptDialog({
      title: "Save as a reply",
      body: "Give it a short name so you can find it in Saved Replies.",
      placeholder: "e.g. Shipping times",
      confirmLabel: "Save Reply",
    });
    if (!title) return;
    return run("reply", async () => {
      const { data, error } = await supabase.from("saved_reply").insert({ title, body }).select("id, title, body").single();
      if (error) throw error;
      setSavedReplies((s) => [...s, data].sort((a, b) => a.title.localeCompare(b.title)));
      toast.success(`Saved reply “${title}”`);
    });
  }

  // ---- composer -------------------------------------------------------------------------------

  // The reply box grows with what is typed, up to its CSS max-height, then scrolls.
  const composerRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight + 2}px`;
  }, [text, currentId, mode]);

  /** Put text where the caret is (not always at the end), then keep typing after it. */
  function insertAtCursor(snippet: string) {
    const el = composerRef.current;
    if (!el) return setText((t) => t + snippet);
    const start = el.selectionStart ?? text.length;
    const end = el.selectionEnd ?? text.length;
    setText(text.slice(0, start) + snippet + text.slice(end));
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + snippet.length, start + snippet.length);
    });
  }

  const fileRef = useRef<HTMLInputElement>(null);

  // ---- render ---------------------------------------------------------------------------------

  const state = current ? windowState(current.last_interaction_at) : "closed";
  const paused = current ? pausedUntil(current) : null;
  const entries: Entry[] = useMemo(
    () =>
      [
        ...messages.map((m) => ({ kind: "msg" as const, at: m.created_at, m })),
        ...notes.map((n) => ({ kind: "note" as const, at: n.created_at, n })),
      ].sort((a, b) => a.at.localeCompare(b.at)),
    [messages, notes],
  );
  const viaOf = (m: Message) => (m.flow_run_id && runFlow[m.flow_run_id] ? flowNames[runFlow[m.flow_run_id]] : undefined);
  const busyAny = (k: string) => busy.has(k);
  const replyBlocked = mode === "reply" && state === "closed";
  const isFiltered = folder !== "all" || statusFilter !== "open" || query.trim() !== "";

  const folderBtn = (f: Folder, label: ReactNode, icon: ReactNode) => (
    <button key={f} className={`lc-folder ${folder === f ? "is-current" : ""}`} onClick={() => setFolder(f)} aria-pressed={folder === f}>
      <span className="lc-folder-ic" aria-hidden="true">{icon}</span>
      <span className="lc-folder-label">{label}</span>
      <span className="lc-folder-n">{countIn(f)}</span>
    </button>
  );

  return (
    <div className={`lc ${mobileChat && current ? "show-chat" : ""} ${showProfile ? "show-profile" : ""}`}>
      {/* inbox folders */}
      <aside className="lc-folders" aria-label="Inbox folders">
        <h1 className="lc-title">Live Chat</h1>
        <nav className="lc-folder-list">
          {folderBtn("all", "All", <InboxIcon />)}
          {folderBtn("unassigned", "Unassigned", <PersonIcon dashed />)}
          {me && folderBtn("mine", "Mine", <PersonIcon />)}
        </nav>
        {team.length > 0 && (
          <>
            <p className="lc-folder-head">Team</p>
            <nav className="lc-folder-list">
              {team.map((a) => folderBtn(`agent:${a}`, a, <span className="lc-mini-avatar">{a[0]?.toUpperCase()}</span>))}
            </nav>
          </>
        )}
        <p className="lc-folder-foot">Counts show open conversations.</p>
      </aside>

      {/* conversation list */}
      <section className="lc-list" aria-label="Conversations">
        <div className="lc-list-head">
          <div className="lc-folder-select">
            <Select value={folder} onChange={(v) => setFolder(v as Folder)} ariaLabel="Inbox folder" options={folderOptions} />
          </div>
          <div className="lc-list-filters">
            <Select
              value={statusFilter}
              onChange={(v) => setStatusFilter(v as typeof statusFilter)}
              ariaLabel="Conversation status"
              options={[
                { value: "open", label: "Open" },
                { value: "done", label: "Closed" },
                { value: "all", label: "All" },
              ]}
            />
            <Select
              value={sort}
              onChange={(v) => setSort(v as typeof sort)}
              ariaLabel="Sort conversations"
              options={[
                { value: "newest", label: "Newest" },
                { value: "oldest", label: "Oldest" },
              ]}
            />
          </div>
          <input className="input lc-search" placeholder="Search by name, username or tag" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search conversations" />
        </div>
        {error && <div className="notice" style={{ margin: 10 }}>{error}</div>}
        <div className="lc-rows">
          {loading ? (
            <Loader label="Loading conversations" inline />
          ) : shown.length === 0 ? (
            <div className="lc-nomatch">
              <p>
                {contacts.length === 0
                  ? "No conversations yet. When someone messages your Instagram account, it lands here."
                  : statusFilter === "open" && !query.trim()
                    ? "No open conversations here. You're all caught up."
                    : "No conversations match."}
              </p>
              {isFiltered && contacts.length > 0 && (
                <button
                  className="btn btn-quiet"
                  onClick={() => {
                    setFolder("all");
                    setStatusFilter("open");
                    setQuery("");
                  }}
                >
                  Show all open
                </button>
              )}
            </div>
          ) : (
            shown.map((c) => {
              const pv = previews[c.id];
              return (
                <button
                  key={c.id}
                  className={`lc-row ${c.id === currentId ? "is-current" : ""} ${c.unread ? "is-unread" : ""}`}
                  onClick={() => {
                    setCurrentId(c.id);
                    setMobileChat(true);
                  }}
                >
                  <ContactAvatar contact={c} size={40} badge />
                  <span className="lc-row-main">
                    <span className="lc-row-top">
                      <span className="lc-row-name" dir="auto">{nameOf(c)}</span>
                      <span className="lc-row-time">{pv ? shortTime(pv.at) : ""}</span>
                    </span>
                    <span className="lc-row-bottom">
                      <span className="lc-row-preview" dir="auto">{pv ? (pv.out ? "You: " : "") + pv.text : "No messages yet"}</span>
                      {c.status === "done" && <span className="lc-row-flag">Closed</span>}
                      {c.unread && <span className="lc-unread" aria-label="Unread" />}
                    </span>
                  </span>
                </button>
              );
            })
          )}
        </div>
      </section>

      {/* the chat */}
      <section className="lc-chat" aria-label="Conversation">
        {!current ? (
          <div className="lc-empty">
            <div className="lc-empty-art" aria-hidden="true"><InboxIcon /></div>
            <p className="lc-empty-title">Pick a conversation</p>
            <p className="lc-empty-sub">Choose someone on the left to read the chat and reply.</p>
          </div>
        ) : (
          <>
            <header className="lc-chat-head">
              <button className="icon-btn lc-back" onClick={() => setMobileChat(false)} aria-label="Back to conversations">←</button>
              <button className="lc-who" onClick={() => setShowProfile(true)} title="Show profile">
                <ContactAvatar contact={current} size={36} />
                <span className="lc-who-text">
                  <strong dir="auto">{nameOf(current)}</strong>
                  <span>
                    <IgLogo size={12} /> {current.username ? `@${current.username}` : "Instagram"}
                  </span>
                </span>
              </button>
              <div className="lc-head-actions">
                <div className="lc-assign">
                  <Select
                    value={current.assigned_to ?? ""}
                    onChange={assign}
                    ariaLabel="Assign to"
                    options={[
                      { value: "", label: "Unassigned" },
                      ...team.map((a) => ({ value: a, label: a })),
                      { value: "__add__", label: "+ Add team member…" },
                    ]}
                  />
                </div>
                {current.status === "done" ? (
                  <button className={`btn ${busyAny("status") ? "is-busy" : ""}`} disabled={busyAny("status")} onClick={() => setStatus("open")}>
                    Reopen
                  </button>
                ) : (
                  <button className={`btn btn-primary ${busyAny("status") ? "is-busy" : ""}`} disabled={busyAny("status")} onClick={() => setStatus("done")}>
                    <CheckIcon /> Close
                  </button>
                )}
                <button
                  className={`icon-btn lc-profile-toggle ${showProfile ? "is-on" : ""}`}
                  onClick={() => setShowProfile((s) => !s)}
                  aria-label="Contact profile"
                  aria-pressed={showProfile}
                  title="Contact profile"
                >
                  <PersonIcon />
                </button>
              </div>
            </header>

            {paused && (
              <div className="lc-pausebar" role="status">
                <span>
                  <strong>Automation paused</strong> for {nameOf(current)}
                  {isForever(paused) ? " until you resume it" : ` until ${clockTime(paused)}`}. Your replies go out; automations wait.
                </span>
                <button className="link-btn" onClick={resume} disabled={busyAny("pause")}>Resume now</button>
              </div>
            )}

            <div className="lc-thread-wrap">
              {threadOf?.id !== current.id ? (
                <div className="lc-thread lc-skeleton" ref={threadRef} aria-busy="true" aria-label="Loading conversation">
                  {[62, 38, 70, 45, 55].map((w, i) => (
                    <span key={i} className={`lc-skel ${i % 2 ? "is-out" : ""}`} style={{ width: `${w}%`, animationDelay: `${i * 90}ms` }} />
                  ))}
                </div>
              ) : threadOf.failed || entries.length === 0 ? (
                <div className="lc-thread" ref={threadRef}>
                  <p className="lc-sys">{threadOf.failed ? "Couldn't load this conversation. Retrying…" : "No messages yet."}</p>
                </div>
              ) : (
                <div className="lc-thread" ref={threadRef} onScroll={onThreadScroll}>
                  {entries.map((e, i) => {
                    const prev = entries[i - 1];
                    const showDay = !prev || dayKey(prev.at) !== dayKey(e.at);
                    return (
                      <Fragment key={e.kind === "msg" ? e.m.id : `n-${e.n.id}`}>
                        {showDay && <div className="lc-day"><span>{dayLabel(e.at)}</span></div>}
                        {e.kind === "note" ? <NoteView note={e.n} /> : <MessageView m={e.m} via={viaOf(e.m)} onMedia={onMedia} />}
                      </Fragment>
                    );
                  })}
                </div>
              )}
              {showJump && (
                <button className="lc-jump" onClick={() => scrollToLatest(true)}>New messages ↓</button>
              )}
            </div>

            <div className={`lc-composer ${mode === "note" ? "is-note" : ""}`}>
              <div className="lc-tabs" role="tablist" aria-label="Message type">
                <button role="tab" aria-selected={mode === "reply"} className={mode === "reply" ? "on" : ""} onClick={() => setMode("reply")}>Reply</button>
                <button role="tab" aria-selected={mode === "note"} className={mode === "note" ? "on" : ""} onClick={() => setMode("note")}>Note</button>
                {mode === "reply" && state !== "closed" && (
                  <span className={`lc-window lc-window-${state}`} title="Instagram's messaging window">
                    {state === "open" ? "24h window" : "Human agent window"} · {timeLeft(current.last_interaction_at as string, state === "open" ? WINDOW_MS : HUMAN_MS)} left
                  </span>
                )}
              </div>

              {replyBlocked ? (
                <div className="lc-shut">
                  It's been more than 7 days since {nameOf(current)} last wrote, so Instagram won't deliver a reply until they message you again.
                  You can still leave a <button className="link-btn" onClick={() => setMode("note")}>note</button> for your team.
                </div>
              ) : (
                <>
                  {mode === "reply" && state === "human_only" && (
                    <div className="lc-tagnote">More than 24 hours since their last message: your reply goes with Instagram's HUMAN_AGENT tag.</div>
                  )}
                  <textarea
                    ref={composerRef}
                    className="lc-input"
                    rows={1}
                    dir="auto"
                    placeholder={mode === "note" ? "Write a note only your team can see…" : `Reply to ${nameOf(current)}…`}
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    onKeyDown={(e) => {
                      // Enter sends, Shift+Enter breaks the line. Leave IME composition alone.
                      if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                        e.preventDefault();
                        send();
                      }
                    }}
                  />
                  <div className="lc-compose-bar">
                    {mode === "reply" && (
                      <div className="lc-tools">
                        <div className="menu-wrap" ref={emojiRef}>
                          <button className={`icon-btn ${showEmoji ? "is-on" : ""}`} aria-expanded={showEmoji} onClick={() => { setShowEmoji((s) => !s); setShowReplies(false); }} title="Emoji" aria-label="Emoji">
                            <SmileIcon />
                          </button>
                          {showEmoji && (
                            <div className="lc-pop lc-emoji pop-in">
                              {EMOJIS.map((em) => (
                                <button key={em} className="emoji-btn" onClick={() => insertAtCursor(em)}>{em}</button>
                              ))}
                            </div>
                          )}
                        </div>
                        <button className={`icon-btn ${busyAny("image") ? "is-busy" : ""}`} onClick={() => fileRef.current?.click()} disabled={busyAny("image")} title="Send an image" aria-label="Send an image">
                          <ImageIcon />
                        </button>
                        <input
                          ref={fileRef}
                          type="file"
                          accept={IMAGE_TYPES.join(",")}
                          hidden
                          onChange={(e) => {
                            const f = e.target.files?.[0];
                            e.target.value = "";
                            if (f) sendImage(f);
                          }}
                        />
                        <div className="menu-wrap" ref={repliesRef}>
                          <button className={`icon-btn ${showReplies ? "is-on" : ""}`} aria-expanded={showReplies} onClick={() => { setShowReplies((s) => !s); setShowEmoji(false); }} title="Saved replies" aria-label="Saved replies">
                            <BookmarkIcon />
                          </button>
                          {showReplies && (
                            <div className="lc-pop pop-in">
                              <p className="lc-pop-head">Saved replies</p>
                              {savedReplies.length === 0 && <p className="lc-pop-empty">None yet. Type a reply, then save it here.</p>}
                              {savedReplies.map((r) => (
                                <button key={r.id} className="menu-item" onClick={() => { insertAtCursor(r.body); setShowReplies(false); }}>
                                  <strong>{r.title}</strong>
                                  <span className="tool-pop-sub">{r.body.slice(0, 60)}</span>
                                </button>
                              ))}
                              <div className="tool-pop-add">
                                <button className="menu-item" disabled={!text.trim() || busyAny("reply")} onClick={saveReply}>
                                  {busyAny("reply") ? "Saving…" : "+ Save current text"}
                                </button>
                              </div>
                            </div>
                          )}
                        </div>
                        <button className={`icon-btn ${busyAny("flow") ? "is-busy" : ""}`} onClick={() => setPickFlow(true)} disabled={busyAny("flow")} title="Send an automation" aria-label="Send an automation">
                          <BoltIcon />
                        </button>
                      </div>
                    )}
                    <span className="lc-hint">Enter to {mode === "note" ? "save" : "send"} · Shift+Enter for a new line</span>
                    <button
                      className={`btn btn-primary ${busyAny("send") || busyAny("note") ? "is-busy" : ""}`}
                      onClick={send}
                      disabled={!text.trim() || busyAny("send") || busyAny("note")}
                    >
                      {mode === "note" ? "Add Note" : "Send"}
                    </button>
                  </div>
                </>
              )}
            </div>
          </>
        )}
      </section>

      {/* contact profile */}
      {current && (
        <>
          <div className="lc-profile-scrim" onClick={() => setShowProfile(false)} aria-hidden="true" />
          <ContactProfile
            contact={current}
            onChange={(next) => setContacts((list) => list.map((c) => (c.id === next.id ? next : c)))}
            onClose={() => setShowProfile(false)}
            refreshKey={entryCount}
          />
        </>
      )}

      {pickFlow && <FlowPicker title={`Send an automation to ${current ? nameOf(current) : "this contact"}`} onPick={sendFlow} onClose={() => setPickFlow(false)} />}
    </div>
  );
}

function inFolder(c: Contact, f: Folder, me: string | null): boolean {
  if (f === "all") return true;
  if (f === "unassigned") return !c.assigned_to;
  if (f === "mine") return Boolean(me) && c.assigned_to === me;
  return c.assigned_to === f.slice("agent:".length);
}

function NoteView({ note }: { note: Note }) {
  return (
    <div className="lc-note">
      <div className="lc-note-head">Note{note.author ? ` · ${note.author}` : ""} · {clockTime(note.created_at)}</div>
      <div className="lc-note-body" dir="auto">{note.body}</div>
    </div>
  );
}

type RawPayload = Message["payload"] & {
  title?: string;
  payload?: string;
  attachments?: { type?: string; payload?: { url?: string; title?: string } }[];
  reply_to?: { story?: { url?: string } };
};

/** One message as it looked in Instagram: text, buttons, image, gallery or attachment. */
function MessageView({ m, via, onMedia }: { m: Message; via?: string; onMedia?: () => void }) {
  const out = m.direction === "out";
  const human = (m as Message & { sent_by?: string }).sent_by === "human";
  const p = (m.payload ?? {}) as RawPayload;
  const text = typeof p.text === "string" && p.text.trim() ? p.text : "";
  const buttons = (p.buttons ?? []).filter((b) => b.title);
  const quick = (p.quickReplies ?? []).filter((q) => q.title);
  const cards = (p.cards ?? []).filter((c) => c.title || c.imageUrl);
  const attachments = p.attachments ?? [];
  // A tap on a button arrives as {title, payload} with no text.
  const tapped = !out && !text && p.title && typeof p.payload === "string" ? p.title : null;
  const parts: ReactNode[] = [];

  if (p.reply_to?.story) parts.push(<span key="story" className="lc-context">Replied to your story</span>);
  if (tapped) parts.push(<span key="tap" className="lc-tap">Tapped “{tapped}”</span>);
  if (text || buttons.length) {
    parts.push(
      <div key="bubble" className="lc-bubble">
        {text && <span className="lc-text" dir="auto">{text}</span>}
        {buttons.length > 0 && <Buttons buttons={buttons} />}
      </div>,
    );
  }
  if (p.imageUrl) parts.push(<img key="img" className="lc-media" src={p.imageUrl} alt="Image" onLoad={onMedia} />);
  if (cards.length) parts.push(<Cards key="cards" cards={cards} onMedia={onMedia} />);
  if (p.attachment?.url) parts.push(<a key="att" className="lc-file" href={p.attachment.url} target="_blank" rel="noreferrer">{p.attachment.type} file ↗</a>);
  attachments.forEach((a, i) => parts.push(<Attachment key={`a${i}`} a={a} onMedia={onMedia} />));
  if (quick.length) {
    parts.push(
      <div key="quick" className="lc-quick">
        {quick.map((q, i) => <span key={i} className="lc-chip">{q.title}</span>)}
      </div>,
    );
  }

  if (!parts.length) return <p className="lc-sys">{out ? "Sent a message the panel can't show" : "Sent something the panel can't show (a reaction or unsupported attachment)"} · {clockTime(m.created_at)}</p>;

  return (
    <div className={`lc-msg ${out ? "is-out" : "is-in"} ${out && !human ? "is-bot" : ""} ${out && human ? "is-human" : ""}`}>
      {parts}
      <div className="lc-meta">
        {out && (human ? "Agent · " : via ? `${via} · ` : "Automation · ")}
        {new Date(m.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
      </div>
    </div>
  );
}

function Buttons({ buttons }: { buttons: MessageButton[] }) {
  return (
    <div className="lc-btns">
      {buttons.map((b, i) => (
        <span key={i} className="lc-btn">{b.title}{b.url ? " ↗" : ""}</span>
      ))}
    </div>
  );
}

function Cards({ cards, onMedia }: { cards: MessageCard[]; onMedia?: () => void }) {
  return (
    <div className="lc-cards">
      {cards.map((c, i) => (
        <div key={i} className="lc-card">
          {c.imageUrl && <img src={c.imageUrl} alt="" onLoad={onMedia} />}
          <div className="lc-card-body">
            <strong dir="auto">{c.title}</strong>
            {c.subtitle && <span dir="auto">{c.subtitle}</span>}
          </div>
          {(c.buttons ?? []).length > 0 && <Buttons buttons={c.buttons ?? []} />}
        </div>
      ))}
    </div>
  );
}

function Attachment({ a, onMedia }: { a: { type?: string; payload?: { url?: string; title?: string } }; onMedia?: () => void }) {
  const url = a.payload?.url;
  switch (a.type) {
    case "image":
    case "animated_image_share":
      return url ? <img className="lc-media" src={url} alt="Image" referrerPolicy="no-referrer" onLoad={onMedia} /> : <span className="lc-context">Sent a photo</span>;
    case "video":
      return url ? <video className="lc-media" src={url} controls preload="metadata" onLoadedMetadata={onMedia} /> : <span className="lc-context">Sent a video</span>;
    case "audio":
      return url ? <audio className="lc-audio" src={url} controls preload="none" /> : <span className="lc-context">Sent a voice message</span>;
    case "story_mention":
      return (
        <span className="lc-context">
          Mentioned you in their story{url && <> · <a href={url} target="_blank" rel="noreferrer">View story ↗</a></>}
        </span>
      );
    case "share":
    case "ig_reel":
    case "reel":
      return (
        <span className="lc-context">
          Shared a {a.type === "share" ? "post" : "reel"}{url && <> · <a href={url} target="_blank" rel="noreferrer">Open ↗</a></>}
        </span>
      );
    default:
      return (
        <span className="lc-context">
          Sent an attachment{url && <> · <a href={url} target="_blank" rel="noreferrer">Open ↗</a></>}
        </span>
      );
  }
}

function dayKey(iso: string): string {
  return new Date(iso).toDateString();
}

function dayLabel(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const key = d.toDateString();
  if (key === now.toDateString()) return "Today";
  if (key === new Date(now.getTime() - 86400000).toDateString()) return "Yesterday";
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: d.getFullYear() !== now.getFullYear() ? "numeric" : undefined,
  });
}

/** List time: clock today, weekday this week, date before that. */
function shortTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (now.getTime() - d.getTime() < 6 * 86400000) return d.toLocaleDateString([], { weekday: "short" });
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

/** A short text preview of a message for the conversation list. */
function previewText(payload: Message["payload"]): string {
  const p = (payload ?? {}) as RawPayload;
  if (typeof p.text === "string" && p.text.trim()) return p.text.trim();
  if (p.title && typeof p.payload === "string") return `Tapped “${p.title}”`;
  if (p.imageUrl) return "📷 Photo";
  if (p.cards?.length) return `🖼 ${p.cards[0].title || "Gallery"}`;
  const a = p.attachments?.[0]?.type;
  if (a === "image") return "📷 Photo";
  if (a === "video") return "🎬 Video";
  if (a === "audio") return "🎤 Voice message";
  if (a === "story_mention") return "Mentioned you in their story";
  if (a === "share" || a === "ig_reel" || a === "reel") return "Shared a post";
  const buttons = (p.buttons ?? []).map((b) => b.title).filter(Boolean);
  if (buttons.length) return buttons.join(" · ");
  return "Attachment";
}

// ---- icons ---------------------------------------------------------------------------------------

const ic = { width: 16, height: 16, viewBox: "0 0 16 16", fill: "none", "aria-hidden": true } as const;
const stroke = { stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round" } as const;

function InboxIcon() {
  return (
    <svg {...ic}>
      <path d="M2 9.5 3.6 3.6A1.5 1.5 0 0 1 5 2.5h6a1.5 1.5 0 0 1 1.4 1.1L14 9.5v3a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-3z" {...stroke} />
      <path d="M2 9.5h3.2l.8 1.5h4l.8-1.5H14" {...stroke} />
    </svg>
  );
}

function PersonIcon({ dashed }: { dashed?: boolean }) {
  return (
    <svg {...ic}>
      <circle cx="8" cy="5.5" r="2.6" {...stroke} strokeDasharray={dashed ? "2 1.6" : undefined} />
      <path d="M3 13.5c.6-2.4 2.6-3.8 5-3.8s4.4 1.4 5 3.8" {...stroke} strokeDasharray={dashed ? "2 1.6" : undefined} />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="m3 8.5 3.2 3L13 4.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function SmileIcon() {
  return (
    <svg {...ic}>
      <circle cx="8" cy="8" r="6" {...stroke} />
      <path d="M5.6 9.6c.6.8 1.4 1.2 2.4 1.2s1.8-.4 2.4-1.2" {...stroke} />
      <circle cx="6" cy="6.5" r=".6" fill="currentColor" />
      <circle cx="10" cy="6.5" r=".6" fill="currentColor" />
    </svg>
  );
}

function ImageIcon() {
  return (
    <svg {...ic}>
      <rect x="2" y="3" width="12" height="10" rx="1.5" {...stroke} />
      <circle cx="5.8" cy="6.4" r="1.1" {...stroke} />
      <path d="m2.5 12 3.8-3.6 2.4 2.2 1.8-1.6 3 2.6" {...stroke} />
    </svg>
  );
}

function BookmarkIcon() {
  return (
    <svg {...ic}>
      <path d="M4.5 2.5h7v11L8 11l-3.5 2.5v-11z" {...stroke} />
    </svg>
  );
}

function BoltIcon() {
  return (
    <svg {...ic}>
      <path d="M9 1.8 3.5 9h4l-1 5.2L12.5 7h-4l.5-5.2z" {...stroke} />
    </svg>
  );
}
