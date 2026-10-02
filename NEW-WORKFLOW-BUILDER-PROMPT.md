# Prompt — "New Workflow" Modal + Free-Assembly Builder

One task prompt. It builds the ManyChat-style entry experience: clicking **New Workflow**
opens a template picker with a **Start From Scratch** option, and either path lands in a
builder where every node is available to assemble freely.

> Paste the **Shared Context** block (from TRIGGER-PROMPTS.md) above this prompt.
> Prerequisite: **Task 0 (Trigger Registry)** must already exist — this feature reads the
> trigger list and each trigger's config schema from that registry.

---

```
GOAL
When the user clicks "New Workflow", open a template-picker modal. From it they either pick a
template or click "Start From Scratch". Both paths open a builder where all node types are
available from a palette and can be assembled and configured freely. Everything is data-driven
so adding a template or a node type never requires touching this UI.

────────────────────────────────────────────────────────
PART A — THE TEMPLATE PICKER MODAL
────────────────────────────────────────────────────────
Layout (match the intent, not the exact pixels of ManyChat):
- Header: title "Templates" + a primary "Start From Scratch" button + a close button.
- Search box: filters template cards by title/description.
- Left rail with two filter groups:
    "By goal"    -> Grow followers, Engage audience, Drive traffic
    "By trigger" -> Post or Reel comment, DM, Story reply, Live comment, ...
      (this list is generated from the trigger registry, NOT hardcoded)
- Main area: template cards grouped as "Recommended" and "Discover more".
  Each card shows: title, one-line description, a trigger-type chip, an optional badge
  (e.g. POPULAR), and it is clickable.

Cards and filters come from a templates source (PART D). The modal renders whatever templates
exist; it has no per-template code.

Behaviour:
- Clicking a card  -> PART C with that template loaded.
- "Start From Scratch" -> PART C with an empty workflow.
- Search + filters narrow the visible cards client-side.

────────────────────────────────────────────────────────
PART B — WHAT A WORKFLOW IS
────────────────────────────────────────────────────────
A workflow is a `flow` row:
  { name, status: 'draft', trigger_type, trigger_config jsonb, graph jsonb }
- graph is the node document: { "start": <nodeId|null>, "nodes": { <id>: {...} } }
- A brand-new "from scratch" workflow is created as a draft with trigger_type = null and an
  empty graph. It cannot be set live until a trigger is chosen and the graph validates.
- Choosing a template DEEP-CLONES that template's trigger_type, trigger_config skeleton, and
  graph into the new draft. The template itself is never mutated.

────────────────────────────────────────────────────────
PART C — THE BUILDER (free assembly)
────────────────────────────────────────────────────────
Three regions:

1) TRIGGER STEP (top / start of the flow)
   - Always the first thing in a workflow. If trigger_type is null (from scratch), show a
     trigger picker listing every trigger from the registry.
   - Once chosen, render that trigger's config form from its registry configSchema
     (e.g. comment trigger -> pick post + keyword rules; keyword DM -> keyword rules).
   - Changing the trigger is allowed while draft; warn if it invalidates existing nodes.

2) NODE PALETTE (add any node)
   - Lists EVERY node type from a node registry (parallel to the trigger registry), so a new
     node type appears here automatically with zero UI changes.
   - Node types available now:
        send_message   text / image / buttons / quick replies
        collect        typed input with validation (email, phone, text, number, url, choice)
        check_follow   branch on whether the contact follows the account
        condition      branch on a state variable or a contact field
        delay          wait, then continue
        end            close the run
        (reserve slots for: action (tag / set field), ai_step, external_request — they
         register the same way when built)
   - Adding a node inserts it into graph.nodes with a generated id and default config.

3) CANVAS / STEP LIST (assemble + connect)
   - Represent the graph visually. A vertical step list with explicit branch sections is
     acceptable for the MVP — a full free-form drag canvas is NOT required, as long as
     branching nodes (check_follow, condition) can point each branch to any node.
   - Selecting a node opens a config panel driven by that node's schema.
   - Support: add, delete, reorder/relink, and set each node's `next` (and branch targets
     onTrue/onFalse, onTimeout, onFailed where the node defines them).
   - Autosave the graph to flow.graph as JSONB on every change (debounced).

────────────────────────────────────────────────────────
PART D — TEMPLATES AS DATA (not code)
────────────────────────────────────────────────────────
Store templates in a `flow_template` table (or a seeded JSON registry):
  { id, name, description, goal, trigger_type, badge, recommended bool,
    trigger_config jsonb, graph jsonb }
Adding a template = inserting a row. The modal and the "By trigger"/"By goal" filters derive
entirely from these rows plus the trigger registry.

Seed these starter templates so the picker is not empty (each is just a trigger + a graph):
  - "Auto-DM links from comments"  (trigger: comment)  POPULAR
  - "Grow followers from comments" (trigger: comment; includes a check_follow gate)
  - "Generate leads with stories"  (trigger: story_reply; includes a collect node)
  - "Respond to all your DMs"      (trigger: default_reply)
  - "Auto-reply to keyword in DM"  (trigger: keyword)

────────────────────────────────────────────────────────
PART E — VALIDATION BEFORE GOING LIVE
────────────────────────────────────────────────────────
Block "Set live" (with clear inline errors) unless:
  - a trigger is chosen and its required config is filled
  - the graph has a start node and every branch resolves to an existing node or `end`
  - Instagram limits hold: <= 3 buttons per message, <= 13 quick replies (incl. any skip),
    text <= 1000 bytes (<= 640 chars when the message has buttons)
  - if trigger_type is a comment/live/share trigger, the FIRST message node is a single
    content block (text or image with buttons/quick replies) — no collect, no delay in it,
    because the first private reply is one message and does not open the 24h window

────────────────────────────────────────────────────────
ACCEPTANCE CRITERIA
────────────────────────────────────────────────────────
- Clicking "New Workflow" opens the modal with seeded templates, search, and both filter
  groups populated from data.
- "Start From Scratch" opens the builder with a trigger picker and an empty graph; the node
  palette lists every registered node type.
- Picking "Grow followers from comments" opens the builder pre-filled with its trigger and a
  graph that already contains a check_follow gate, as an editable copy.
- I can add, configure, connect, and delete nodes freely and the graph autosaves to
  flow.graph.
- Adding a hypothetical new template row makes it appear in the picker with no UI code change.
- Adding a hypothetical new node type to the node registry makes it appear in the palette with
  no UI code change.
- "Set live" is blocked with a specific message when a comment-trigger flow starts with a
  multi-block first message.
```

---

## Note on scope

Keep the canvas simple. A **vertical step list with branch sections** reaches the same result
as ManyChat's drag canvas in a fraction of the time, and the user cannot tell the difference in
outcome. Build the drag-and-drop canvas later, only if it becomes a selling point — the data
model (`graph` JSONB) is identical either way, so upgrading the canvas never touches the engine.
