-- Remove raw Discord guild/channel IDs from historical analytics and match rows.
-- Random legacy aliases preserve anonymous play-analytics grouping. Personal
-- stats do not need location, so their location is discarded instead.

begin;

create temporary table tomatobot_legacy_guild_aliases on commit drop as
select
  raw_id,
  'legacy:g:' || gen_random_uuid()::text as anonymous_id
from (
  select distinct guild_id as raw_id from public.tomatobot_play_sessions
) as locations
where raw_id ~ '^[0-9]{15,22}$';

update public.tomatobot_play_sessions as session
set guild_id = alias.anonymous_id
from tomatobot_legacy_guild_aliases as alias
where session.guild_id = alias.raw_id;

create temporary table tomatobot_legacy_channel_aliases on commit drop as
select
  raw_id,
  'legacy:c:' || gen_random_uuid()::text as anonymous_id
from (
  select distinct channel_id as raw_id from public.tomatobot_play_sessions
) as locations
where raw_id ~ '^[0-9]{15,22}$';

update public.tomatobot_play_sessions as session
set channel_id = alias.anonymous_id
from tomatobot_legacy_channel_aliases as alias
where session.channel_id = alias.raw_id;

update public.tomatobot_matches
set
  guild_id = 'not-collected',
  channel_id = 'not-collected'
where guild_id <> 'not-collected' or channel_id <> 'not-collected';

-- Older releases reused the anonymous play-session UUID as the personal-stats
-- match UUID. Re-key only those overlapping rows and preserve all stats links.
create temporary table tomatobot_legacy_match_aliases on commit drop as
select
  stats_match.id as old_id,
  gen_random_uuid() as new_id
from public.tomatobot_matches as stats_match
join public.tomatobot_play_sessions as session on session.id = stats_match.id;

insert into public.tomatobot_matches (
  id,
  guild_id,
  channel_id,
  winner,
  day_count,
  finished_at
)
select
  alias.new_id,
  stats_match.guild_id,
  stats_match.channel_id,
  stats_match.winner,
  stats_match.day_count,
  stats_match.finished_at
from public.tomatobot_matches as stats_match
join tomatobot_legacy_match_aliases as alias on alias.old_id = stats_match.id;

update public.tomatobot_match_players as player
set match_id = alias.new_id
from tomatobot_legacy_match_aliases as alias
where player.match_id = alias.old_id;

delete from public.tomatobot_matches as stats_match
using tomatobot_legacy_match_aliases as alias
where stats_match.id = alias.old_id;

-- Reject future regressions that try to persist raw Discord snowflakes again.
alter table public.tomatobot_play_sessions
  drop constraint if exists tomatobot_play_sessions_no_raw_guild_id;
alter table public.tomatobot_play_sessions
  add constraint tomatobot_play_sessions_no_raw_guild_id
  check (guild_id !~ '^[0-9]{15,22}$');
alter table public.tomatobot_play_sessions
  drop constraint if exists tomatobot_play_sessions_no_raw_channel_id;
alter table public.tomatobot_play_sessions
  add constraint tomatobot_play_sessions_no_raw_channel_id
  check (channel_id !~ '^[0-9]{15,22}$');

alter table public.tomatobot_matches
  drop constraint if exists tomatobot_matches_location_not_collected;
alter table public.tomatobot_matches
  add constraint tomatobot_matches_location_not_collected
  check (guild_id = 'not-collected' and channel_id = 'not-collected');

commit;
