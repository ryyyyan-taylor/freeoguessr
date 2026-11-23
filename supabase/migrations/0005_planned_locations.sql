-- Plans every round's location when the game starts (see src/lib/selection.ts),
-- so a game can be spread across continents and countries instead of each
-- round being an independent draw. Rounds read their location from the
-- plan, which makes "next round" a single call with nothing left to pick.

-- Service-role only, like round_answers.
create table game_locations (
  game_id uuid not null references games(id) on delete cascade,
  round_number int not null,
  lat double precision not null,
  lng double precision not null,
  pano_id text,
  country text,
  primary key (game_id, round_number)
);
alter table game_locations enable row level security;

drop function start_game(text, uuid, text, float8, float8, text, text, float8, text);
drop function start_next_round(text, uuid, text, int, float8, float8, text, text);
drop function insert_round(uuid, int, float8, float8, text, text);
drop function used_locations(text);

-- Starts round `p_round_number` at its planned location.
create function insert_round(p_game_id uuid, p_round_number int)
returns void language plpgsql as $$
declare
  v_round_id uuid;
  v_seconds int;
begin
  select round_time_seconds into v_seconds from games where id = p_game_id;
  insert into rounds (game_id, round_number, started_at, deadline_at)
  values (p_game_id, p_round_number, clock_timestamp(), clock_timestamp() + make_interval(secs => v_seconds))
  returning id into v_round_id;
  insert into round_answers (round_id, lat, lng, pano_id, country)
  select v_round_id, lat, lng, pano_id, country
  from game_locations where game_id = p_game_id and round_number = p_round_number;
  update games set current_round = p_round_number where id = p_game_id;
end;
$$;

-- Host starts a game. `p_locations` is the planned rounds in order:
-- [{lat, lng, panoId, country}, ...]; its length is the round count.
create function start_game(
  p_room_code text, p_player_id uuid, p_token text,
  p_locations jsonb, p_location_filter text, p_map_size_m float8
) returns jsonb language plpgsql as $$
declare
  v_player players;
  v_room rooms;
  v_game_id uuid;
begin
  select * into v_player from auth_player(p_room_code, p_player_id, p_token);
  if not found or not v_player.is_host then
    return jsonb_build_object('error', 'Only the host can start the game', 'status', 403);
  end if;
  -- Locked, so a double-click or a second host tab can't start two games.
  select * into v_room from rooms where code = p_room_code for update;
  if v_room.status <> 'lobby' then
    return jsonb_build_object('error', 'The game has already started', 'status', 409);
  end if;
  if jsonb_array_length(p_locations) < 1 then
    return jsonb_build_object('error', 'No locations to play', 'status', 400);
  end if;

  insert into games (room_code, round_count, round_time_seconds, location_filter, map_size_m, scoring_mode)
  values (
    p_room_code, jsonb_array_length(p_locations), v_room.round_time_seconds, p_location_filter, p_map_size_m,
    -- On a single-country map every guess would score 5000.
    case when p_location_filter like 'country:%' then 'distance' else v_room.scoring_mode end
  )
  returning id into v_game_id;

  insert into game_locations (game_id, round_number, lat, lng, pano_id, country)
  select v_game_id, t.idx, (t.loc ->> 'lat')::float8, (t.loc ->> 'lng')::float8, t.loc ->> 'panoId', t.loc ->> 'country'
  from jsonb_array_elements(p_locations) with ordinality as t(loc, idx);

  insert into game_players (game_id, player_id)
  select v_game_id, id from players where room_code = p_room_code;
  perform insert_round(v_game_id, 1);
  update rooms set status = 'playing' where code = p_room_code;
  return jsonb_build_object('ok', true, 'gameId', v_game_id);
end;
$$;

-- Host moves on from round `p_from_round`'s results. `p_from_round` makes a
-- double-click a no-op instead of skipping a round.
create function start_next_round(p_room_code text, p_player_id uuid, p_token text, p_from_round int)
returns jsonb language plpgsql as $$
declare
  v_player players;
  g games;
  r rounds;
begin
  select * into v_player from auth_player(p_room_code, p_player_id, p_token);
  if not found or not v_player.is_host then
    return jsonb_build_object('error', 'Only the host can start the next round', 'status', 403);
  end if;
  select * into g from games where room_code = p_room_code order by started_at desc limit 1 for update;
  if not found or g.status <> 'active' then
    return jsonb_build_object('error', 'No game in progress', 'status', 409);
  end if;
  select * into r from rounds where game_id = g.id and round_number = g.current_round;
  if r.status <> 'finished' or r.round_number <> p_from_round then
    return jsonb_build_object('error', 'The current round isn''t over yet', 'status', 409);
  end if;
  perform insert_round(g.id, r.round_number + 1);
  return jsonb_build_object('ok', true);
end;
$$;

revoke execute on function
  insert_round(uuid, int),
  start_game(text, uuid, text, jsonb, text, float8),
  start_next_round(text, uuid, text, int)
from public, anon, authenticated;

grant execute on function
  insert_round(uuid, int),
  start_game(text, uuid, text, jsonb, text, float8),
  start_next_round(text, uuid, text, int)
to service_role;
