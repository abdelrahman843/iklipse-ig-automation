// Small pieces every contact view shares: names, avatars, the messaging window and automation pause.

import { useEffect, useState } from "react";
import { IgLogo } from "../editor/nodes/icons";
import type { Contact } from "../lib/types";

export const WINDOW_MS = 24 * 60 * 60 * 1000;
export const HUMAN_MS = 7 * 24 * 60 * 60 * 1000;
// "Pause forever": a date far enough out that the engine treats it as never.
export const FOREVER = "2999-01-01T00:00:00.000Z";

export type WinState = "open" | "human_only" | "closed";

export function windowState(lastInteractionAt: string | null): WinState {
  if (!lastInteractionAt) return "closed";
  const age = Date.now() - new Date(lastInteractionAt).getTime();
  if (age < WINDOW_MS) return "open";
  if (age < HUMAN_MS) return "human_only";
  return "closed";
}

/** How long until a window measured from the last message closes: "5h", "40m", "3d". */
export function timeLeft(lastInteractionAt: string, span: number): string {
  const ms = new Date(lastInteractionAt).getTime() + span - Date.now();
  if (ms <= 0) return "0m";
  const h = ms / 3_600_000;
  if (h >= 48) return `${Math.floor(h / 24)}d`;
  if (h >= 1) return `${Math.floor(h)}h`;
  return `${Math.max(1, Math.floor(ms / 60_000))}m`;
}

/** A contact's display name: Instagram name, then username, then a placeholder. */
export const nameOf = (c: Contact) => c.name?.trim() || c.username || "Instagram user";

/** When automation resumes for this contact, or null when it isn't paused. */
export const pausedUntil = (c: Contact) =>
  c.pause_until && new Date(c.pause_until).getTime() > Date.now() ? c.pause_until : null;

export const isForever = (iso: string) => new Date(iso).getFullYear() > 2900;

/** The contact's Instagram picture, or their initial when there's none (or it expired). */
export function ContactAvatar({ contact, size, badge }: { contact: Contact; size: number; badge?: boolean }) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [contact.profile_pic]);
  const initial = nameOf(contact).trim()[0]?.toUpperCase() ?? "?";
  return (
    <span className="lc-avatar" style={{ width: size, height: size, fontSize: Math.round(size * 0.4) }} aria-hidden="true">
      {contact.profile_pic && !broken ? (
        <img src={contact.profile_pic} alt="" onError={() => setBroken(true)} referrerPolicy="no-referrer" />
      ) : (
        initial
      )}
      {badge && (
        <span className="lc-avatar-badge"><IgLogo size={12} /></span>
      )}
    </span>
  );
}
