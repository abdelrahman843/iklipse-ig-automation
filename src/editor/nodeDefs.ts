// The node catalogue. One definition per node type the backend already understands, plus the
// trigger. The canvas, the picker and the config panel all read these — nothing about a node
// type is hardcoded into a React component. Add a backend node type here and it appears in the
// editor with the right handles and category.

import type { NodeType } from "../lib/types";

export type EditorNodeType = NodeType | "trigger";

export type Category = "Triggers" | "Messaging" | "Actions" | "Conditions" | "Utilities";

/** One outgoing handle. `key` is the exit field the adapter writes on the backend node. */
export interface NodeOutput {
  key: string;
  label: string;
}

export interface NodeDef {
  type: EditorNodeType;
  name: string;
  description: string;
  category: Category;
  icon: string;
  /** 0 for the trigger (nothing feeds it), 1 for everything else. */
  inputs: number;
  outputs: NodeOutput[];
  /** Pauses the run — drawn with the "waiting" accent. */
  pauses?: boolean;
  /** Can a user add this from the picker? The trigger is created with the flow, not added. */
  addable: boolean;
}

export const NODE_DEFS: Record<EditorNodeType, NodeDef> = {
  trigger: {
    type: "trigger",
    name: "Trigger",
    description: "What starts the flow — a comment on a post, or a direct message.",
    category: "Triggers",
    icon: "▶",
    inputs: 0,
    outputs: [{ key: "start", label: "" }],
    addable: false,
  },
  send_message: {
    type: "send_message",
    name: "Send message",
    description: "Send text, an image, and up to three buttons.",
    category: "Messaging",
    icon: "✉",
    inputs: 1,
    outputs: [{ key: "next", label: "Then" }],
    addable: true,
  },
  wait_reply: {
    type: "wait_reply",
    name: "Wait for reply",
    description: "Pause until the contact answers, or a timeout passes.",
    category: "Actions",
    icon: "⏳",
    inputs: 1,
    outputs: [
      { key: "next", label: "On reply" },
      { key: "onTimeout", label: "On timeout" },
    ],
    pauses: true,
    addable: true,
  },
  check_follow: {
    type: "check_follow",
    name: "Check follow",
    description: "Branch on whether the contact follows the account.",
    category: "Conditions",
    icon: "☆",
    inputs: 1,
    outputs: [
      { key: "onTrue", label: "Follows" },
      { key: "onFalse", label: "Doesn't follow" },
    ],
    addable: true,
  },
  condition: {
    type: "condition",
    name: "Branch on a value",
    description: "Compare a stored value and take one of two paths.",
    category: "Conditions",
    icon: "⑃",
    inputs: 1,
    outputs: [
      { key: "onTrue", label: "True" },
      { key: "onFalse", label: "False" },
    ],
    addable: true,
  },
  collect: {
    type: "collect",
    name: "Collect input",
    description: "Ask for a value (email, phone, choice…), validate it, and save it to the contact.",
    category: "Actions",
    icon: "⌸",
    inputs: 1,
    outputs: [
      { key: "next", label: "On value" },
      { key: "onTimeout", label: "On timeout" },
      { key: "onFailed", label: "On give up" },
    ],
    pauses: true,
    addable: true,
  },
  delay: {
    type: "delay",
    name: "Wait a while",
    description: "Pause for a set time before continuing.",
    category: "Utilities",
    icon: "◷",
    inputs: 1,
    outputs: [{ key: "next", label: "Then" }],
    pauses: true,
    addable: true,
  },
  action: {
    type: "action",
    name: "Action",
    description: "Set a field, add or remove a tag, assign, or notify — no message sent.",
    category: "Actions",
    icon: "⚡",
    inputs: 1,
    outputs: [{ key: "next", label: "Then" }],
    addable: true,
  },
  randomize: {
    type: "randomize",
    name: "Randomize",
    description: "Split traffic down two or more weighted paths, for A/B tests.",
    category: "Conditions",
    icon: "⇄",
    inputs: 1,
    // Handles are generated from node.branches; these are the default two.
    outputs: [
      { key: "b0", label: "A" },
      { key: "b1", label: "B" },
    ],
    addable: true,
  },
  smart_delay: {
    type: "smart_delay",
    name: "Smart delay",
    description: "Wait a duration, or until a specific time of day, before continuing.",
    category: "Utilities",
    icon: "⏲",
    inputs: 1,
    outputs: [{ key: "next", label: "Then" }],
    pauses: true,
    addable: true,
  },
  http_request: {
    type: "http_request",
    name: "External request",
    description: "Call an external API and save the response, then branch on success or error.",
    category: "Utilities",
    icon: "⇱",
    inputs: 1,
    outputs: [
      { key: "next", label: "On success" },
      { key: "onError", label: "On error" },
    ],
    addable: true,
  },
  go_to_flow: {
    type: "go_to_flow",
    name: "Go to flow",
    description: "Hand the contact off to another flow and end this one.",
    category: "Utilities",
    icon: "➔",
    inputs: 1,
    outputs: [],
    addable: true,
  },
  end: {
    type: "end",
    name: "End",
    description: "Close the run.",
    category: "Utilities",
    icon: "■",
    inputs: 1,
    outputs: [],
    addable: true,
  },
};

export const CATEGORY_ORDER: Category[] = [
  "Triggers",
  "Messaging",
  "Actions",
  "Conditions",
  "Utilities",
];

/** Accent per category, as CSS variables already defined by the design system. */
export const CATEGORY_ACCENT: Record<Category, string> = {
  Triggers: "var(--signal)",
  Messaging: "var(--signal)",
  Actions: "var(--burn)",
  Conditions: "var(--open)",
  Utilities: "var(--ink-soft)",
};

export function def(type: EditorNodeType): NodeDef {
  return NODE_DEFS[type];
}
