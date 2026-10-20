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

/** Shared secret the admin-accounts function requires (header x-admin-key). Only n8n holds it. */
export const ADMIN_API_KEY = () => env("ADMIN_API_KEY");

/** Logins are usernames; Supabase Auth stores each as <username>@ this domain. ".invalid" is a reserved TLD: no one can ever receive mail there, so a password-reset email can never reach anyone. */
export const LOGIN_DOMAIN = () => env("LOGIN_DOMAIN", "login.iklipse.invalid");
