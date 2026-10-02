import type { Flow, FlowGraph, FlowNode, NodeType, TriggerType } from "./types";

export const NODE_LABEL: Record<NodeType, string> = {
  send_message: "Send message",
  wait_reply: "Wait for reply",
  check_follow: "Check follow",
  condition: "Branch on a value",
  delay: "Wait a while",
  collect: "Collect input",
  action: "Action",
  randomize: "Randomize",
  smart_delay: "Smart delay",
  http_request: "External request",
  go_to_flow: "Go to flow",
  end: "End",
};

/** Which node types pause a run. The engine cares; so does anyone reading the editor. */
export const PAUSES: Record<NodeType, boolean> = {
  send_message: false,
  wait_reply: true,
  check_follow: false,
  condition: false,
  delay: true,
  collect: true,
  action: false,
  randomize: false,
  smart_delay: true,
  http_request: false,
  go_to_flow: false,
  end: false,
};

/**
 * The reference flow from the build plan: comment, private reply, follow check, link.
 * New flows start here because this path exercises every part of the engine.
 */
export function referenceGraph(): FlowGraph {
  return {
    start: "n1",
    nodes: {
      n1: {
        type: "send_message",
        content: {
          text: "Thanks for commenting. Want the link?",
          buttons: [{ title: "Yes, send it", payload: "YES" }],
        },
        next: "n2",
      },
      n2: {
        type: "wait_reply",
        saveTo: "user_reply",
        timeoutSeconds: 3600,
        next: "n3",
        onTimeout: "n6",
      },
      n3: { type: "check_follow", onTrue: "n5", onFalse: "n4" },
      n4: {
        type: "send_message",
        content: { text: "Follow the account first, then reply DONE." },
        next: "n2",
      },
      n5: {
        type: "send_message",
        content: { text: "Here you go: https://example.com" },
        next: "n6",
      },
      n6: { type: "end" },
    },
  };
}

/** A brand-new "start from scratch" workflow: no first step yet, no nodes. */
export function emptyGraph(): FlowGraph {
  return { start: "", nodes: {} };
}

/**
 * Triggers whose first outbound message is a private reply, which does NOT open the 24-hour
 * window. For these the first step must be one plain message — a collect, delay or branch there
 * would never run, because a private reply is a single message and nothing follows until the
 * contact answers and opens the window.
 */
export const PRIVATE_REPLY_TRIGGERS: TriggerType[] = ["comment", "live_comment"];

export function newNodeId(graph: FlowGraph): string {
  const used = Object.keys(graph.nodes)
    .map((id) => Number(id.replace(/^n/, "")))
    .filter((n) => Number.isFinite(n));
  return `n${(used.length ? Math.max(...used) : 0) + 1}`;
}

export function blankNode(type: NodeType): FlowNode {
  switch (type) {
    case "send_message":
      return { type, content: { text: "" }, next: null };
    case "wait_reply":
      return { type, saveTo: "reply", timeoutSeconds: 3600, next: null, onTimeout: null };
    case "check_follow":
      return { type, onTrue: null, onFalse: null };
    case "condition":
      return { type, left: "state.reply", op: "eq", right: "", onTrue: null, onFalse: null };
    case "delay":
      return { type, seconds: 3600, next: null };
    case "action":
      return { type, actions: [{ kind: "add_tag", tag: "" }], next: null };
    case "randomize":
      return {
        type,
        branches: [
          { key: "b0", weight: 50 },
          { key: "b1", weight: 50 },
        ],
      } as FlowNode;
    case "smart_delay":
      return { type, delayMode: "duration", seconds: 3600, untilHour: 9, untilMinute: 0, next: null };
    case "http_request":
      return { type, method: "GET", url: "", headers: [], body: "", saveTo: "response", next: null, onError: null };
    case "go_to_flow":
      return { type, targetFlowId: "" };
    case "collect":
      return {
        type,
        inputType: "email",
        promptText: "What's your email?",
        saveTo: "email",
        quickReplies: [],
        retryMessage: "That doesn't look right. Please try again.",
        maxAttempts: 3,
        timeoutSeconds: 3600,
        skipEnabled: false,
        skipTitle: "Skip",
        next: null,
        onTimeout: null,
        onFailed: null,
      };
    case "end":
      return { type };
  }
}

/** Every outgoing edge of a node, labelled the way the editor shows it. */
export function exits(node: FlowNode): Array<{ key: keyof FlowNode; label: string }> {
  switch (node.type) {
    case "wait_reply":
      return [
        { key: "next", label: "On reply" },
        { key: "onTimeout", label: "On timeout" },
      ];
    case "collect":
      return [
        { key: "next", label: "On value" },
        { key: "onTimeout", label: "On timeout" },
        { key: "onFailed", label: "On give up" },
      ];
    case "check_follow":
      return [
        { key: "onTrue", label: "Follows" },
        { key: "onFalse", label: "Does not follow" },
      ];
    case "condition":
      return [
        { key: "onTrue", label: "True" },
        { key: "onFalse", label: "False" },
      ];
    case "http_request":
      return [
        { key: "next", label: "On success" },
        { key: "onError", label: "On error" },
      ];
    case "randomize": {
      const branches = node.branches?.length ? node.branches : [
        { key: "b0", weight: 50 },
        { key: "b1", weight: 50 },
      ];
      return branches.map((b, i) => ({
        key: b.key as keyof FlowNode,
        label: String.fromCharCode(65 + i), // A, B, C…
      }));
    }
    case "go_to_flow":
    case "end":
      return [];
    default:
      return [{ key: "next", label: "Then" }];
  }
}

