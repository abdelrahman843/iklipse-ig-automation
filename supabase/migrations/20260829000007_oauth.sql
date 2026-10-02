-- Instagram OAuth connect (Task 4).
--
-- Replaces the hand-pasted token with a token the connect flow stores server-side. The token
-- lives in ig_token, a table with NO client policy at all, so the panel can read an account's
-- status and username but never its token. Edge Functions (service role) are the only readers.

alter table ig_account
  add column if not exists status            text not null default 'connected', -- connected | needs_reconnect | disconnected
  add column if not exists token_expires_at  timestamptz,
  add column if not exists last_refreshed_at timestamptz;

-- Server-only secret store. Mirrors webhook_event: RLS on, no policy, service role only.
create table if not exists ig_token (
  ig_account_id uuid primary key references ig_account(id) on delete cascade,
  access_token  text not null,
  expires_at    timestamptz,
  updated_at    timestamptz not null default now()
);

alter table ig_token enable row level security;
-- deliberately no policy: no anon, no authenticated. The token never reaches a browser.
