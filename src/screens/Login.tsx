import { useState } from "react";
import { errorText } from "../lib/supabase";
import { requestPasswordReset, signIn, updatePassword } from "../lib/auth";
import { friendlyError } from "../components/Toast";

// No sign-up: accounts are created by an admin, so the gate only signs existing users in.
type Mode = "in" | "forgot";

/** Supabase auth errors, in words a person can act on. */
function authError(err: unknown): string {
  const msg = errorText(err);
  if (/invalid login credentials/i.test(msg)) return "Wrong email or password.";
  if (/email not confirmed/i.test(msg)) return "This email isn't confirmed yet. Open the link in your confirmation email first.";
  if (/rate limit|too many requests|429/i.test(msg)) return "Too many attempts. Wait a minute, then try again.";
  if (/signups? not allowed|signup is disabled/i.test(msg)) return "There's no account for that email. Ask an admin to invite you.";
  if (/should be different from the old password/i.test(msg)) return "Pick a password different from your current one.";
  if (/password should be at least/i.test(msg)) return msg;
  if (/auth session missing|session.*expired|invalid.*(token|jwt)/i.test(msg))
    return "This reset link has expired. Request a new one from the sign-in screen.";
  return friendlyError(err);
}

/**
 * The gate. Shown whenever there is no session. `recovery` swaps it for a set-a-new-password
 * form, which is what a reset link lands on. The app's toaster isn't mounted here, so feedback
 * stays inline.
 */
export function Login({ recovery }: { recovery: boolean }) {
  const [mode, setMode] = useState<Mode>("in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function run(fn: () => Promise<{ error: unknown }>, ok?: string) {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const { error } = await fn();
      if (error) setError(authError(error));
      else if (ok) setNotice(ok);
    } catch (err) {
      setError(authError(err));
    } finally {
      setBusy(false);
    }
  }

  function switchMode(next: Mode) {
    setMode(next);
    setError(null);
    setNotice(null);
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (recovery) {
      void run(() => updatePassword(password), "Password changed. Opening the panel…");
    } else if (mode === "in") {
      void run(() => signIn(email, password));
    } else {
      void run(() => requestPasswordReset(email), "If that email has an account, a reset link is on its way.");
    }
  }

  const title = recovery ? "Set a new password" : mode === "in" ? "Sign in" : "Reset your password";
  const cta = recovery ? "Save password" : mode === "in" ? "Sign in" : "Send reset link";
  const needsPassword = recovery || mode === "in";

  return (
    <div className="gate">
      <div className="gate-card">
        <div className="mark">Instagram automation</div>
        <div className="mark-sub">Control panel</div>

        <h1 className="gate-title">{title}</h1>

        <form className="gate-form" onSubmit={submit}>
          {!recovery && (
            <div>
              <label className="label" htmlFor="email">Email</label>
              <input
                id="email"
                className="input"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                aria-invalid={Boolean(error)}
                required
              />
            </div>
          )}

          {needsPassword && (
            <div>
              <label className="label" htmlFor="password">
                {recovery ? "New password" : "Password"}
              </label>
              <input
                id="password"
                className="input"
                type="password"
                autoComplete={recovery ? "new-password" : "current-password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                aria-invalid={Boolean(error)}
                // Only a new password has a length rule; an existing one is checked by the server.
                minLength={recovery ? 8 : undefined}
                required
              />
            </div>
          )}

          {error && <div className="notice" role="alert">{error}</div>}
          {notice && <div className="notice notice-ok" role="status">{notice}</div>}

          <button className={`btn btn-primary gate-submit ${busy ? "is-busy" : ""}`} type="submit" disabled={busy}>
            {cta}
          </button>
        </form>

        {!recovery && (
          <div className="gate-links">
            {mode === "in" ? (
              <button className="btn-quiet" onClick={() => switchMode("forgot")}>Forgot password?</button>
            ) : (
              <button className="btn-quiet" onClick={() => switchMode("in")}>Back to sign in</button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
