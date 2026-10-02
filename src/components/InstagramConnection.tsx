import { useEffect, useState } from "react";
import { errorText, supabase } from "../lib/supabase";
import { Loader } from "./Loader";
import { friendlyError, toast } from "./Toast";
import { confirmDialog } from "./Confirm";

interface Account {
  id: string;
  ig_user_id: string;
  username: string | null;
  status: string;
  token_expires_at: string | null;
  connected_at: string | null;
}

const APP_ID = import.meta.env.VITE_IG_APP_ID as string | undefined;
const REDIRECT = import.meta.env.VITE_IG_REDIRECT_URI as string | undefined;
const SCOPES = (import.meta.env.VITE_IG_SCOPES as string | undefined) ?? "";

/**
 * The Instagram authorization dialog. The user lands back on our edge function with a code.
 * `state` is a one-time value issued by that function; the callback refuses any code without it.
 */
function authorizeUrl(state: string): string {
  const p = new URLSearchParams({
    state,
    enable_fb_login: "0",
    force_authentication: "1",
    client_id: APP_ID ?? "",
    redirect_uri: REDIRECT ?? "",
    response_type: "code",
    scope: SCOPES,
  });
  return `https://www.instagram.com/oauth/authorize?${p.toString()}`;
}

/** POST to the ig-oauth function as the signed-in user. */
async function callOauth(action: "start" | "disconnect"): Promise<Record<string, unknown>> {
  const { data } = await supabase.auth.getSession();
  // Auth may be disabled (no session). Fall back to the anon key; the function only accepts it
  // when its ALLOW_ANON secret is set.
  const bearer = data.session?.access_token ?? (import.meta.env.VITE_SUPABASE_ANON_KEY as string);
  let res: Response;
  try {
    res = await fetch(REDIRECT!, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${bearer}` },
      body: JSON.stringify({ action }),
    });
  } catch (err) {
    throw errorText(err) === "Failed to fetch"
      ? new Error("Can't reach the server. The ig-oauth function is not deployed yet.")
      : err;
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `ig-oauth answered ${res.status}`);
  return body;
}

function daysLeft(iso: string | null): number | null {
  if (!iso) return null;
  return Math.round((new Date(iso).getTime() - Date.now()) / (24 * 60 * 60 * 1000));
}

/** Settings › Instagram: the connected account, with Reconnect and Disconnect. */
export function InstagramConnection() {
  const [account, setAccount] = useState<Account | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The connect flow redirects back with ?ig=connected|error. Show it, then clean the URL.
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const ig = p.get("ig");
    const username = p.get("username");
    if (ig === "connected") toast.success(`Instagram connected${username ? " as @" + username : ""}`);
    else if (ig === "error") toast.error(`Instagram connection failed: ${p.get("reason") ?? "unknown reason"}.`);
    if (ig) window.history.replaceState(window.history.state, "", window.location.pathname);
  }, []);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const { data, error } = await supabase
        .from("ig_account")
        .select("id, ig_user_id, username, status, token_expires_at, connected_at")
        .order("connected_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      setAccount(data as Account | null);
    } catch (err) {
      setError(`Could not load the connected account: ${friendlyError(err)}`);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function connect() {
    if (busy) return;
    if (!APP_ID || !REDIRECT) {
      toast.error("Set VITE_IG_APP_ID and VITE_IG_REDIRECT_URI in .env first.");
      return;
    }
    setBusy(true);
    try {
      const { state } = await callOauth("start");
      window.location.href = authorizeUrl(String(state));
    } catch (err) {
      toast.error(err);
      setBusy(false);
    }
  }

  async function disconnect() {
    if (busy) return;
    if (!REDIRECT) {
      toast.error("Set VITE_IG_REDIRECT_URI in .env first.");
      return;
    }
    const ok = await confirmDialog({
      title: "Disconnect Instagram?",
      body:
        `@${account?.username ?? account?.ig_user_id} stops receiving and sending messages here. ` +
        "Live automations stop replying until you connect again.",
      confirmLabel: "Disconnect",
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      await callOauth("disconnect");
      toast.success("Instagram disconnected");
      await load();
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <div className="mc-card account-card"><Loader label="Loading account" inline /></div>;
  if (error) return <div className="notice">{error}</div>;

  const connected = account?.status === "connected";
  const needsReconnect = account?.status === "needs_reconnect";
  const left = daysLeft(account?.token_expires_at ?? null);

  return (
    <div className="mc-card account-card">
      <span className="phone-avatar is-big" />
      <div className="stack" style={{ gap: 2, minWidth: 0 }}>
        <strong>{connected ? `@${account?.username ?? account?.ig_user_id}` : needsReconnect ? "Reconnection needed" : "No account connected"}</strong>
        <span className="mono">
          {connected
            ? left !== null
              ? `Connected · access renews automatically (${left} day${left === 1 ? "" : "s"} left)`
              : "Connected"
            : needsReconnect
              ? "The stored access couldn't be renewed. Reconnect to keep automations running."
              : "Connect an Instagram professional account to send and receive messages."}
        </span>
        {!connected && (
          <span className="mono">
            In the Instagram app, turn on Settings › Messages and story replies › Message controls › Allow access to messages
            first. Without it Instagram accepts the connection but never delivers a message.
          </span>
        )}
      </div>
      <div className="cluster account-actions">
        {connected ? (
          <>
            <button className="btn" onClick={connect} disabled={busy}>Reconnect</button>
            <button className={`btn btn-danger ${busy ? "is-busy" : ""}`} onClick={disconnect} disabled={busy}>Disconnect</button>
          </>
        ) : (
          <button className={`btn btn-primary ${busy ? "is-busy" : ""}`} onClick={connect} disabled={busy}>
            {needsReconnect ? "Reconnect Instagram" : "Connect Instagram"}
          </button>
        )}
      </div>
    </div>
  );
}
