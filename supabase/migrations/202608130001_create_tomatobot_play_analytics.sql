create table if not exists public.tomatobot_play_sessions (
  id uuid primary key,
  source_session_id uuid,
  guild_id text not null,
  channel_id text not null,
  status text not null check (status in ('lobby', 'started', 'completed', 'cancelled', 'reset')),
  target_player_count integer not null check (target_player_count >= 1),
  human_count integer not null check (human_count >= 0),
  npc_count integer not null check (npc_count >= 0),
  role_config jsonb not null default '{}'::jsonb,
  winner text check (winner in ('villager', 'wolf')),
  day_count integer check (day_count >= 0),
  duration_seconds integer check (duration_seconds >= 0),
  opened_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  rematch_requested_at timestamptz
);

create table if not exists public.tomatobot_match_feedback (
  session_id uuid not null references public.tomatobot_play_sessions(id) on delete cascade,
  user_id text not null,
  rating text not null check (rating in ('again', 'neutral', 'issue')),
  comment text check (comment is null or char_length(comment) <= 1000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (session_id, user_id)
);

create index if not exists tomatobot_play_sessions_opened_at_idx
  on public.tomatobot_play_sessions (opened_at desc);

create index if not exists tomatobot_play_sessions_status_idx
  on public.tomatobot_play_sessions (status, opened_at desc);

create index if not exists tomatobot_match_feedback_rating_idx
  on public.tomatobot_match_feedback (rating, created_at desc);

alter table public.tomatobot_play_sessions enable row level security;
alter table public.tomatobot_match_feedback enable row level security;

create or replace view public.tomatobot_play_daily_summary
with (security_invoker = true)
as
with feedback_by_session as (
  select
    session_id,
    count(*) filter (where rating = 'again') as again_count,
    count(*) filter (where rating = 'neutral') as neutral_count,
    count(*) filter (where rating = 'issue') as issue_count
  from public.tomatobot_match_feedback
  group by session_id
)
select
  date_trunc('day', session.opened_at) as day,
  count(*) as lobbies,
  count(*) filter (where session.started_at is not null) as started,
  count(*) filter (where session.status = 'completed') as completed,
  count(*) filter (where session.status in ('cancelled', 'reset')) as abandoned,
  count(*) filter (where session.rematch_requested_at is not null) as rematches,
  round(
    100.0 * count(*) filter (where session.status = 'completed') /
    nullif(count(*) filter (where session.started_at is not null), 0),
    1
  ) as completion_rate_percent,
  round(avg(session.duration_seconds) filter (where session.status = 'completed')) as average_completed_seconds,
  coalesce(sum(feedback.again_count), 0) as feedback_again,
  coalesce(sum(feedback.neutral_count), 0) as feedback_neutral,
  coalesce(sum(feedback.issue_count), 0) as feedback_issue
from public.tomatobot_play_sessions as session
left join feedback_by_session as feedback on feedback.session_id = session.id
group by date_trunc('day', session.opened_at);

revoke all on table public.tomatobot_play_sessions from anon, authenticated;
revoke all on table public.tomatobot_match_feedback from anon, authenticated;
revoke all on table public.tomatobot_play_daily_summary from anon, authenticated;
grant all on table public.tomatobot_play_sessions to service_role;
grant all on table public.tomatobot_match_feedback to service_role;
grant select on table public.tomatobot_play_daily_summary to service_role;
