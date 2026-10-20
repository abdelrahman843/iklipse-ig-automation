// Runs the Supabase CLI with this project's own access token, so several Supabase accounts can
// live side by side without `supabase login` switching between them.
//
//   npm run sb -- functions deploy process-events
//   npm run sb -- db query --linked -f supabase/migrations/<file>.sql
//
// The token is read from .supabase-token at the project root (one line, gitignored). Make one at
// https://supabase.com/dashboard/account/tokens while signed in to the account that owns this
// project. Without the file, the CLI falls back to whatever `supabase login` stored.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const file = join(root, ".supabase-token");
const env = { ...process.env };

if (existsSync(file)) {
  const token = readFileSync(file, "utf8").trim();
  if (token) env.SUPABASE_ACCESS_TOKEN = token;
} else {
  console.warn("No .supabase-token here; using the token from `supabase login`.");
}

const { status } = spawnSync("npx", ["supabase", ...process.argv.slice(2)], {
  cwd: root,
  env,
  stdio: "inherit",
  shell: process.platform === "win32",
});
process.exit(status ?? 1);
