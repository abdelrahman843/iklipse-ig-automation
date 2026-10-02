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
  field?: string;
  value?: string;
  tag?: string;
  assignee?: string;
  message?: string;
  sequenceId?: string;
}

export interface RandomBranch {
  key: string;
  weight: number;
}

export interface HttpHeader {
  key: string;
  value: string;
}

export interface MessageCard {
  title: string;
  subtitle?: string;
  imageUrl?: string;
  buttons?: MessageButton[];
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

export interface MessageContent {
  text?: string;
  imageUrl?: string;
  buttons?: MessageButton[];
  /** Rendered as Instagram quick replies (above the keyboard). Used by collect prompts. */
  quickReplies?: { title: string; payload: string }[];
  /** A gallery / carousel of cards (generic template). */
  cards?: MessageCard[];
  /** A non-image media attachment sent by URL. */
  attachment?: { type: "audio" | "video" | "file"; url: string };
}

export interface FlowNode {
  type: NodeType;
  content?: MessageContent;
  /** send_message: extra message bubbles sent after `content`, in order. */
  extras?: MessageContent[];
  next?: string;
  /** wait_reply */
  saveTo?: string;
  timeoutSeconds?: number;
  onTimeout?: string;
  /** check_follow and condition */
  onTrue?: string;
  onFalse?: string;
  /** condition */
  left?: string;   // "state.user_reply" or "contact.username"
  op?: "eq" | "neq" | "contains" | "exists" | "gt" | "lt" | "has_tag" | "not_has_tag";
  right?: string;
  /** delay */
  seconds?: number;
  /** editor: a custom label for this step. Ignored by the engine. */
  title?: string;
  /** collect */
  inputType?: InputType;
  promptText?: string;
  quickReplies?: string[];     // choice options offered to the contact
  retryMessage?: string;
  maxAttempts?: number;
  skipEnabled?: boolean;
  skipTitle?: string;
  onFailed?: string | null;    // taken after maxAttempts of invalid input
  /** action */
  actions?: FlowAction[];
  /** randomize */
  branches?: RandomBranch[];
  /** smart_delay */
  delayMode?: "duration" | "until_time";
  untilHour?: number;
  untilMinute?: number;
  /** http_request */
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url?: string;
  headers?: HttpHeader[];
  body?: string;
  onError?: string | null;
  /** go_to_flow */
  targetFlowId?: string;
}

export interface FlowGraph {
  start: string;
  nodes: Record<string, FlowNode>;
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
  /** comment triggers: the Instagram media id to watch. Empty means any post. */
  mediaId?: string;
  keywords?: string[];
  /** how a keyword must appear in the text */
  match?: "contains" | "exact";
  /** default_reply: do not fire on story replies, which have their own trigger. */
  excludeStoryReplies?: boolean;
  /** ref_url: only fire when the ref value equals or contains this. Empty means any ref. */
  ref?: string;
  /** live_comment: the broadcast media id to watch. Empty means any live broadcast. */
  broadcastId?: string;
  /** comment/live_comment: public replies to post under the comment itself, one picked at
   *  random each time (rotating keeps it from reading as a bot). Empty means no public reply. */
  commentReply?: string[];
}

export const WINDOW_MS = 24 * 60 * 60 * 1000;
export const PRIVATE_REPLY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** A live-comment private reply is only valid while the broadcast runs; expire it fast. */
export const LIVE_REPLY_TTL_MS = 10 * 60 * 1000;
