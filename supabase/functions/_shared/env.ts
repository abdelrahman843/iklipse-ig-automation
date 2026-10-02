export function env(name: string, fallback?: string): string {
  const value = Deno.env.get(name) ?? fallback;
  if (value === undefined) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

export const SUPABASE_URL = () => env("SUPABASE_URL");
export const SERVICE_ROLE_KEY = () => env("SUPABASE_SERVICE_ROLE_KEY");

/** Meta app secret. Signs every webhook POST as X-Hub-Signature-256. */
export const META_APP_SECRET = () => env("META_APP_SECRET");

/** The string you invent and paste into Meta's webhook setup form. */
export const VERIFY_TOKEN = () => env("META_VERIFY_TOKEN");

/** Long-lived Instagram access token. Sends DMs as the business. Never expose it. */
export const IG_ACCESS_TOKEN = () => env("IG_ACCESS_TOKEN");

/** The Instagram professional account id that owns the conversations. */
export const IG_USER_ID = () => env("IG_USER_ID");

export const GRAPH_BASE = () => env("GRAPH_BASE", "https://graph.instagram.com/v26.0");

// ---- Instagram OAuth (connect flow) ----------------------------------------------------

/** Instagram app id. The client_id in the authorize URL and the token exchange. */
export const IG_APP_ID = () => env("IG_APP_ID");

/** Instagram app secret for the token exchange. Same secret that signs webhooks. */
export const IG_APP_SECRET = () => Deno.env.get("IG_APP_SECRET") ?? META_APP_SECRET();

/** The OAuth redirect. Must match exactly what is registered in the Meta dashboard. */
export const IG_REDIRECT_URI = () => env("IG_REDIRECT_URI");

/** Where to send the browser back to after connecting. */
export const APP_URL = () => env("APP_URL", "http://localhost:5173");
