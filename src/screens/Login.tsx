import { useState } from "react";
import { errorText } from "../lib/supabase";
import { signIn } from "../lib/auth";
import { friendlyError } from "../components/Toast";

/** Supabase auth errors, in words a person can act on. */
function authError(err: unknown): string {
  const msg = errorText(err);
  if (/invalid login credentials/i.test(msg)) return "Wrong username or password.";
  if (/banned|user is banned/i.test(msg)) return "This login is disabled. Ask your admin.";
  if (/rate limit|too many requests|429/i.test(msg)) return "Too many attempts. Wait a minute, then try again.";
  return friendlyError(err);
}

/**
 * The gate, shown whenever there is no session. There is no sign-up and no reset-by-email:
 * logins are created, and passwords reset, by the admin.
 */
export function Login() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const { error } = await signIn(username, password);
      if (error) setError(authError(error));
    } catch (err) {
      setError(authError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="gate">
      <div className="gate-card">
        <div className="mark">Iklipse</div>
        <div className="mark-sub">Instagram automation</div>

        <h1 className="gate-title">Sign in</h1>

        <form className="gate-form" onSubmit={submit}>
          <div>
            <label className="label" htmlFor="username">Username</label>
            <input
              id="username"
              className="input"
              type="text"
              autoComplete="username"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              aria-invalid={Boolean(error)}
              autoFocus
              required
            />
          </div>

          <div>
            <label className="label" htmlFor="password">Password</label>
            <input
              id="password"
              className="input"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              aria-invalid={Boolean(error)}
              required
            />
          </div>

          {error && <div className="notice" role="alert">{error}</div>}

          <button className={`btn btn-primary gate-submit ${busy ? "is-busy" : ""}`} type="submit" disabled={busy}>
            Sign in
          </button>
        </form>

        <p className="gate-links gate-hint">Forgot your password? Ask your admin to reset it.</p>
      </div>
    </div>
  );
}
