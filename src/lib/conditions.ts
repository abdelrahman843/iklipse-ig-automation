// Contact conditions: the Contacts filter, saved segments and broadcast audiences all use these.
// The database function contact_matches (migration 23) is the one place they are evaluated.

import { supabase } from "./supabase";

export type ConditionField = "tag" | "custom" | "subscribed" | "last_seen" | "created" | "assigned" | "status" | "follows";

export interface Condition {
  field: ConditionField;
  op: string;
  value?: string;
  /** custom: the field key. */
  key?: string;
}

/** What kind of value a condition takes, which decides the input the builder shows. */
export type ValueKind = "tag" | "text" | "days" | "agent" | "choice";

export interface FieldDef {
  field: ConditionField;
  label: string;
  ops: { op: string; label: string; noValue?: boolean }[];
  value: ValueKind;
  choices?: { value: string; label: string }[];
}

const DAY_OPS = [
  { op: "within", label: "in the last" },
  { op: "older", label: "more than" },
];

export const FIELDS: FieldDef[] = [
  { field: "tag", label: "Tag", ops: [{ op: "is", label: "is" }, { op: "is_not", label: "is not" }], value: "tag" },
  {
    field: "custom",
    label: "Custom field",
    ops: [
      { op: "is", label: "is" },
      { op: "is_not", label: "is not" },
      { op: "contains", label: "contains" },
      { op: "empty", label: "is empty", noValue: true },
      { op: "not_empty", label: "is not empty", noValue: true },
    ],
    value: "text",
  },
  {
    field: "subscribed",
    label: "Subscribed to broadcasts",
    ops: [{ op: "is", label: "is" }],
    value: "choice",
    choices: [
      { value: "yes", label: "Yes" },
      { value: "no", label: "No (sent STOP or unsubscribed)" },
    ],
  },
  { field: "last_seen", label: "Last interaction", ops: DAY_OPS, value: "days" },
  { field: "created", label: "Contact since", ops: DAY_OPS, value: "days" },
  { field: "assigned", label: "Assigned to", ops: [{ op: "is", label: "is" }, { op: "is_not", label: "is not" }], value: "agent" },
  {
    field: "status",
    label: "Conversation",
    ops: [{ op: "is", label: "is" }],
    value: "choice",
    choices: [
      { value: "open", label: "Open" },
      { value: "done", label: "Closed" },
    ],
  },
  {
    field: "follows",
    label: "Follows you",
    ops: [{ op: "is", label: "is" }],
    value: "choice",
    choices: [
      { value: "yes", label: "Yes" },
      { value: "no", label: "No" },
      { value: "unknown", label: "Unknown" },
    ],
  },
];

export const fieldDef = (f: ConditionField) => FIELDS.find((d) => d.field === f) ?? FIELDS[0];

/** A condition is complete when it names everything its operator needs. */
export function isComplete(c: Condition): boolean {
  const def = fieldDef(c.field);
  if (c.field === "custom" && !c.key) return false;
  if (def.ops.find((o) => o.op === c.op)?.noValue) return true;
  if (def.value === "days") return /^\d{1,5}$/.test(c.value ?? "");
  if (def.value === "agent") return c.value !== undefined;
  return Boolean(c.value);
}

/** "Tag" "is" "VIP", "email" "contains" "gmail", "Last interaction" "in the last" "7 days". */
export function describe(c: Condition): { subject: string; op: string; value: string } {
  const def = fieldDef(c.field);
  const op = def.ops.find((o) => o.op === c.op);
  const subject = c.field === "custom" ? c.key ?? "Field" : def.label;
  if (op?.noValue) return { subject, op: op.label, value: "" };
  let value = c.value ?? "";
  if (def.value === "days") value = `${value} day${value === "1" ? "" : "s"}${c.op === "older" ? " ago" : ""}`;
  else if (def.value === "agent") value = value || "nobody";
  else if (def.choices) value = def.choices.find((x) => x.value === value)?.label.replace(/ \(.*\)$/, "") ?? value;
  return { subject, op: op?.label ?? c.op, value };
}

/** Contacts matching the conditions and search, as a query that can still be ordered and paged. */
export function matchContacts(conditions: Condition[], search = "", opts?: { count?: "exact" }) {
  return supabase.rpc("match_contacts", { p_conditions: conditions.filter(isComplete), p_search: search.trim() }, opts);
}

/** Every matching contact id, read a page at a time (the API returns at most 1000 rows per call). */
export async function matchingIds(conditions: Condition[], search = ""): Promise<string[]> {
  const out: string[] = [];
  for (let from = 0; from < 50_000; from += 1000) {
    const { data, error } = await matchContacts(conditions, search).select("id").order("created_at").range(from, from + 999);
    if (error) throw error;
    const rows = (data ?? []) as { id: string }[];
    out.push(...rows.map((r) => r.id));
    if (rows.length < 1000) break;
  }
  return out;
}
