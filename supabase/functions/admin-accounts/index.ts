// Account administration. The only way an account comes to exist: public sign-up is off.
//
// Called by the n8n "Iklipse accounts" workflow with the shared secret in the x-admin-key header
// (ADMIN_API_KEY). Never called from the panel.
//
// POST { action: "create", workspace: "Acme", username?: "acme" }
//      -> a new workspace, a login that owns it, and a generated password. The password is
//         returned this once and stored nowhere (Supabase Auth keeps only its hash).
// POST { action: "reset_password", username }      -> a new generated password, shown once
// POST { action: "disable" | "enable", username }  -> block / unblock signing in
// POST { action: "list" }                          -> every workspace with its login and account
//
// A login is a username. Supabase Auth needs an email, so each one is stored as
// <username>@LOGIN_DOMAIN, a reserved ".invalid" domain no mail can ever reach.

import { db, json } from "../_shared/db.ts";
import { ADMIN_API_KEY, APP_URL, LOGIN_DOMAIN } from "../_shared/env.ts";
import { safeEqual } from "../_shared/auth.ts";

type Row = Record<string, any>;
const sql = db();

const USERNAME = /^[a-z0-9][a-z0-9._]{2,29}$/;
// No look-alikes (0/O, 1/l/I), so a password read off a screen is typed right the first time.
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
const PASSWORD_LENGTH = 16;
const BAN_FOREVER = "876000h"; // 100 years

class BadRequest extends Error {}

function password(): string {
  const out: string[] = [];
  // Rejection sampling keeps every character equally likely.
  while (out.length < PASSWORD_LENGTH) {
    for (const b of crypto.getRandomValues(new Uint8Array(32))) {
      if (b < 256 - (256 % ALPHABET.length) && out.length < PASSWORD_LENGTH) out.push(ALPHABET[b % ALPHABET.length]);
    }
  }
  // Groups of four read and type easily: abcd-efgh-ijkl-mnop.
  return out.join("").match(/.{4}/g)!.join("-");
}

/** "Acme Store!" -> "acme.store" */
function slug(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s.]/g, "")
    .trim()
    .replace(/[\s_]+/g, ".")
    .replace(/[^a-z0-9.]/g, "")
    .replace(/\.{2,}/g, ".")
    .replace(/^\.+|\.+$/g, "")
    .slice(0, 24);
}

async function usernameTaken(username: string): Promise<boolean> {
  const { data } = await sql.from("workspace_member").select("user_id").eq("username", username).maybeSingle();
  return Boolean(data);
}

/** The requested username, or one made from the workspace name, free and valid. */
async function pickUsername(requested: string | undefined, workspace: string): Promise<string> {
  if (requested?.trim()) {
    const u = requested.trim().toLowerCase().replace(/^@/, "");
    if (!USERNAME.test(u)) {
      throw new BadRequest(
        "Username must be 3-30 characters: lowercase letters, numbers, dots or underscores, starting with a letter or number.",
      );
    }
    if (await usernameTaken(u)) throw new BadRequest(`The username "${u}" is taken.`);
    return u;
  }
  let base = slug(workspace);
  if (base.length < 3) base = `workspace${base}`;
  if (!(await usernameTaken(base))) return base;
  for (let i = 0; i < 20; i++) {
    const candidate = `${base}${Math.floor(100 + Math.random() * 900)}`;
    if (!(await usernameTaken(candidate))) return candidate;
  }
  throw new Error("Could not find a free username; pass one explicitly.");
}

