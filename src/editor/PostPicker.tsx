import { useEffect, useState } from "react";
import { errorText, supabase } from "../lib/supabase";
import { friendlyError } from "../components/Toast";

interface Post {
  id: string;
  caption: string;
  media_type: string;
  thumbnail: string | null;
  permalink: string;
  timestamp: string;
}

/**
 * Picks a post for the comment trigger by showing the connected account's actual posts, the way
 * ManyChat does: a "Specific Post or Reel" grid plus an "All Posts or Reels" option. The list
 * comes from the ig-media edge function, which reads it with the server-side token. An empty
 * value means "every post".
 */
export function PostPicker({ value, onChange }: { value?: string; onChange: (id: string) => void }) {
  const [posts, setPosts] = useState<Post[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    // The drawer can close before the fetch returns; don't write into an unmounted picker.
    let active = true;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const { data } = await supabase.auth.getSession();
        const bearer = data.session?.access_token ?? (import.meta.env.VITE_SUPABASE_ANON_KEY as string);
        const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/ig-media`, {
          headers: { authorization: `Bearer ${bearer}` },
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error ?? "Could not load posts");
        if (active) setPosts((body.media ?? []) as Post[]);
      } catch (err) {
        if (!active) return;
        setError(
          errorText(err) === "Failed to fetch"
            ? "Can't reach the server. The ig-media function may not be deployed yet."
            : `Could not load your posts: ${friendlyError(err)}`,
        );
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const grid = posts.slice(0, 6);

  return (
    <div className="postpick">
      <div className="postpick-section">
        <div className="row-between" style={{ marginBottom: 8 }}>
          <span className="postpick-head">Specific Post or Reel</span>
          {posts.length > 6 && (
            <button type="button" className="postpick-more" onClick={() => setOpen(true)}>See More</button>
          )}
        </div>

        {error && <div className="notice" style={{ marginBottom: 8 }}>{error}</div>}

        {loading ? (
          <div className="postpick-grid-in">
            {Array.from({ length: 6 }).map((_, i) => <div key={i} className="posttile is-skeleton" />)}
          </div>
        ) : posts.length === 0 && !error ? (
          <p className="mono" style={{ margin: 0 }}>No posts on this account yet.</p>
        ) : (
          <div className="postpick-grid-in">
            {grid.map((p) => (
              <PostTile key={p.id} post={p} selected={p.id === value} onPick={() => onChange(p.id)} />
            ))}
          </div>
        )}
      </div>

      <button
        type="button"
        className={`postpick-all ${!value ? "on" : ""}`}
        onClick={() => onChange("")}
      >
        <span className="postpick-radio">{!value && <Dot />}</span>
        All Posts or Reels
      </button>

      {open && (
        <div className="modal-scrim" onClick={() => setOpen(false)}>
          <div className="postpick-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Pick a post">
            <header className="postpick-head-bar">
              <h3 className="postpick-title">All Posts or Reels</h3>
              <button className="drawer-close" onClick={() => setOpen(false)} aria-label="Close">×</button>
            </header>
            <div className="postpick-body">
              <div className="postpick-grid">
                {posts.map((p) => (
                  <PostTile key={p.id} post={p} selected={p.id === value} big onPick={() => { onChange(p.id); setOpen(false); }} />
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function PostTile({ post, selected, onPick, big }: { post: Post; selected: boolean; onPick: () => void; big?: boolean }) {
  return (
    <button type="button" className={`posttile ${selected ? "on" : ""} ${big ? "posttile-big" : ""}`} onClick={onPick} title={caption(post)}>
      {post.thumbnail ? (
        <img className="posttile-img" src={post.thumbnail} alt="" loading="lazy" />
      ) : (
        <span className="posttile-fallback">IG</span>
      )}
      <span className="posttile-radio">{selected && <Dot />}</span>
      {post.media_type === "VIDEO" && <span className="posttile-badge">▶</span>}
    </button>
  );
}

function Dot() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      <circle cx="6" cy="6" r="6" fill="currentColor" />
      <path d="M3.4 6.1 5.2 8l3.4-3.8" stroke="#fff" strokeWidth="1.4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function caption(p: Post): string {
  const c = (p.caption ?? "").trim();
  if (c) return c.length > 60 ? c.slice(0, 60) + "…" : c;
  return p.media_type === "VIDEO" ? "Video" : p.media_type === "CAROUSEL_ALBUM" ? "Carousel" : "Photo";
}
