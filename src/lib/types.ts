export type NodeType =
  | "send_message"
  | "wait_reply"
  | "check_follow"
  | "condition"
  | "delay"
  | "collect"
  | "action"
  | "randomize"
  | "smart_delay"
  | "http_request"
  | "go_to_flow"
  | "end";

/** One thing an Action node does. A node runs its actions top-to-bottom, then takes `next`. */
export type ActionKind =
  | "set_field"
  | "clear_field"
  | "add_tag"
  | "remove_tag"
  | "assign"
  | "mark_done"
  | "notify"
  | "subscribe_sequence"
  | "unsubscribe_sequence";

export interface FlowAction {
  kind: ActionKind;
  /** set_field / clear_field: the custom-field key. */
  field?: string;
  /** set_field: the value to write (supports {{state.x}} / {{contact.y}} interpolation). */
  value?: string;
  /** add_tag / remove_tag: the tag name. */
  tag?: string;
  /** assign: the agent to assign the conversation to. */
  assignee?: string;
  /** notify: an internal note to drop on the conversation for an admin. */
  message?: string;
  /** subscribe_sequence / unsubscribe_sequence: the sequence id. */
  sequenceId?: string;
}

/** A weighted branch on a Randomize node. `key` is the exit handle (b0, b1 …). */
export interface RandomBranch {
  key: string;
  weight: number;
}

/** One header on an HTTP Request node. */
export interface HttpHeader {
  key: string;
  value: string;
}

/** The kinds of value a collect node can gather and validate. */
export type InputType = "email" | "phone" | "text" | "number" | "url" | "choice";

export interface MessageButton {
  title: string;
  /** Sent back to the webhook when the contact taps a postback button. */
  payload: string;
  /** Set this and the button opens a link instead. A link does not open the messaging window. */
  url?: string;
}

/** One card in a gallery/carousel — a horizontal, swipeable set of image+title+buttons cards. */
export interface MessageCard {
  title: string;
  subtitle?: string;
  imageUrl?: string;
  buttons?: MessageButton[];
}

export interface MessageContent {
  text?: string;
  imageUrl?: string;
  buttons?: MessageButton[];
  quickReplies?: { title: string; payload: string }[];
  /** A gallery / carousel of cards. When present, takes precedence over text+buttons. */
  cards?: MessageCard[];
  /** A non-image media attachment (audio, video, or file) sent by URL. */
  attachment?: { type: "audio" | "video" | "file"; url: string };
}

export interface FlowNode {
  type: NodeType;
  content?: MessageContent;
  /** send_message: extra message bubbles sent after `content`, in order. */
  extras?: MessageContent[];
  next?: string | null;
  saveTo?: string;
  timeoutSeconds?: number;
  onTimeout?: string | null;
  onTrue?: string | null;
  onFalse?: string | null;
  left?: string;
  op?: "eq" | "neq" | "contains" | "exists" | "gt" | "lt" | "has_tag" | "not_has_tag";
  right?: string;
  seconds?: number;
  /** editor: a custom label for this step. Ignored by the engine. */
  title?: string;
  /** collect */
  inputType?: InputType;
  promptText?: string;
  quickReplies?: string[];
  retryMessage?: string;
  maxAttempts?: number;
  skipEnabled?: boolean;
  skipTitle?: string;
  onFailed?: string | null;
  /** action: the list of things this node does before taking `next`. */
  actions?: FlowAction[];
  /** randomize: weighted branches; each key is an exit handle. */
  branches?: RandomBranch[];
  /** smart_delay: duration (seconds) or wait until a local time of day. */
  delayMode?: "duration" | "until_time";
  untilHour?: number;
  untilMinute?: number;
  /** http_request */
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url?: string;
  headers?: HttpHeader[];
  body?: string;
  onError?: string | null;
  /** go_to_flow: the flow to hand the contact off to. */
  targetFlowId?: string;
  /** Visual editor only. The execution engine ignores this. */
  position?: { x: number; y: number };
}

/** A sticky note the builder places on the canvas to annotate the flow. Editor-only. */
export interface EditorNote {
  id: string;
  text: string;
  position: { x: number; y: number };
  color?: "yellow" | "green" | "blue" | "pink";
}

export interface FlowGraph {
  start: string;
  nodes: Record<string, FlowNode>;
  /** Visual editor only: where the trigger node sits on the canvas. Engine ignores it. */
  triggerPosition?: { x: number; y: number };
  /** Visual editor only: sticky-note annotations. The engine never reads these. */
  notes?: EditorNote[];
}

export type TriggerType =
  | "comment"
  | "keyword"
  | "story_reply"
  | "story_mention"
  | "share_to_dm"
  | "live_comment"
  | "default_reply"
  | "ref_url";

export interface TriggerConfig {
  mediaId?: string;
  keywords?: string[];
  match?: "contains" | "exact";
  /** default_reply: do not fire on story replies. */
  excludeStoryReplies?: boolean;
  /** ref_url: match this ref value. Empty means any ref. */
  ref?: string;
  /** live_comment: the broadcast media id. Empty means any live. */
  broadcastId?: string;
  /** comment/live_comment: public replies posted under the comment, one picked at random. */
  commentReply?: string[];
}

export interface Flow {
  id: string;
  name: string;
  status: "draft" | "live";
  /** null on a brand-new "start from scratch" draft, until a trigger is chosen. */
  trigger_type: TriggerType | null;
  trigger_config: TriggerConfig;
  graph: FlowGraph;
  folder_id: string | null;
  /** Set while the automation sits in Trash. */
  deleted_at: string | null;
  /** Edits to a Live automation that aren't published yet. */
  draft: FlowDraft | null;
  created_at: string;
  updated_at: string;
}

export interface FlowDraft {
  trigger_type: TriggerType | null;
  trigger_config: TriggerConfig;
  graph: FlowGraph;
}

export interface FlowFolder {
  id: string;
  name: string;
  parent_id: string | null;
  created_at: string;
}

/** A starter workflow stored as data (flow_template row). Picking one deep-clones it into a draft. */
export interface FlowTemplate {
  id: string;
  name: string;
  description: string;
  goal: string;
  trigger_type: TriggerType;
  badge: string | null;
  recommended: boolean;
  sort: number;
  trigger_config: TriggerConfig;
  graph: FlowGraph;
}

export interface Contact {
  id: string;
  igsid: string;
  username: string | null;
  follows_account: boolean | null;
  follows_checked_at: string | null;
  last_interaction_at: string | null;
  custom_fields: Record<string, unknown>;
  pause_until: string | null;
  assigned_to: string | null;
  unread: boolean;
  tags: string[];
  /** "done" shows as Closed. */
  status: "open" | "done";
  name: string | null;
  profile_pic: string | null;
  opted_out_at: string | null;
  created_at: string;
}

export interface Message {
  id: string;
  contact_id: string;
  direction: "in" | "out";
  payload: MessageContent & { text?: string; mid?: string };
  meta_message_id: string | null;
  flow_run_id: string | null;
  created_at: string;
}

export type RunStatus =
  | "running"
  | "waiting_input"
  | "waiting_delay"
  | "done"
  | "failed"
  | "blocked_window";

export interface FlowRun {
  id: string;
  flow_id: string;
  contact_id: string;
  current_node_id: string | null;
  status: RunStatus;
  state: Record<string, unknown>;
  resume_at: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface MediaAsset {
  id: string;
  storage_path: string;
  public_url: string;
  created_at: string;
}
