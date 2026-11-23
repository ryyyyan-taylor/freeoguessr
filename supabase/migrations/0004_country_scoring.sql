-- Country-first scoring. In 'country' mode a guess anywhere in the right
-- country scores 5000; otherwise the usual exponential curve applies to the
-- distance from the guess to the nearest border of the right country
-- (rather than to the exact spot).
--
-- The guess route works out the guess's distance to every country's border
-- and passes the whole table in, so the answer's country never has to
-- leave the database before the round ends.

alter table rooms add column scoring_mode text not null default 'distance'
  check (scoring_mode in ('distance', 'country'));
alter table games add column scoring_mode text not null default 'distance'
  check (scoring_mode in ('distance', 'country'));

alter table round_answers add column country text;
-- Revealed with the rest of the answer when the round ends.
alter table rounds add column answer_country text;

alter table guesses add column guess_country text;
alter table guesses add column country_distance_m float8;

-- New parameters (the round's country, the guess's countries), so the old
-- signatures go.
drop function start_game(text, uuid, text, float8, float8, text, text, float8);
drop function start_next_round(text, uuid, text, int, float8, float8, text);
drop function insert_round(uuid, int, float8, float8, text);
drop function submit_guess(text, uuid, text, float8, float8, int, int);

create function insert_round(
  p_game_id uuid, p_round_number int, p_lat float8, p_lng float8, p_pano_id text, p_country text
) returns void language plpgsql as $$
declare
  v_round_id uuid;
  v_seconds int;
begin
  select round_time_seconds into v_seconds from games where id = p_game_id;
  insert into rounds (game_id, round_number, started_at, deadline_at)
  values (p_game_id, p_round_number, clock_timestamp(), clock_timestamp() + make_interval(secs => v_seconds))
  returning id into v_round_id;
  insert into round_answers (round_id, lat, lng, pano_id, country)
  values (v_round_id, p_lat, p_lng, p_pano_id, p_country);
  update games set current_round = p_round_number where id = p_game_id;
end;
$$;

create function start_game(
  p_room_code text, p_player_id uuid, p_token text, p_lat float8, p_lng float8, p_pano_id text,
  p_location_filter text, p_map_size_m float8, p_country text
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

  insert into games (room_code, round_count, round_time_seconds, location_filter, map_size_m, scoring_mode)
  values (
    p_room_code, v_room.round_count, v_room.round_time_seconds, p_location_filter, p_map_size_m,
    -- On a single-country map every guess would score 5000.
    case when p_location_filter like 'country:%' then 'distance' else v_room.scoring_mode end
  )
  returning id into v_game_id;
  insert into game_players (game_id, player_id)
  select v_game_id, id from players where room_code = p_room_code;
  perform insert_round(v_game_id, 1, p_lat, p_lng, p_pano_id, p_country);
  update rooms set status = 'playing' where code = p_room_code;
  return jsonb_build_object('ok', true, 'gameId', v_game_id);
end;
$$;

create function start_next_round(
  p_room_code text, p_player_id uuid, p_token text, p_from_round int,
  p_lat float8, p_lng float8, p_pano_id text, p_country text
) returns jsonb language plpgsql as $$
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
  perform insert_round(g.id, r.round_number + 1, p_lat, p_lng, p_pano_id, p_country);
  return jsonb_build_object('ok', true);
end;
$$;

-- Same as 0003's, plus country scoring. `p_guess_country` is the country
-- the guess landed in (null for open water); `p_country_distances` maps
-- every country code to the guess's distance from its border in metres
-- (0 for the country it's in).
create function submit_guess(
  p_room_code text,
  p_player_id uuid,
  p_token text,
  p_lat float8,
  p_lng float8,
  p_grace_ms int,
  p_lock_seconds int,
  p_guess_country text,
  p_country_distances jsonb
) returns jsonb language plpgsql as $$
declare
  v_player players;
  g games;
  r rounds;
  a round_answers;
  v_distance float8;
  v_country_distance float8;
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
  v_country_distance := (p_country_distances ->> a.country)::float8;

  if g.scoring_mode = 'country' and v_country_distance is not null then
    v_score := case when v_country_distance = 0 then 5000
                    else score_for_distance(v_country_distance, g.map_size_m) end;
  else
    v_score := score_for_distance(v_distance, g.map_size_m);
  end if;

  insert into guesses (round_id, player_id, lat, lng, distance_m, score, guess_country, country_distance_m)
  values (r.id, v_player.id, p_lat, p_lng, v_distance, v_score, p_guess_country, v_country_distance)
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

-- Same as 0002's, but also reveals the answer's country.
create or replace function finish_round_if_done(p_round_id uuid)
returns boolean language plpgsql as $$
declare
  r rounds;
  g games;
begin
  select * into r from rounds where id = p_round_id for update;
  if not found or r.status <> 'active' then
    return false;
  end if;
  select * into g from games where id = r.game_id;

  if clock_timestamp() < r.deadline_at
     and (select count(*) from guesses where round_id = r.id)
         < (select count(*) from game_players where game_id = g.id) then
    return false;
  end if;

  update rounds
  set status = 'finished', ended_at = clock_timestamp(),
      answer_lat = a.lat, answer_lng = a.lng, answer_country = a.country
  from round_answers a
  where rounds.id = r.id and a.round_id = r.id;

  update game_players gp
  set total_score = gp.total_score + gu.score
  from guesses gu
  where gu.round_id = r.id and gu.player_id = gp.player_id and gp.game_id = g.id;

  if r.round_number >= g.round_count then
    update games set status = 'finished', ended_at = clock_timestamp() where id = g.id;
  end if;
  return true;
end;
$$;

revoke execute on function
  insert_round(uuid, int, float8, float8, text, text),
  start_game(text, uuid, text, float8, float8, text, text, float8, text),
  start_next_round(text, uuid, text, int, float8, float8, text, text),
  submit_guess(text, uuid, text, float8, float8, int, int, text, jsonb)
from public, anon, authenticated;

grant execute on function
  insert_round(uuid, int, float8, float8, text, text),
  start_game(text, uuid, text, float8, float8, text, text, float8, text),
  start_next_round(text, uuid, text, int, float8, float8, text, text),
  submit_guess(text, uuid, text, float8, float8, int, int, text, jsonb)
to service_role;
