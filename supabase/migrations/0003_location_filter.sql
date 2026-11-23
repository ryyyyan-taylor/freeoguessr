-- Country/continent filtering. A filter is 'country:US', 'continent:Europe',
-- or null for the whole world.
--
-- Like GeoGuessr, scoring scales with the map's size: a 500 km miss is
-- nearly perfect on the World map but poor on a Luxembourg-only one. Each
-- game stores the size of the region it was started with.

alter table rooms add column location_filter text;
alter table games add column location_filter text;
alter table games add column map_size_m float8 not null default 14916862;

-- start_game gains the filter and map size, so the old signature goes.
drop function start_game(text, uuid, text, float8, float8, text);

create or replace function start_game(
  p_room_code text, p_player_id uuid, p_token text, p_lat float8, p_lng float8, p_pano_id text,
  p_location_filter text, p_map_size_m float8
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

  insert into games (room_code, round_count, round_time_seconds, location_filter, map_size_m)
  values (p_room_code, v_room.round_count, v_room.round_time_seconds, p_location_filter, p_map_size_m)
  returning id into v_game_id;
  insert into game_players (game_id, player_id)
  select v_game_id, id from players where room_code = p_room_code;
  perform insert_round(v_game_id, 1, p_lat, p_lng, p_pano_id);
  update rooms set status = 'playing' where code = p_room_code;
  return jsonb_build_object('ok', true, 'gameId', v_game_id);
end;
$$;

-- Same as 0002's, except the score uses the game's map size.
create or replace function submit_guess(
  p_room_code text,
  p_player_id uuid,
  p_token text,
  p_lat float8,
  p_lng float8,
  p_grace_ms int,
  p_lock_seconds int
) returns jsonb language plpgsql as $$
declare
  v_player players;
  g games;
  r rounds;
  a round_answers;
  v_distance float8;
  v_score int;
  v_count int;
begin
  select * into v_player from auth_player(p_room_code, p_player_id, p_token);
  if not found then
    return jsonb_build_object('error', 'Not authenticated', 'status', 403);
  end if;

  select * into g from games where room_code = p_room_code order by started_at desc limit 1;
  if not found or g.status <> 'active' then
    return jsonb_build_object('error', 'No round in progress', 'status', 409);
  end if;

  select * into r from rounds where game_id = g.id and round_number = g.current_round for update;
  if not found or r.status <> 'active' then
    return jsonb_build_object('error', 'No round in progress', 'status', 409);
  end if;
  if clock_timestamp() > r.deadline_at + make_interval(secs => p_grace_ms / 1000.0) then
    return jsonb_build_object('error', 'Time''s up', 'status', 409);
  end if;
  if not exists (select 1 from game_players where game_id = g.id and player_id = v_player.id) then
    return jsonb_build_object('error', 'You''re not in this game', 'status', 403);
  end if;

  select * into a from round_answers where round_id = r.id;
  v_distance := haversine_m(p_lat, p_lng, a.lat, a.lng);
  v_score := score_for_distance(v_distance, g.map_size_m);

  insert into guesses (round_id, player_id, lat, lng, distance_m, score)
  values (r.id, v_player.id, p_lat, p_lng, v_distance, v_score)
  on conflict do nothing;
  if not found then
    return jsonb_build_object('error', 'You''ve already guessed this round', 'status', 409);
  end if;

  update game_players set last_guessed_round = r.round_number
  where game_id = g.id and player_id = v_player.id;

  select count(*) into v_count from guesses where round_id = r.id;
  if v_count = 1 then
    update rounds
    set deadline_at = least(deadline_at, clock_timestamp() + make_interval(secs => p_lock_seconds))
    where id = r.id;
  end if;

  return jsonb_build_object('ok', true, 'finished', finish_round_if_done(r.id));
end;
$$;

revoke execute on function start_game(text, uuid, text, float8, float8, text, text, float8) from public, anon, authenticated;
grant execute on function start_game(text, uuid, text, float8, float8, text, text, float8) to service_role;
