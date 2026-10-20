// Instagram settings: Conversation Starters (ice breakers), the Main Menu (persistent menu), and
// the Opt-in / Opt-out system keywords.
//
// GET  -> the stored config, so the panel can show it.
// POST -> { section: "starters" | "menu" | "opt", ... }. Starters and the menu are written to
//         Meta's Messenger Profile API (switched off or emptied = deleted there) and a copy is
//         stored; the opt keywords live only here (process-events reads them).
// A tap on a starter or a menu item arrives on messaging_postbacks carrying "FLOW:<id>", and
// process-events runs that automation.
//
// Instagram limits: at most 4 starters (80 characters each); the menu takes up to 20 items,
// postback or web_url, one level; the Messenger Profile API allows 10 calls / 10 min, so the
// panel saves on demand, not on keystroke.

import { db, json } from "../_shared/db.ts";
import { deleteMessengerProfile, setMessengerProfile } from "../_shared/meta.ts";
import { requireMember } from "../_shared/auth.ts";
import { type Credentials, credentialsFor, NoAccountError } from "../_shared/account.ts";
import { withCors } from "../_shared/cors.ts";

const cors = {
  "access-control-allow-headers": "authorization, content-type",
  "access-control-allow-methods": "GET, POST, OPTIONS",
};

interface IceBreaker {
  question: string;
  payload: string;
}
interface MenuItem {
  title: string;
  type: "postback" | "web_url";
  payload?: string;
  url?: string;
}
interface OptSetting {
  enabled: boolean;
  keywords: string[];
  reply: string;
}

const MAX_STARTERS = 4;
const MAX_MENU = 20;

Deno.serve(async (req) => withCors(req, await handle(req)));

async function handle(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  const sql = db();
  const member = await requireMember(req, sql, cors);
  if (member instanceof Response) return member;
  const ws = member.workspaceId;

  if (req.method === "GET") {
    const { data } = await sql.from("messenger_profile").select("*").eq("workspace_id", ws).maybeSingle();
    return json(data ?? { ice_breakers: [], persistent_menu: [] }, 200, cors);
  }

  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405, cors);

  let body: Record<string, any>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400, cors);
  }

  try {
    switch (body.section) {
      case "starters":
        return await saveStarters({ sql, ws, creds: () => credentialsFor(ws) }, body);
      case "menu":
        return await saveMenu({ sql, ws, creds: () => credentialsFor(ws) }, body);
      case "opt":
        return await saveOpt({ sql, ws, creds: () => credentialsFor(ws) }, body);
      default:
        return json({ error: "Unknown section" }, 400, cors);
    }
  } catch (err) {
    if (err instanceof NoAccountError) return json({ error: err.message }, 409, cors);
    console.error("messenger-profile write failed:", err);
    return json({ error: err instanceof Error ? err.message : String(err) }, 502, cors);
  }
}

type Db = ReturnType<typeof db>;

/** One request's workspace: its rows, and its Instagram account (read only when Meta is called). */
interface Ctx {
  sql: Db;
  ws: string;
  creds: () => Promise<Credentials>;
}

const FLOW_PAYLOAD = "FLOW:";

/** A starter or menu item may only run an automation of this workspace. */
async function foreignFlow(ctx: Ctx, payloads: string[]): Promise<string | null> {
  const ids = payloads.filter((p) => p.startsWith(FLOW_PAYLOAD)).map((p) => p.slice(FLOW_PAYLOAD.length));
  if (!ids.length) return null;
  const { data } = await ctx.sql.from("flow").select("id").eq("workspace_id", ctx.ws).in("id", ids);
  const own = new Set((data ?? []).map((f: { id: string }) => f.id));
  return ids.find((id) => !own.has(id)) ?? null;
}

/** Whether Instagram currently shows this field, so switching off only deletes what exists. */
async function wasLive(ctx: Ctx, field: string, flag: string): Promise<boolean> {
  const { data } = await ctx.sql.from("messenger_profile").select(`${field}, ${flag}`).eq("workspace_id", ctx.ws).maybeSingle();
  const row = (data ?? {}) as Record<string, unknown>;
  return row[flag] !== false && Array.isArray(row[field]) && (row[field] as unknown[]).length > 0;
}

