-- Extend the anonymous install funnel with the two missing conversion steps:
-- onboarding quick-start click and first completed game.

alter table public.tomatobot_guild_funnel
  add column if not exists quick_start_clicked_at timestamptz,
  add column if not exists first_completed_at timestamptz;

create or replace function public.tomatobot_record_guild_funnel_event(
  p_guild_hash text,
  p_event text,
  p_occurred_at timestamptz default now(),
  p_app_version text default 'unknown'
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  event_at timestamptz := coalesce(p_occurred_at, now());
  version_text text := left(coalesce(nullif(trim(p_app_version), ''), 'unknown'), 100);
begin
  if p_guild_hash is null or p_guild_hash !~ '^g1:[0-9a-f]{64}$' then
    raise exception 'invalid anonymous guild identifier';
  end if;
  if p_event is null or p_event not in (
    'installed',
    'onboarding_sent',
    'quick_start_clicked',
    'lobby_opened',
    'game_started',
    'game_completed',
    'removed'
  ) then
    raise exception 'invalid guild funnel event';
  end if;

  insert into public.tomatobot_guild_funnel as funnel (
    guild_hash,
    first_seen_at,
    installed_at,
    last_installed_at,
    install_count,
    onboarding_sent_at,
    quick_start_clicked_at,
    first_lobby_at,
    first_started_at,
    first_completed_at,
    removed_at,
    app_version,
    updated_at
  )
  values (
    p_guild_hash,
    event_at,
    case when p_event = 'installed' then event_at end,
    case when p_event = 'installed' then event_at end,
    case when p_event = 'installed' then 1 else 0 end,
    case when p_event = 'onboarding_sent' then event_at end,
    case when p_event = 'quick_start_clicked' then event_at end,
    case when p_event = 'lobby_opened' then event_at end,
    case when p_event in ('game_started', 'game_completed') then event_at end,
    case when p_event = 'game_completed' then event_at end,
    case when p_event = 'removed' then event_at end,
    version_text,
    event_at
  )
  on conflict (guild_hash) do update set
    first_seen_at = least(
      funnel.first_seen_at,
      excluded.first_seen_at
    ),
    installed_at = case
      when p_event = 'installed'
        then coalesce(funnel.installed_at, event_at)
      else funnel.installed_at
    end,
    last_installed_at = case
      when p_event = 'installed'
        and (funnel.installed_at is null or funnel.removed_at is not null)
        then event_at
      else funnel.last_installed_at
    end,
    install_count = funnel.install_count +
      case
        when p_event = 'installed'
          and (funnel.installed_at is null or funnel.removed_at is not null)
          then 1
        else 0
      end,
    onboarding_sent_at = case
      when p_event = 'onboarding_sent'
        then coalesce(funnel.onboarding_sent_at, event_at)
      else funnel.onboarding_sent_at
    end,
    quick_start_clicked_at = case
      when p_event = 'installed'
        and funnel.installed_at is null
        and funnel.quick_start_clicked_at < event_at
        then null
      when p_event = 'quick_start_clicked'
        then coalesce(funnel.quick_start_clicked_at, event_at)
      else funnel.quick_start_clicked_at
    end,
    first_lobby_at = case
      when p_event = 'installed'
        and funnel.installed_at is null
        and funnel.first_lobby_at < event_at
        then null
      when p_event = 'lobby_opened'
        then coalesce(funnel.first_lobby_at, event_at)
      else funnel.first_lobby_at
    end,
    first_started_at = case
      when p_event = 'installed'
        and funnel.installed_at is null
        and funnel.first_started_at < event_at
        then null
      when p_event in ('game_started', 'game_completed')
        then coalesce(funnel.first_started_at, event_at)
      else funnel.first_started_at
    end,
    first_completed_at = case
      when p_event = 'installed'
        and funnel.installed_at is null
        and funnel.first_completed_at < event_at
        then null
      when p_event = 'game_completed'
        then coalesce(funnel.first_completed_at, event_at)
      else funnel.first_completed_at
    end,
    removed_at = case
      when p_event = 'installed'
        and (funnel.installed_at is null or funnel.removed_at is not null)
        then null
      when p_event = 'removed' then event_at
      else funnel.removed_at
    end,
    app_version = version_text,
    updated_at = greatest(funnel.updated_at, event_at);
end;
$$;

revoke execute on function public.tomatobot_record_guild_funnel_event(
  text,
  text,
  timestamptz,
  text
) from public, anon, authenticated;
grant execute on function public.tomatobot_record_guild_funnel_event(
  text,
  text,
  timestamptz,
  text
) to service_role;
