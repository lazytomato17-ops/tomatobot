-- Public monthly rankings. Only players who explicitly opt in are included.

create table if not exists public.tomatobot_ranking_profiles (
  user_id text primary key,
  public_name text not null check (
    char_length(public_name) between 1 and 32
    and public_name !~ E'[\n\r\t]'
  ),
  joined_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.tomatobot_ranking_profiles enable row level security;

revoke all on public.tomatobot_ranking_profiles from anon, authenticated;
grant select, insert, update, delete on public.tomatobot_ranking_profiles to service_role;

create or replace function public.tomatobot_public_rankings(
  p_min_games integer default 5,
  p_limit integer default 20
)
returns table (
  mode text,
  rank_position integer,
  public_name text,
  games bigint,
  wins bigint,
  losses bigint,
  win_rate integer
)
language sql
stable
security definer
set search_path = ''
as $$
  with match_sizes as (
    select match_id, count(*)::integer as human_players
    from public.tomatobot_match_players
    group by match_id
  ),
  current_month_results as (
    select
      player.user_id,
      profile.public_name,
      case when sizes.human_players = 1 then 'solo' else 'friends' end as mode,
      player.won
    from public.tomatobot_match_players as player
    join public.tomatobot_matches as match on match.id = player.match_id
    join match_sizes as sizes on sizes.match_id = player.match_id
    join public.tomatobot_ranking_profiles as profile
      on profile.user_id = player.user_id
    where match.finished_at >= (
      date_trunc('month', now() at time zone 'Asia/Tokyo')
      at time zone 'Asia/Tokyo'
    )
      and match.finished_at < (
        date_trunc('month', now() at time zone 'Asia/Tokyo') + interval '1 month'
      ) at time zone 'Asia/Tokyo'
  ),
  totals as (
    select
      mode,
      user_id,
      public_name,
      count(*)::bigint as games,
      sum(case when won then 1 else 0 end)::bigint as wins
    from current_month_results
    group by mode, user_id, public_name
    having count(*) >= greatest(p_min_games, 1)
  ),
  ranked as (
    select
      mode,
      public_name,
      games,
      wins,
      games - wins as losses,
      round(100.0 * wins / games)::integer as win_rate,
      row_number() over (
        partition by mode
        order by
          (100.0 * wins / games) desc,
          wins desc,
          games desc,
          public_name asc
      )::integer as rank_position
    from totals
  )
  select
    ranked.mode,
    ranked.rank_position,
    ranked.public_name,
    ranked.games,
    ranked.wins,
    ranked.losses,
    ranked.win_rate
  from ranked
  where ranked.rank_position <= least(greatest(p_limit, 1), 100)
  order by ranked.mode, ranked.rank_position;
$$;

revoke all on function public.tomatobot_public_rankings(integer, integer)
  from public, anon, authenticated;
grant execute on function public.tomatobot_public_rankings(integer, integer)
  to service_role;
