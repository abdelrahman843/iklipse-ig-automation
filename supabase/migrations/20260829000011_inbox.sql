-- Inbox + human takeover (Task 3).
--
-- The 24-hour window governs automation. A human agent may reply up to 7 days, but only with
-- Meta's HUMAN_AGENT tag. When an agent replies, automation pauses for this contact so the bot
-- and the human do not talk over each other.

alter table contact
  add column if not exists pause_until timestamptz,               -- automation paused until this time
  add column if not exists assigned_to text,                      -- agent this conversation belongs to
  add column if not exists unread     boolean not null default false;

-- Mark which outbound messages a human sent (vs the engine), so the inbox can show it and so an
-- audit can prove automated messages never carried the HUMAN_AGENT tag.
alter table message
  add column if not exists sent_by text not null default 'engine'; -- engine | human

-- Internal notes on a conversation. Not sent to the contact.
create table if not exists contact_note (
  id         uuid primary key default gen_random_uuid(),
  contact_id uuid not null references contact(id) on delete cascade,
  body       text not null,
  author     text,
  created_at timestamptz not null default now()
);

alter table contact_note enable row level security;

drop policy if exists contact_note_anon_all on contact_note;
create policy contact_note_anon_all on contact_note for all to anon using (true) with check (true);

drop policy if exists contact_note_auth_all on contact_note;
create policy contact_note_auth_all on contact_note for all to authenticated using (true) with check (true);

-- The panel needs to update a few contact fields directly (assign, mark read). Give it write
-- access to contact (previously read-only). RLS still gates by role; the token stays server-side.
drop policy if exists contact_anon_write on contact;
create policy contact_anon_write on contact for update to anon using (true) with check (true);

drop policy if exists contact_auth_write on contact;
create policy contact_auth_write on contact for update to authenticated using (true) with check (true);
