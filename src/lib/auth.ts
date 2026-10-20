import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./supabase";

/**
 * Auth state for the whole app. `loading` is true until Supabase has read any stored session,
 * so the gate can wait instead of flashing the login screen at a user who is already signed in.
 */
export interface AuthState {
  session: Session | null;
  loading: boolean;
}

export function useSession(): AuthState {
  const [state, setState] = useState<AuthState>({ session: null, loading: true });

  useEffect(() => {
    let active = true;

    supabase.auth.getSession().then(({ data }) => {
      if (active) setState({ session: data.session, loading: false });
    });

    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      // Signing out (or a session that lapsed) starts the page over, so nothing one workspace
      // loaded stays in memory for whoever signs in next.
      if (event === "SIGNED_OUT") {
        window.location.replace(window.location.origin + import.meta.env.BASE_URL);
        return;
      }
      setState({ session, loading: false });
    });

    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  return state;
}

// Logins are usernames. Supabase Auth keys accounts by email, so each username is stored as
// <username>@ this domain: a reserved ".invalid" domain that no mail can ever reach.
const LOGIN_DOMAIN = (import.meta.env.VITE_LOGIN_DOMAIN as string | undefined) ?? "login.iklipse.invalid";

/** "Acme", "@acme" or "acme@login.iklipse.invalid" -> the email Supabase knows the login by. */
export function loginEmail(username: string): string {
  const u = username.trim().toLowerCase().replace(/^@/, "");
  return u.includes("@") ? u : `${u}@${LOGIN_DOMAIN}`;
}

export function signIn(username: string, password: string) {
  return supabase.auth.signInWithPassword({ email: loginEmail(username), password });
}

export function signOut() {
  return supabase.auth.signOut();
}

/** Change the signed-in login's password, after proving the current one. */
export async function changePassword(username: string, current: string, next: string) {
  const check = await signIn(username, current);
  if (check.error) return { error: new Error("Your current password is wrong.") };
  return supabase.auth.updateUser({ password: next });
}
