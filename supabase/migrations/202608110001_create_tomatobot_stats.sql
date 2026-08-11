create table if not exists public.tomatobot_matches (
  id uuid primary key,
  guild_id text not null,
  channel_id text not null,
  winner text not null check (winner in ('villager', 'wolf')),
  day_count integer not null check (day_count >= 1),
  finished_at timestamptz not null default now()
);

create table if not exists public.tomatobot_match_players (
  match_id uuid not null references public.tomatobot_matches(id) on delete cascade,
  user_id text not null,
  display_name text not null,
  role text not null,
  won boolean not null,
  survived boolean not null,
  primary key (match_id, user_id)
);

create table if not exists public.tomatobot_player_stats (
  user_id text primary key,
  display_name text not null,
  games integer not null default 0 check (games >= 0),
  wins integer not null default 0 check (wins >= 0 and wins <= games),
  current_streak integer not null default 0 check (current_streak >= 0),
  best_streak integer not null default 0 check (best_streak >= 0),
  updated_at timestamptz not null default now()
);

create table if not exists public.tomatobot_player_role_stats (
  user_id text not null references public.tomatobot_player_stats(user_id) on delete cascade,
  role text not null,
  games integer not null default 0 check (games >= 0),
  wins integer not null default 0 check (wins >= 0 and wins <= games),
  primary key (user_id, role)
);

create index if not exists tomatobot_matches_finished_at_idx
  on public.tomatobot_matches (finished_at desc);

create index if not exists tomatobot_match_players_user_id_idx
  on public.tomatobot_match_players (user_id);

alter table public.tomatobot_matches enable row level security;
alter table public.tomatobot_match_players enable row level security;
alter table public.tomatobot_player_stats enable row level security;
alter table public.tomatobot_player_role_stats enable row level security;

create or replace function public.tomatobot_record_game_result(
  p_match_id uuid,
  p_guild_id text,
  p_channel_id text,
  p_winner text,
  p_day_count integer,
  p_players jsonb
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  inserted_count integer;
  player_data jsonb;
  player_user_id text;
  player_display_name text;
  player_role text;
  player_won boolean;
  player_survived boolean;
begin
  if p_winner not in ('villager', 'wolf') then
    raise exception 'invalid winner';
  end if;
  if p_day_count < 1 then
    raise exception 'invalid day count';
  end if;
  if jsonb_typeof(p_players) <> 'array' or jsonb_array_length(p_players) = 0 then
    raise exception 'players must be a non-empty array';
  end if;

  insert into public.tomatobot_matches (
    id, guild_id, channel_id, winner, day_count
  ) values (
    p_match_id, p_guild_id, p_channel_id, p_winner, p_day_count
  )
  on conflict (id) do nothing;

  get diagnostics inserted_count = row_count;
  if inserted_count = 0 then
    return false;
  end if;

  for player_data in select value from jsonb_array_elements(p_players)
  loop
    player_user_id := nullif(player_data ->> 'user_id', '');
    player_display_name := left(
      coalesce(nullif(player_data ->> 'display_name', ''), '不明なプレイヤー'),
      100
    );
    player_role := player_data ->> 'role';
    player_won := (player_data ->> 'won')::boolean;
    player_survived := (player_data ->> 'survived')::boolean;

    if player_user_id is null then
      raise exception 'user_id is required';
    end if;
    if player_role not in ('村人', '人狼', '狂人', '占い師', '騎士', '霊能者') then
      raise exception 'invalid role';
    end if;

    insert into public.tomatobot_match_players (
      match_id, user_id, display_name, role, won, survived
    ) values (
      p_match_id,
      player_user_id,
      player_display_name,
      player_role,
      player_won,
      player_survived
    );

    insert into public.tomatobot_player_stats as current (
      user_id,
      display_name,
      games,
      wins,
      current_streak,
      best_streak,
      updated_at
    ) values (
      player_user_id,
      player_display_name,
      1,
      case when player_won then 1 else 0 end,
      case when player_won then 1 else 0 end,
      case when player_won then 1 else 0 end,
      now()
    )
    on conflict (user_id) do update set
      display_name = excluded.display_name,
      games = current.games + 1,
      wins = current.wins + case when player_won then 1 else 0 end,
      current_streak = case
        when player_won then current.current_streak + 1
        else 0
      end,
      best_streak = case
        when player_won then greatest(current.best_streak, current.current_streak + 1)
        else current.best_streak
      end,
      updated_at = now();

    insert into public.tomatobot_player_role_stats as current (
      user_id, role, games, wins
    ) values (
      player_user_id,
      player_role,
      1,
      case when player_won then 1 else 0 end
    )
    on conflict (user_id, role) do update set
      games = current.games + 1,
      wins = current.wins + case when player_won then 1 else 0 end;
  end loop;

  return true;
end;
$$;

revoke all on public.tomatobot_matches from anon, authenticated;
revoke all on public.tomatobot_match_players from anon, authenticated;
revoke all on public.tomatobot_player_stats from anon, authenticated;
revoke all on public.tomatobot_player_role_stats from anon, authenticated;
grant select, insert, update, delete on public.tomatobot_matches to service_role;
grant select, insert, update, delete on public.tomatobot_match_players to service_role;
grant select, insert, update, delete on public.tomatobot_player_stats to service_role;
grant select, insert, update, delete on public.tomatobot_player_role_stats to service_role;
revoke execute on function public.tomatobot_record_game_result(
  uuid, text, text, text, integer, jsonb
) from public, anon, authenticated;
grant execute on function public.tomatobot_record_game_result(
  uuid, text, text, text, integer, jsonb
) to service_role;
