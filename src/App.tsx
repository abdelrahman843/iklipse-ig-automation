import { useEffect, useState } from "react";
import { NavLink, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { Flows } from "./screens/Flows";
import { FlowEditor } from "./screens/FlowEditor";
import { Conversations } from "./screens/Conversations";
import { Sequences } from "./screens/Sequences";
import { SequenceEditor } from "./screens/SequenceEditor";
import { Broadcasts } from "./screens/Broadcasts";
import { BroadcastEditor } from "./screens/BroadcastEditor";
import { Contacts } from "./screens/Contacts";
import { Settings } from "./screens/Settings";
import { ConversationStarters, MainMenu } from "./screens/InstagramSettings";
import { Login } from "./screens/Login";
import { signOut, useSession } from "./lib/auth";
import { Toaster } from "./components/Toast";
import { ConfirmHost } from "./components/Confirm";
import { Loader } from "./components/Loader";

// Temporary escape hatch: with VITE_DISABLE_AUTH=true the login gate is skipped and the panel
// opens directly. RLS falls back to anon (see migration 9). Set it back to false to re-gate.
const AUTH_DISABLED = import.meta.env.VITE_DISABLE_AUTH === "true";

// Each section gets its own colored, duotone icon — the panel's visual vocabulary.
const NAV = [
  {
    to: "/flows",
    label: "Flows",
    bg: "var(--signal-bg)",
    icon: (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <circle cx="4" cy="4" r="2.4" fill="var(--signal)" />
        <circle cx="12" cy="12" r="2.4" fill="var(--signal)" opacity=".45" />
        <path d="M4 6.4V9a3 3 0 0 0 3 3h2.6" stroke="var(--signal)" strokeWidth="1.5" />
      </svg>
    ),
  },
  {
    to: "/conversations",
    label: "Conversations",
    bg: "var(--open-bg)",
    icon: (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <rect x="1.5" y="2.5" width="10" height="7.5" rx="2.2" fill="var(--open)" />
        <rect x="5.5" y="6" width="9" height="7" rx="2.2" fill="var(--open)" opacity=".4" />
      </svg>
    ),
  },
  {
    to: "/contacts",
    label: "Contacts",
    bg: "var(--open-bg)",
    icon: (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <circle cx="6" cy="5.2" r="2.6" fill="var(--open)" />
        <path d="M1.5 13.5c.5-2.6 2.3-4 4.5-4s4 1.4 4.5 4h-9z" fill="var(--open)" />
        <circle cx="11.6" cy="5.8" r="2" fill="var(--open)" opacity=".4" />
        <path d="M11 9.6c1.9.1 3.2 1.4 3.5 3.9h-3" fill="var(--open)" opacity=".4" />
      </svg>
    ),
  },
  {
    to: "/sequences",
    label: "Sequences",
    bg: "var(--signal-bg)",
    icon: (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <circle cx="4" cy="4" r="1.8" fill="var(--signal)" />
        <circle cx="4" cy="8" r="1.8" fill="var(--signal)" opacity=".7" />
        <circle cx="4" cy="12" r="1.8" fill="var(--signal)" opacity=".4" />
        <path d="M6 4h6M6 8h6M6 12h4" stroke="var(--signal)" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    to: "/broadcasts",
    label: "Broadcasts",
    bg: "var(--signal-bg)",
    icon: (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M3 6.5 12 3v10L3 9.5V6.5Z" fill="var(--signal)" opacity=".5" />
        <path d="M3 6.5v3M5.5 9.8V12" stroke="var(--signal)" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    to: "/settings",
    label: "Settings",
    bg: "var(--amber-bg)",
    icon: (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <circle cx="8" cy="8" r="5.6" fill="var(--amber)" opacity=".4" />
        <circle cx="8" cy="8" r="2.2" fill="var(--amber)" />
        <path d="M8 1.6v2M8 12.4v2M1.6 8h2M12.4 8h2" stroke="var(--amber)" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    ),
  },
];

/** True while the media query matches; follows window resizes. */
function useMedia(query: string): boolean {
  const [match, setMatch] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setMatch(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [query]);
  return match;
}

// The rail starts collapsed to icons; it stays expanded only once someone opens it.
function readRailOpen(): boolean {
  try {
    return localStorage.getItem("rail-open") === "1";
  } catch {
    return false;
  }
}

export function App() {
  const { session, loading, recovery } = useSession();
  const location = useLocation();
  const [railOpen, setRailOpen] = useState(readRailOpen);
  // Phones: the rail becomes a drawer behind a menu button.
  const [drawerOpen, setDrawerOpen] = useState(false);
  // Tablets and small laptops: icons only, so the content keeps its width.
  const narrow = useMedia("(min-width: 861px) and (max-width: 1100px)");
  const mini = narrow || !railOpen;

  // Picking a screen closes the drawer; Escape closes it too.
  useEffect(() => setDrawerOpen(false), [location.pathname]);
  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setDrawerOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawerOpen]);

  function toggleRail() {
    setRailOpen((open) => {
      const next = !open;
      try {
        localStorage.setItem("rail-open", next ? "1" : "0");
      } catch {
        /* private mode: fine */
      }
      return next;
    });
  }

  // The flow editor fills its column edge to edge; every other screen gets the padded main.
  const inEditor = /^\/flows\/[^/]+$/.test(location.pathname);

  // Wait for the stored session to load, so a signed-in user never flashes the login screen.
  if (!AUTH_DISABLED && loading) {
    return (
      <div className="gate">
        <Loader label="Loading" />
      </div>
    );
  }

  // A recovery link must reach the set-a-new-password form even though it carries a session.
  if (!AUTH_DISABLED && (!session || recovery)) return <Login recovery={recovery} />;

  const who = session?.user.email ?? "Auth off";

  const routes = (
    <Routes>
      <Route path="/" element={<Navigate to="/flows" replace />} />
      <Route path="/flows" element={<Flows />} />
      <Route path="/flows/:id" element={<FlowEditor />} />
      <Route path="/conversations" element={<Conversations />} />
      <Route path="/sequences" element={<Sequences />} />
      <Route path="/sequences/:id" element={<SequenceEditor />} />
      <Route path="/broadcasts" element={<Broadcasts />} />
      <Route path="/broadcasts/:id" element={<BroadcastEditor />} />
      <Route path="/contacts" element={<Contacts />} />
      <Route path="/settings" element={<Navigate to="/settings/instagram" replace />} />
      <Route path="/settings/starters" element={<ConversationStarters />} />
      <Route path="/settings/menu" element={<MainMenu />} />
      <Route path="/settings/:tab" element={<Settings />} />
      <Route path="/menu" element={<Navigate to="/settings/instagram" replace />} />
      {/* Instagram's connect flow returns to /connect?ig=…; the account now lives in Settings. */}
      <Route path="/connect" element={<Navigate to={`/settings/instagram${location.search}`} replace />} />
      <Route path="*" element={<Navigate to="/flows" replace />} />
    </Routes>
  );

  return (
    <div className={`shell ${mini ? "rail-mini" : ""} ${narrow ? "rail-auto" : ""} ${drawerOpen ? "drawer-open" : ""} ${inEditor ? "in-editor" : ""}`}>
      <header className="mobile-bar">
        <button
          className="mobile-menu-btn"
          onClick={() => setDrawerOpen(true)}
          aria-label="Open menu"
          aria-expanded={drawerOpen}
        >
          <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
            <path d="M3 5h12M3 9h12M3 13h12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        </button>
        <span className="mobile-title">{NAV.find((n) => location.pathname.startsWith(n.to))?.label ?? "Iklipse"}</span>
      </header>
      <div className="drawer-scrim" onClick={() => setDrawerOpen(false)} aria-hidden="true" />
      <nav className="rail" aria-label="Main">
        <div className="rail-top">
          <div className="mark"><span className="mark-text">Iklipse</span></div>
          <button
            className="rail-close"
            onClick={() => setDrawerOpen(false)}
            aria-label="Close menu"
          >
            ×
          </button>
          <button
            className="rail-toggle"
            onClick={toggleRail}
            title={railOpen ? "Collapse menu" : "Expand menu"}
            aria-label={railOpen ? "Collapse menu" : "Expand menu"}
          >
            {railOpen ? "«" : "»"}
          </button>
        </div>
        <div className="rail-nav">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              data-tip={item.label}
              className={({ isActive }) => `rail-link ${isActive ? "is-current" : ""}`}
            >
              <span className="rail-ic" style={{ background: item.bg }}>{item.icon}</span>
              <span className="rail-label">{item.label}</span>
            </NavLink>
          ))}
        </div>

        <div className="rail-foot">
          <div className="rail-who" title={who}>{who}</div>
          {session && <button className="btn-quiet rail-label" onClick={() => signOut()}>Sign out</button>}
        </div>
      </nav>

      {inEditor ? (
        <div className="content-bleed">{routes}</div>
      ) : (
        <main className={`main ${location.pathname === "/conversations" ? "main-chat" : ""}`}>
          {/* keyed on the path so each screen replays its entrance */}
          <div key={location.pathname} className="screen-enter">{routes}</div>
        </main>
      )}
      <Toaster />
      <ConfirmHost />
    </div>
  );
}
