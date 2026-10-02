import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./supabase";

/**
 * Auth state for the whole app. `loading` is true until Supabase has read any stored session,
 * so the gate can wait instead of flashing the login screen at a user who is already signed in.
 * `recovery` is true while a password-reset link is open, so the app shows the "set a new
 * password" form instead of the normal panel.
 */
export interface AuthState {
  session: Session | null;
  loading: boolean;
  recovery: boolean;
}

export function useSession(): AuthState {
  const [state, setState] = useState<AuthState>({
    session: null,
    loading: true,
    recovery: false,
  });

  useEffect(() => {
    let active = true;

    supabase.auth.getSession().then(({ data }) => {
      if (active) setState((s) => ({ ...s, session: data.session, loading: false }));
    });

    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      setState((s) => ({
        session,
        loading: false,
        // Stay in recovery mode until the password is actually updated.
        recovery: event === "PASSWORD_RECOVERY" ? true : event === "USER_UPDATED" ? false : s.recovery,
      }));
    });

    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  return state;
}

export function signIn(email: string, password: string) {
  return supabase.auth.signInWithPassword({ email, password });
}

export function signUp(email: string, password: string) {
  return supabase.auth.signUp({ email, password });
}

export function signOut() {
  return supabase.auth.signOut();
}

/** Sends a reset link. It returns to the app, where detectSessionInUrl opens recovery mode. */
export function requestPasswordReset(email: string) {
  return supabase.auth.resetPasswordForEmail(email, {
    redirectTo: window.location.origin + import.meta.env.BASE_URL,
  });
}

export function updatePassword(password: string) {
  return supabase.auth.updateUser({ password });
}