function loginUrl(): string {
  return APP_URL().replace(/\/*$/, "/");
}

async function create(body: Row): Promise<Response> {
  const name = String(body.workspace ?? body.name ?? "").trim();
  if (!name) throw new BadRequest("A workspace name is required.");
  if (name.length > 80) throw new BadRequest("The workspace name is longer than 80 characters.");
  const username = await pickUsername(body.username, name);
  const pass = password();

  const { data: created, error: userErr } = await sql.auth.admin.createUser({
    email: `${username}@${LOGIN_DOMAIN()}`,
    password: pass,
    email_confirm: true,
    user_metadata: { username },
  });
  if (userErr || !created?.user) throw new Error(`Could not create the login: ${userErr?.message ?? "unknown error"}`);
  const userId = created.user.id;

  // The login exists; undo it if its workspace can't be made, so nothing is left half-created.
  try {
    const { data: ws, error: wsErr } = await sql.from("workspace").insert({ name }).select("id, name").single();
    if (wsErr) throw new Error(`Could not create the workspace: ${wsErr.message}`);
    const { error: mErr } = await sql
      .from("workspace_member")
      .insert({ workspace_id: ws.id, user_id: userId, username, role: "owner" });
    if (mErr) {
      await sql.from("workspace").delete().eq("id", ws.id);
      throw new Error(`Could not link the login to its workspace: ${mErr.message}`);
    }
    return json({
      created: true,
      workspace: ws.name,
      workspace_id: ws.id,
      username,
      password: pass,
      login_url: loginUrl(),
      note: "Shown once. The password is not stored anywhere; reset it if it is lost.",
    });
  } catch (err) {
    await sql.auth.admin.deleteUser(userId);
    throw err;
  }
}

async function memberByUsername(raw: unknown): Promise<Row> {
  const username = String(raw ?? "").trim().toLowerCase().replace(/^@/, "");
  if (!username) throw new BadRequest("A username is required.");
  const { data } = await sql
    .from("workspace_member")
    .select("user_id, username, workspace_id")
    .eq("username", username)
    .maybeSingle();
  if (!data) throw new BadRequest(`No login is called "${username}".`);
  return data;
}

async function resetPassword(body: Row): Promise<Response> {
  const m = await memberByUsername(body.username);
  const pass = password();
  const { error } = await sql.auth.admin.updateUserById(m.user_id, { password: pass });
  if (error) throw new Error(`Could not reset the password: ${error.message}`);
  // Sign the login out everywhere: whoever had the old password loses access now.
  await sql.rpc("revoke_sessions", { p_user: m.user_id });
  return json({
    reset: true,
    username: m.username,
    password: pass,
    login_url: loginUrl(),
    note: "Shown once. Every device signed in with the old password is signed out.",
  });
}

async function setBlocked(body: Row, blocked: boolean): Promise<Response> {
  const m = await memberByUsername(body.username);
  const { error } = await sql.auth.admin.updateUserById(m.user_id, { ban_duration: blocked ? BAN_FOREVER : "none" });
  if (error) throw new Error(`Could not ${blocked ? "disable" : "enable"} the login: ${error.message}`);
  if (blocked) await sql.rpc("revoke_sessions", { p_user: m.user_id });
  return json({ username: m.username, disabled: blocked });
}

async function list(): Promise<Response> {
  const [{ data: workspaces }, { data: members }, { data: accounts }] = await Promise.all([
    sql.from("workspace").select("id, name, created_at").order("created_at"),
    sql.from("workspace_member").select("workspace_id, user_id, username, role"),
    sql.from("ig_account").select("workspace_id, username, status").neq("status", "disconnected"),
  ]);
  const { data: users } = await sql.auth.admin.listUsers({ perPage: 1000 });
  const userOf = new Map((users?.users ?? []).map((u) => [u.id, u]));
  return json({
    workspaces: (workspaces ?? []).map((w: Row) => ({
      name: w.name,
      id: w.id,
      created_at: w.created_at,
      logins: (members ?? [])
        .filter((m: Row) => m.workspace_id === w.id)
        .map((m: Row) => {
          const u = userOf.get(m.user_id);
          const banned = u?.banned_until && new Date(u.banned_until).getTime() > Date.now();
          return { username: m.username, role: m.role, disabled: Boolean(banned), last_sign_in_at: u?.last_sign_in_at ?? null };
        }),
      instagram: (accounts ?? [])
        .filter((a: Row) => a.workspace_id === w.id)
        .map((a: Row) => ({ username: a.username, status: a.status }))[0] ?? null,
    })),
  });
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let key: string;
  try {
    key = ADMIN_API_KEY();
  } catch {
    return json({ error: "ADMIN_API_KEY is not set on the server." }, 503);
  }
  if (!safeEqual(req.headers.get("x-admin-key") ?? "", key)) return json({ error: "Forbidden" }, 403);

  let body: Row;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  try {
    switch (body.action) {
      case "create":
        return await create(body);
      case "reset_password":
        return await resetPassword(body);
      case "disable":
        return await setBlocked(body, true);
      case "enable":
        return await setBlocked(body, false);
      case "list":
        return await list();
      default:
        return json({ error: 'Unknown action. Use "create", "reset_password", "disable", "enable" or "list".' }, 400);
    }
  } catch (err) {
    if (err instanceof BadRequest) return json({ error: err.message }, 400);
    console.error("admin-accounts failed:", err);
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