/** Exit keys are a narrow set of optional string fields; assign through Object.assign. */
function setExit(node: FlowNode, key: keyof FlowNode, target: string | null): void {
  Object.assign(node, { [key]: target });
}

export function addNode(graph: FlowGraph, type: NodeType, afterId?: string): FlowGraph {
  const id = newNodeId(graph);
  const next: FlowGraph = { ...graph, nodes: { ...graph.nodes, [id]: blankNode(type) } };

  if (afterId && next.nodes[afterId]) {
    const parent = { ...next.nodes[afterId] };
    const primary = exits(parent)[0]?.key;
    if (primary) {
      const inherited = parent[primary] as string | null | undefined;
      if (inherited && next.nodes[id].type !== "end") {
        setExit(next.nodes[id], exits(next.nodes[id])[0]?.key ?? "next", inherited);
      }
      setExit(parent, primary, id);
      next.nodes[afterId] = parent;
    }
  }
  return next;
}

export function updateNode(graph: FlowGraph, id: string, patch: Partial<FlowNode>): FlowGraph {
  return { ...graph, nodes: { ...graph.nodes, [id]: { ...graph.nodes[id], ...patch } } };
}

/** Deleting a step hands its first exit to whoever pointed at it, so the path stays whole. */
export function deleteNode(graph: FlowGraph, id: string): FlowGraph {
  const doomed = graph.nodes[id];
  if (!doomed) return graph;

  const heir = (doomed[exits(doomed)[0]?.key ?? "next"] as string | null) ?? null;
  const nodes: Record<string, FlowNode> = {};

  for (const [nodeId, node] of Object.entries(graph.nodes)) {
    if (nodeId === id) continue;
    const copy: FlowNode = { ...node };
    for (const exit of exits(copy)) {
      if (copy[exit.key] === id) setExit(copy, exit.key, heir);
    }
    nodes[nodeId] = copy;
  }

  return { start: graph.start === id ? heir ?? Object.keys(nodes)[0] ?? "" : graph.start, nodes };
}

/** Depth-first walk from start, so the editor lists steps in the order a run meets them. */
export function orderedIds(graph: FlowGraph): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  const walk = (id?: string | null) => {
    if (!id || seen.has(id) || !graph.nodes[id]) return;
    seen.add(id);
    order.push(id);
    for (const exit of exits(graph.nodes[id])) walk(graph.nodes[id][exit.key] as string | null);
  };
  walk(graph.start);
  for (const id of Object.keys(graph.nodes)) if (!seen.has(id)) order.push(id);
  return order;
}

export interface Check {
  level: "error" | "warning";
  nodeId?: string;
  message: string;
}

/**
 * The rules Meta enforces silently. Catching them here beats discovering them as a message
 * that never arrives.
 */
