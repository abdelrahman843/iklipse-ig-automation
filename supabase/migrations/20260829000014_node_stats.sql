-- Per-node "reached" counters, so the editor can show "N reached this step" like ManyChat.
--
-- Instagram gives no open/click/delivery metrics, so those are impossible to show honestly. What
-- we CAN count from our own run: how many contacts reached each step. The engine bumps a node the
-- first time a run arrives at it (deduped per run in run.state._visited), so a loop back to an
-- earlier step does not double-count and a resume does not re-count.

create table if not exists node_stat (
  flow_id    uuid not null references flow(id) on delete cascade,
  node_id    text not null,
  reached    bigint not null default 0,
  updated_at timestamptz not null default now(),
  primary key (flow_id, node_id)
);

alter table node_stat enable row level security;
drop policy if exists node_stat_anon_read on node_stat;
create policy node_stat_anon_read on node_stat for select to anon using (true);
drop policy if exists node_stat_auth_read on node_stat;
create policy node_stat_auth_read on node_stat for select to authenticated using (true);
-- Writes only ever come from the engine on the service role, which bypasses RLS.

create or replace function bump_node(p_flow uuid, p_node text)
returns void language sql as $$
  insert into node_stat (flow_id, node_id, reached)
  values (p_flow, p_node, 1)
  on conflict (flow_id, node_id)
  do update set reached = node_stat.reached + 1, updated_at = now();
$$;
