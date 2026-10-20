import { useEffect, useState } from "react";
import { supabase } from "./supabase";

/**
 * The workspace the signed-in login belongs to. Everything the panel shows and saves lives in
 * it: the database scopes every table to it (RLS), and new rows are filed under it by default.
 */
export interface Workspace {
  id: string;
  name: string;
  username: string;
  role: "owner" | "admin" | "member";
}

let current: Promise<Workspace | null> | null = null;

/** Read once per page load (signing out reloads the page). */
export function loadWorkspace(): Promise<Workspace | null> {
  current ??= (async () => {
    const { data: auth } = await supabase.auth.getSession();
    const userId = auth.session?.user.id;
    if (!userId) return null;
    const { data, error } = await supabase
      .from("workspace_member")
      .select("workspace_id, username, role, workspace(name)")
      .eq("user_id", userId)
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    const ws = data.workspace as unknown as { name: string } | { name: string }[] | null;
    return {
      id: data.workspace_id as string,
      name: (Array.isArray(ws) ? ws[0]?.name : ws?.name) ?? "Workspace",
      username: data.username as string,
      role: data.role as Workspace["role"],
    };
  })().catch((err) => {
    current = null; // let the next call try again
    throw err;
  });
  return current;
}

/** The workspace id, for the few writes that must name it (storage paths, updates by key). */
export async function workspaceId(): Promise<string> {
  const ws = await loadWorkspace();
  if (!ws) throw new Error("This login has no workspace.");
  return ws.id;
}

/** After a rename: the next read sees the new name. */
export function setWorkspaceName(name: string): void {
  if (current) current = current.then((ws) => (ws ? { ...ws, name } : ws));
}

export function useWorkspace(enabled = true) {
  const [state, setState] = useState<{ workspace: Workspace | null; loading: boolean; error: unknown }>({
    workspace: null,
    loading: true,
    error: null,
  });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    loadWorkspace().then(
      (workspace) => alive && setState({ workspace, loading: false, error: null }),
      (error) => alive && setState({ workspace: null, loading: false, error }),
    );
    return () => {
      alive = false;
    };
  }, [enabled, attempt]);

  return { ...state, retry: () => setAttempt((n) => n + 1) };
}
