-- Optional one-tap reasons for a started game that was ended with /reset.
-- No free text, Discord identifier, display name, role, vote, or message is
-- stored. Existing sessions remain valid with a null reason.

alter table public.tomatobot_play_sessions
  add column if not exists abandon_reason text;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'tomatobot_play_sessions_abandon_reason_check'
      and conrelid = 'public.tomatobot_play_sessions'::regclass
  ) then
    alter table public.tomatobot_play_sessions
      add constraint tomatobot_play_sessions_abandon_reason_check
      check (
        abandon_reason is null or abandon_reason in (
          'reroll_role',
          'testing_config',
          'controls',
          'too_long',
          'other'
        )
      );
  end if;
end
$$;

create index if not exists tomatobot_play_sessions_abandon_reason_idx
  on public.tomatobot_play_sessions (abandon_reason, opened_at desc)
  where status in ('cancelled', 'reset') and abandon_reason is not null;

-- Includes unanswered resets so the answer rate is visible and a small number
-- of answers cannot be mistaken for the distribution of all resets.
create or replace view public.tomatobot_abandon_reason_summary
with (security_invoker = true)
as
select
  (opened_at at time zone 'Asia/Tokyo')::date as day_jst,
  case when human_count = 1 then 'solo' else 'multiplayer' end as play_mode,
  coalesce(abandon_phase, 'unknown') as abandon_phase,
  count(*) as abandoned,
  count(*) filter (where abandon_reason is not null) as answered,
  round(
    100.0 * count(*) filter (where abandon_reason is not null) /
      nullif(count(*), 0),
    1
  ) as answer_rate_percent,
  count(*) filter (where abandon_reason = 'reroll_role') as reroll_role,
  count(*) filter (where abandon_reason = 'testing_config') as testing_config,
  count(*) filter (where abandon_reason = 'controls') as controls,
  count(*) filter (where abandon_reason = 'too_long') as too_long,
  count(*) filter (where abandon_reason = 'other') as other
from public.tomatobot_play_sessions
where status in ('cancelled', 'reset')
group by
  (opened_at at time zone 'Asia/Tokyo')::date,
  case when human_count = 1 then 'solo' else 'multiplayer' end,
  coalesce(abandon_phase, 'unknown');

revoke all on table public.tomatobot_abandon_reason_summary
  from anon, authenticated;
grant select on table public.tomatobot_abandon_reason_summary to service_role;
