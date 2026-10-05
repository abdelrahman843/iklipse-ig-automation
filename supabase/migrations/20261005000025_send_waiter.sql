-- One send-worker at a time may stay up to deliver rows held by a short pause (the few seconds
-- before a comment reply) the moment they fall due, instead of at the next minute's run. This is
-- its lease: a worker takes it only while it is empty or expired.
alter table send_guard add column if not exists waiting_until timestamptz;