export function checkFlow(flow: Flow): Check[] {
  const checks: Check[] = [];
  const graph = flow.graph;
  const nodes = graph?.nodes ?? {};

  if (!flow.trigger_type) {
    checks.push({ level: "error", message: "Choose a trigger before this can go live." });
  }

  if (!graph?.start || !nodes[graph.start]) {
    checks.push({ level: "error", message: "This flow has no first step." });
    return checks;
  }

  for (const [id, node] of Object.entries(nodes)) {
    for (const exit of exits(node)) {
      const target = node[exit.key] as string | null | undefined;
      if (target && !nodes[target]) {
        checks.push({
          level: "error",
          nodeId: id,
          message: `"${exit.label}" points at ${target}, which no longer exists.`,
        });
      }
    }
    if (node.type === "wait_reply" && (node.timeoutSeconds ?? 0) < 300) {
      checks.push({
        level: "warning",
        nodeId: id,
        message:
          "A person needs longer than this to answer. The run takes the timeout path and ends " +
          "before the reply arrives.",
      });
    }
    if (node.type === "delay" && (node.seconds ?? 0) > 24 * 3600) {
      checks.push({
        level: "error",
        nodeId: id,
        message: "A wait longer than 24 hours lands after the window closes. Nothing will send.",
      });
    }
    if (node.type === "collect") {
      if (!(node.saveTo ?? "").trim()) {
        checks.push({ level: "error", nodeId: id, message: "This collect step has no field to save into." });
      }
      const quicks = (node.quickReplies ?? []).filter((q) => q.trim());
      const total = quicks.length + (node.skipEnabled ? 1 : 0);
      if (total > 13) {
        checks.push({
          level: "error",
          nodeId: id,
          message: `Instagram shows at most 13 quick replies. This has ${quicks.length} option${quicks.length === 1 ? "" : "s"}${node.skipEnabled ? " plus a Skip button" : ""}.`,
        });
      }
      const long = quicks.find((q) => q.length > 20);
      if (long) {
        checks.push({ level: "error", nodeId: id, message: `Quick reply "${long}" is over 20 characters.` });
      }
      if (node.skipEnabled && (node.skipTitle ?? "").length > 20) {
        checks.push({ level: "error", nodeId: id, message: "The Skip button title is over 20 characters." });
      }
      if (node.inputType === "choice" && quicks.length === 0) {
        checks.push({ level: "warning", nodeId: id, message: "A choice question needs at least one option." });
      }
    }
  }

  // Triggers that answer with a private reply (comment, live comment) get exactly one message
  // before the contact must reply and open the 24-hour window.
  const first = nodes[graph.start];
  if (flow.trigger_type && PRIVATE_REPLY_TRIGGERS.includes(flow.trigger_type)) {
    if (first && first.type !== "send_message") {
      // A multi-block first step: a collect, delay or branch cannot run inside a single private
      // reply. This is the one the "Set live" button must block with a clear reason.
      checks.push({
        level: "error",
        nodeId: graph.start,
        message:
          `The first step of a ${flow.trigger_type === "comment" ? "comment" : "live comment"} ` +
          "flow must be a single message. The first reply is one private reply and does not open " +
          "the 24-hour window, so a " +
          `${NODE_LABEL[first.type].toLowerCase()} here would never run. Start with a message ` +
          "that asks a question or offers a reply button, then add the rest after it.",
      });
    } else if (first?.type === "send_message") {
      // A single message is right, but it still has to be answerable — otherwise nothing follows.
      // A button that opens a link leaves Instagram without opening the window, so it does not count.
      const opensWindow = (first.content?.buttons ?? []).some((b) => !b.url);
      const asksSomething = (first.content?.text ?? "").includes("?");
      if (!opensWindow && !asksSomething) {
        checks.push({
          level: "error",
          nodeId: graph.start,
          message:
            "The first message needs a question or a button that replies. A private reply does " +
            "not open the 24-hour window on its own, and a link button leaves Instagram without " +
            "opening it, so nothing after this step can send.",
        });
      }
    }
  }

  for (const [id, node] of Object.entries(nodes)) {
    if ((node.content?.buttons ?? []).length > 3) {
      checks.push({
        level: "error",
        nodeId: id,
        message: "Instagram shows at most three buttons on a message.",
      });
    }
  }

  // Meta rejects a follow check until the contact has messaged us at least once.
  const queue: Array<{ id: string; replied: boolean }> = [{ id: graph.start, replied: false }];
  const visited = new Set<string>();
  while (queue.length) {
    const { id, replied } = queue.shift()!;
    const key = `${id}:${replied}`;
    if (visited.has(key) || !nodes[id]) continue;
    visited.add(key);

    const node = nodes[id];
    if (node.type === "check_follow" && !replied) {
      checks.push({
        level: "warning",
        nodeId: id,
        message: "Meta rejects a follow check before the contact has replied. Wait for a reply first.",
      });
    }
    const nowReplied = replied || node.type === "wait_reply";
    for (const exit of exits(node)) {
      const target = node[exit.key] as string | null | undefined;
      if (target) queue.push({ id: target, replied: nowReplied });
    }
  }

  const reachable = new Set(orderedIds({ ...graph, nodes }).slice(0, Object.keys(nodes).length));
  const walked = new Set<string>();
  const walk = (id?: string | null) => {
    if (!id || walked.has(id) || !nodes[id]) return;
    walked.add(id);
    for (const exit of exits(nodes[id])) walk(nodes[id][exit.key] as string | null);
  };
  walk(graph.start);
  for (const id of Object.keys(nodes)) {
    if (!walked.has(id) && reachable.has(id)) {
      checks.push({ level: "warning", nodeId: id, message: "No step leads here." });
    }
  }

  return checks;
}

export function triggerSummary(flow: Flow): string {
  if (!flow.trigger_type) return "No trigger yet — pick one to go live";
  const config = flow.trigger_config ?? {};
  const keywords = (config.keywords ?? []).filter(Boolean);
  const words = keywords.length ? keywords.join(", ") : "any text";
  switch (flow.trigger_type) {
    case "comment":
      return config.mediaId ? `Comment on ${config.mediaId} — ${words}` : `Comment on any post — ${words}`;
    case "keyword":
      return `Direct message — ${words}`;
    case "story_reply":
      return `Story reply — ${words}`;
    case "story_mention":
      return "Story mention";
    case "share_to_dm":
      return "Reshare of your post";
    case "live_comment":
      return config.broadcastId ? `Live comment on ${config.broadcastId} — ${words}` : `Live comment — ${words}`;
    case "ref_url":
      return config.ref ? `ig.me ref = ${config.ref}` : "ig.me ref link — any ref";
    case "default_reply":
      return config.excludeStoryReplies ? "Any other message (not story replies)" : "Any other message";
    default:
      return String(flow.trigger_type);
  }
}
