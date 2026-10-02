// Account-wide settings (Settings › General / Live Chat) that other screens read.

import { useEffect, useState } from "react";
import { supabase } from "./supabase";

export const BROWSER_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

let timezone: Promise<string> | null = null;

/** Settings › General's time zone, or this browser's when none is set. Read once, then cached. */
export function accountTimezone(): Promise<string> {
  timezone ??= Promise.resolve(supabase.from("app_settings").select("timezone").eq("id", 1).maybeSingle()).then(
    ({ data }) => (data?.timezone as string | null) || BROWSER_TZ,
    () => BROWSER_TZ,
  );
  return timezone;
}

/** Call after the time zone changes so the next read sees it. */
export function forgetAccountTimezone() {
  timezone = null;
}

export function useAccountTimezone(): string {
  const [tz, setTz] = useState(BROWSER_TZ);
  useEffect(() => {
    let live = true;
    accountTimezone().then((t) => live && setTz(t));
    return () => {
      live = false;
    };
  }, []);
  return tz;
}
