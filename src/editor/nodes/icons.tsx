import type { EditorNodeType } from "../nodeDefs";

/** The Instagram mark, drawn with its own gradient — used on message-preview nodes. */
export function IgLogo({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id="ig-g" x1="2" y1="22" x2="22" y2="2" gradientUnits="userSpaceOnUse">
          <stop stopColor="#FEDA75" />
          <stop offset=".35" stopColor="#FA7E1E" />
          <stop offset=".6" stopColor="#D62976" />
          <stop offset=".85" stopColor="#962FBF" />
          <stop offset="1" stopColor="#4F5BD5" />
        </linearGradient>
      </defs>
      <rect x="1.5" y="1.5" width="21" height="21" rx="6" fill="url(#ig-g)" />
      <rect x="6" y="6" width="12" height="12" rx="4" stroke="#fff" strokeWidth="1.7" />
      <circle cx="12" cy="12" r="3" stroke="#fff" strokeWidth="1.7" />
      <circle cx="16.4" cy="7.6" r="1.1" fill="#fff" />
    </svg>
  );
}

/** The little outbound-message glyph in the corner of a send node. */
export function IgChat() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <path
        d="M2.5 8.2C2.5 5.3 5.4 3 9 3s6.5 2.3 6.5 5.2S12.6 13.4 9 13.4c-.7 0-1.4-.1-2-.3l-2.7 1 .7-2.3C3.3 11 2.5 9.7 2.5 8.2Z"
        stroke="var(--signal)"
        strokeWidth="1.4"
      />
    </svg>
  );
}

const s = { strokeWidth: 1.6, fill: "none" as const };

/** Colored duotone icon per node type, for the compact node header. */
export const NODE_ICON: Record<EditorNodeType, React.ReactNode> = {
  trigger: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path d="M8 1.5 3 8.5h4l-1 6 6-8H8l1-5Z" fill="var(--signal)" />
    </svg>
  ),
  send_message: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <rect x="1.5" y="3" width="13" height="9" rx="2.4" fill="var(--signal)" opacity=".4" />
      <path d="M2 4.5 8 8.5l6-4" stroke="var(--signal)" {...s} />
    </svg>
  ),
  collect: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <rect x="2" y="2.5" width="12" height="11" rx="2.4" fill="var(--signal)" opacity=".35" />
      <path d="M5 6h6M5 8.5h6M5 11h3.5" stroke="var(--signal)" {...s} strokeLinecap="round" />
    </svg>
  ),
  wait_reply: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path d="M3.5 2.5h9M3.5 13.5h9" stroke="var(--burn)" {...s} strokeLinecap="round" />
      <path d="M5 2.5c0 3 6 3.5 6 5.5s-6 2.5-6 5.5" stroke="var(--burn)" {...s} />
      <path d="M11 2.5c0 3-6 3.5-6 5.5s6 2.5 6 5.5" stroke="var(--burn)" opacity=".45" {...s} />
    </svg>
  ),
  check_follow: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <circle cx="7" cy="5.5" r="2.6" fill="var(--open)" opacity=".4" />
      <path d="M2.5 13c0-2.5 2-4 4.5-4 1 0 1.9.25 2.6.7" stroke="var(--open)" {...s} strokeLinecap="round" />
      <path d="m10.5 11.5 1.4 1.4 2.6-2.9" stroke="var(--open)" {...s} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  condition: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <circle cx="4" cy="4" r="2.2" fill="var(--open)" />
      <circle cx="12" cy="12" r="2.2" fill="var(--open)" opacity=".4" />
      <circle cx="4" cy="12" r="2.2" fill="var(--open)" opacity=".4" />
      <path d="M4 6.2v.8a4 4 0 0 0 4 4h1.8M4 6.2V9.8" stroke="var(--open)" {...s} />
    </svg>
  ),
  delay: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="8.5" r="5.5" fill="var(--ink-soft)" opacity=".25" />
      <path d="M8 5.5v3.2l2 1.3M8 1.5" stroke="var(--ink-soft)" {...s} strokeLinecap="round" />
    </svg>
  ),
  action: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path d="M8.5 1.5 3 9h4l-.5 5.5L13 7H9l-.5-5.5Z" fill="var(--signal)" opacity=".85" />
    </svg>
  ),
  randomize: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path d="M2 4h3l6 8h3M2 12h3l2-2.6M11 4h3M9 6.6 11 4" stroke="var(--open)" {...s} strokeLinecap="round" strokeLinejoin="round" />
      <path d="m12.5 2.5 2 1.5-2 1.5M12.5 10.5l2 1.5-2 1.5" stroke="var(--open)" {...s} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  smart_delay: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="9" r="5.3" fill="var(--ink-soft)" opacity=".22" />
      <path d="M8 6v3.2l2 1.3M6 1.5h4" stroke="var(--ink-soft)" {...s} strokeLinecap="round" />
    </svg>
  ),
  http_request: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="8" r="6" stroke="var(--ink-soft)" {...s} opacity=".55" />
      <path d="M2 8h12M8 2c1.8 2 1.8 10 0 12M8 2c-1.8 2-1.8 10 0 12" stroke="var(--ink-soft)" {...s} />
    </svg>
  ),
  go_to_flow: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path d="M2.5 8h9m0 0-3-3m3 3-3 3" stroke="var(--ink-soft)" {...s} strokeLinecap="round" strokeLinejoin="round" />
      <path d="M13.5 3v10" stroke="var(--ink-soft)" {...s} strokeLinecap="round" opacity=".5" />
    </svg>
  ),
  end: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <rect x="3" y="3" width="10" height="10" rx="2.5" fill="var(--ink-soft)" opacity=".5" />
    </svg>
  ),
};