async function saveStarters(ctx: Ctx, body: Record<string, any>): Promise<Response> {
  const enabled = body.enabled !== false;
  const ice = ((body.ice_breakers ?? []) as IceBreaker[])
    .map((i) => ({ question: String(i.question ?? "").trim(), payload: String(i.payload ?? "").trim() }))
    .filter((i) => i.question);
  if (ice.length > MAX_STARTERS) return json({ error: "Instagram allows at most 4 conversation starters." }, 400, cors);
  const long = ice.find((i) => i.question.length > 80);
  if (long) return json({ error: `"${long.question.slice(0, 30)}…" is longer than 80 characters.` }, 400, cors);
  const unlinked = ice.find((i) => !i.payload);
  if (unlinked) return json({ error: `"${unlinked.question}" has no reply yet.` }, 400, cors);
  if (await foreignFlow(ctx, ice.map((i) => i.payload))) return json({ error: "A starter points to an automation that doesn't exist." }, 400, cors);

  if (enabled && ice.length) {
    await setMessengerProfile(await ctx.creds(), {
      platform: "instagram",
      ice_breakers: [{ locale: "default", call_to_actions: ice }],
    });
  } else if (await wasLive(ctx, "ice_breakers", "ice_enabled")) {
    await deleteMessengerProfile(await ctx.creds(), ["ice_breakers"]);
  }
  await ctx.sql
    .from("messenger_profile")
    .update({ ice_breakers: ice, ice_enabled: enabled, updated_at: new Date().toISOString() })
    .eq("workspace_id", ctx.ws);
  return json({ saved: true }, 200, cors);
}

async function saveMenu(ctx: Ctx, body: Record<string, any>): Promise<Response> {
  const enabled = body.enabled !== false;
  const menu = ((body.persistent_menu ?? []) as MenuItem[]).filter((m) => m.title?.trim());
  if (menu.length > MAX_MENU) return json({ error: "The menu takes at most 20 items." }, 400, cors);
  const badType = menu.find((m) => m.type !== "postback" && m.type !== "web_url");
  if (badType) return json({ error: "Menu items must run an automation or open a link." }, 400, cors);
  const badUrl = menu.find((m) => m.type === "web_url" && !/^https?:\/\//i.test(m.url ?? ""));
  if (badUrl) return json({ error: `"${badUrl.title}" needs a link starting with https://` }, 400, cors);
  const unlinked = menu.find((m) => m.type === "postback" && !m.payload?.trim());
  if (unlinked) return json({ error: `"${unlinked.title}" has no reply yet.` }, 400, cors);
  if (await foreignFlow(ctx, menu.map((m) => m.payload ?? ""))) return json({ error: "A menu item points to an automation that doesn't exist." }, 400, cors);

  if (enabled && menu.length) {
    await setMessengerProfile(await ctx.creds(), {
      platform: "instagram",
      persistent_menu: [
        {
          locale: "default",
          call_to_actions: menu.map((m) =>
            m.type === "web_url"
              ? { type: "web_url", title: m.title.trim(), url: m.url!.trim() }
              : { type: "postback", title: m.title.trim(), payload: m.payload!.trim() },
          ),
        },
      ],
    });
  } else if (await wasLive(ctx, "persistent_menu", "menu_enabled")) {
    await deleteMessengerProfile(await ctx.creds(), ["persistent_menu"]);
  }
  await ctx.sql
    .from("messenger_profile")
    .update({ persistent_menu: menu, menu_enabled: enabled, updated_at: new Date().toISOString() })
    .eq("workspace_id", ctx.ws);
  return json({ saved: true }, 200, cors);
}

function cleanOpt(o: Partial<OptSetting> | undefined, fallback: string[]): OptSetting {
  const keywords = [...new Set((o?.keywords ?? fallback).map((k) => String(k).trim().toLowerCase()).filter(Boolean))];
  return { enabled: o?.enabled !== false, keywords: keywords.length ? keywords : fallback, reply: String(o?.reply ?? "").slice(0, 1000) };
}

async function saveOpt(ctx: Ctx, body: Record<string, any>): Promise<Response> {
  const opt_out = cleanOpt(body.opt_out, ["stop", "unsubscribe"]);
  const opt_in = cleanOpt(body.opt_in, ["start", "subscribe"]);
  const clash = opt_out.keywords.find((k) => opt_in.keywords.includes(k));
  if (clash) return json({ error: `"${clash}" can't both opt in and opt out.` }, 400, cors);
  await ctx.sql
    .from("messenger_profile")
    .update({ opt_out, opt_in, updated_at: new Date().toISOString() })
    .eq("workspace_id", ctx.ws);
  return json({ saved: true }, 200, cors);
}
