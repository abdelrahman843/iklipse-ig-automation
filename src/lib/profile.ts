// Instagram settings: what the messenger-profile function stores and how the panel saves it.

import { errorText, supabase } from "./supabase";
import { emptyGraph } from "./graph";
import type { TriggerType } from "./types";

export interface Starter {
  question: string;
  /** "FLOW:<id>" — a tap runs that automation. */
  payload: string;
}

export interface MenuEntry {
  title: string;
  type: "postback" | "web_url";
  payload?: string;
  url?: string;
}

export interface OptSetting {
  enabled: boolean;
  keywords: string[];
  reply: string;
}

export interface Profile {
  ice_breakers: Starter[];
  persistent_menu: MenuEntry[];
  ice_enabled: boolean;
  menu_enabled: boolean;
  opt_in: OptSetting;
  opt_out: OptSetting;
}

export const FLOW_PAYLOAD = "FLOW:";
export const flowOf = (payload?: string) => (payload?.startsWith(FLOW_PAYLOAD) ? payload.slice(FLOW_PAYLOAD.length) : null);

export async function loadProfile(): Promise<Profile> {
  const { data, error } = await supabase.from("messenger_profile").select("*").eq("id", 1).maybeSingle();
  if (error) throw error;
  return {
    ice_breakers: data?.ice_breakers ?? [],
    persistent_menu: data?.persistent_menu ?? [],
    ice_enabled: data?.ice_enabled ?? true,
    menu_enabled: data?.menu_enabled ?? true,
    opt_in: data?.opt_in ?? { enabled: true, keywords: ["start", "subscribe"], reply: "" },
    opt_out: data?.opt_out ?? { enabled: true, keywords: ["stop", "unsubscribe"], reply: "" },
  };
}

/** POST to the messenger-profile function; throws its error message. */
export async function saveProfile(body: Record<string, unknown>): Promise<void> {
  const { data } = await supabase.auth.getSession();
  const bearer = data.session?.access_token ?? (import.meta.env.VITE_SUPABASE_ANON_KEY as string);
  let res: Response;
  try {
    res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/messenger-profile`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${bearer}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    throw new Error(errorText(err) === "Failed to fetch" ? "Can't reach the server. The messenger-profile function may not be deployed." : errorText(err));
  }
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out.error ?? "Could not save");
}

/** Make an empty automation (optionally with a trigger) and return its id. */
export async function createFlow(name: string, trigger: TriggerType | null = null): Promise<string> {
  const { data, error } = await supabase
    .from("flow")
    .insert({ name, status: "draft", trigger_type: trigger, trigger_config: {}, graph: emptyGraph() })
    .select("id")
    .single();
  if (error) throw error;
  return data.id as string;
}

/** How many times each starter / menu payload was tapped. */
export async function tapCounts(payloads: string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  await Promise.all(
    [...new Set(payloads.filter(Boolean))].map(async (p) => {
      const { count } = await supabase
        .from("message")
        .select("id", { count: "exact", head: true })
        .eq("direction", "in")
        .eq("payload->>payload", p);
      out[p] = count ?? 0;
    }),
  );
  return out;
}
