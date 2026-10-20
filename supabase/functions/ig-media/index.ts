// Lists the workspace's connected account's recent posts, so the comment trigger can pick a post instead of
// pasting a numeric media id. Reads through the workspace's server-side token; the token
// never touches the browser. GET only.

import { db, json } from "../_shared/db.ts";
import { requireMember } from "../_shared/auth.ts";
import { withCors } from "../_shared/cors.ts";
import { credentialsFor } from "../_shared/account.ts";
import { GRAPH_BASE } from "../_shared/env.ts";

const cors = {
  "access-control-allow-headers": "authorization, content-type",
  "access-control-allow-methods": "GET, OPTIONS",
};

Deno.serve(async (req) => withCors(req, await handle(req)));

async function handle(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "GET") return json({ error: "Method not allowed" }, 405, cors);
  const member = await requireMember(req, db(), cors);
  if (member instanceof Response) return member;

  let creds;
  try {
    creds = await credentialsFor(member.workspaceId);
  } catch {
    return json({ error: "No Instagram account connected yet." }, 400, cors);
  }

  const fields = "id,caption,media_type,media_url,thumbnail_url,permalink,timestamp";
  const url = `${GRAPH_BASE()}/${creds.igUserId}/media?fields=${fields}&limit=50`;

  try {
    const res = await fetch(url, { headers: { authorization: `Bearer ${creds.token}` } });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = (body as { error?: { message?: string } }).error?.message ?? `Graph API ${res.status}`;
      return json({ error: msg }, res.status, cors);
    }
    // Only posts you can be commented on: images, videos, carousels, reels. Thumbnails first.
    const media = ((body as { data?: Record<string, unknown>[] }).data ?? []).map((m) => ({
      id: m.id,
      caption: m.caption ?? "",
      media_type: m.media_type,
      thumbnail: m.thumbnail_url ?? m.media_url ?? null,
      permalink: m.permalink,
      timestamp: m.timestamp,
    }));
    return json({ media }, 200, cors);
  } catch (err) {
    return json({ error: String(err) }, 502, cors);
  }
}
