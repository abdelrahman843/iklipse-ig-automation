// Which browser origins may call the panel's functions.
//
// These endpoints authenticate with a bearer token, not cookies, so CORS is defence in depth
// rather than the lock itself: it stops some other website from driving them from a visitor's
// browser. Allowed: APP_URL (where the panel is hosted), any extra origins listed in the
// CORS_ORIGINS secret (comma-separated), and localhost for development.

import { APP_URL } from "./env.ts";

function allowed(origin: string): boolean {
  let host: URL;
  try {
    host = new URL(origin);
  } catch {
    return false;
  }
  if (host.hostname === "localhost" || host.hostname === "127.0.0.1") return true;
  const list = [APP_URL(), ...(Deno.env.get("CORS_ORIGINS") ?? "").split(",")]
    .map((o) => o.trim().replace(/\/+$/, ""))
    .filter(Boolean);
  return list.some((o) => {
    try {
      return new URL(o).origin === host.origin;
    } catch {
      return false;
    }
  });
}

/** Stamp the response with this request's origin when it is allowed, and nothing when it is not. */
export function withCors(req: Request, res: Response): Response {
  const origin = req.headers.get("origin");
  const headers = new Headers(res.headers);
  headers.delete("access-control-allow-origin");
  if (origin && allowed(origin)) {
    headers.set("access-control-allow-origin", origin);
    headers.append("vary", "Origin");
  }
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}
