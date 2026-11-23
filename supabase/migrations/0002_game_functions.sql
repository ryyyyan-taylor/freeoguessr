-- Moves the hot game paths (guessing, ending a round, starting a game or
-- round) into Postgres functions. Each was a chain of 5–15 sequential
-- queries from the API route; as a function it's one round trip, and it
-- runs in a single transaction, so concurrent guesses and round endings
-- can't interleave.
--
-- Called only by the API routes with the secret key (service_role);
-- execute is revoked from everyone else at the bottom.

-- Great-circle distance in metres (mean Earth radius).
create or replace function haversine_m(lat1 float8, lng1 float8, lat2 float8, lng2 float8)
returns float8 language sql immutable as $$
  select 2 * 6371008.8 * asin(least(1, sqrt(
    sin(radians(lat2 - lat1) / 2) ^ 2
    + cos(radians(lat1)) * cos(radians(lat2)) * sin(radians(lng2 - lng1) / 2) ^ 2
  )))
$$;

-- GeoGuessr's community-derived curve: 5000 · e^(−10·d/D), full marks
-- within 25 m. D defaults to the World map's size, 14,916.862 km.
create or replace function score_for_distance(distance_m float8, map_size_m float8 default 14916862)
returns int language sql immutable as $$
  select case
    when distance_m <= 25 then 5000
    else round(5000 * exp(-10 * distance_m / map_size_m))::int
  end
$$;

-- The player with this id/token in this room, or no row.
create or replace function auth_player(p_room_code text, p_player_id uuid, p_token text)
returns setof players language sql stable as $$
  select p.* from players p
  join player_tokens t on t.player_id = p.id
  where p.id = p_player_id and t.token = p_token and p.room_code = p_room_code
$$;

-- Ends the round if its deadline has passed or everyone has guessed:
-- reveals the answer and adds this round's scores to the totals (only now,
-- so totals never leak how close a guess was mid-round). Locks the round
-- row, so exactly one caller does the scoring.
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
  set status = 'finished', ended_at = clock_timestamp(), answer_lat = a.lat, answer_lng = a.lng
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

-- Records a guess for the room's current round. The first guess pulls the
-- deadline in to `p_lock_seconds` from now; the last guess ends the round.
-- Returns {ok, finished} or {error, status}.
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
  v_score := score_for_distance(v_distance);

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

-- Called by every client when its countdown hits zero; whichever arrives
-- first past the deadline ends the round. Harmless to call early or often,
-- so it needs no auth.
create or replace function finish_current_round(p_room_code text)
returns boolean language plpgsql as $$
declare
  g games;
  r rounds;
begin
  select * into g from games where room_code = p_room_code order by started_at desc limit 1;
  if not found then
    return false;
  end if;
  select * into r from rounds where game_id = g.id and round_number = g.current_round;
  if not found then
    return false;
  end if;
  return finish_round_if_done(r.id) or r.status = 'finished';
end;
$$;

-- Locations already used in the room's latest game, so the next round's
-- pick can avoid repeats.
create or replace function used_locations(p_room_code text)
returns table (lat float8, lng float8) language sql stable as $$
  select a.lat, a.lng
  from round_answers a
  join rounds r on r.id = a.round_id
  where r.game_id = (select id from games where room_code = p_room_code order by started_at desc limit 1)
$$;

-- Inserts a round and its hidden answer, and points the game at it.
create or replace function insert_round(p_game_id uuid, p_round_number int, p_lat float8, p_lng float8, p_pano_id text)
returns void language plpgsql as $$
declare
  v_round_id uuid;
  v_seconds int;
begin
  select round_time_seconds into v_seconds from games where id = p_game_id;
  insert into rounds (game_id, round_number, started_at, deadline_at)
  values (p_game_id, p_round_number, clock_timestamp(), clock_timestamp() + make_interval(secs => v_seconds))
  returning id into v_round_id;
  insert into round_answers (round_id, lat, lng, pano_id) values (v_round_id, p_lat, p_lng, p_pano_id);
  update games set current_round = p_round_number where id = p_game_id;
end;
$$;

-- Host starts a game from the lobby with round 1 at the given location.
create or replace function start_game(
  p_room_code text, p_player_id uuid, p_token text, p_lat float8, p_lng float8, p_pano_id text
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

  insert into games (room_code, round_count, round_time_seconds)
  values (p_room_code, v_room.round_count, v_room.round_time_seconds)
  returning id into v_game_id;
  insert into game_players (game_id, player_id)
  select v_game_id, id from players where room_code = p_room_code;
  perform insert_round(v_game_id, 1, p_lat, p_lng, p_pano_id);
  update rooms set status = 'playing' where code = p_room_code;
  return jsonb_build_object('ok', true, 'gameId', v_game_id);
end;
$$;

-- Host moves on from round `p_from_round`'s results. `p_from_round` makes a
-- double-click a no-op instead of skipping a round.
create or replace function start_next_round(
  p_room_code text, p_player_id uuid, p_token text, p_from_round int, p_lat float8, p_lng float8, p_pano_id text
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
  perform insert_round(g.id, r.round_number + 1, p_lat, p_lng, p_pano_id);
  return jsonb_build_object('ok', true);
end;
$$;

-- PostgREST exposes every function in `public` to anyone with the
-- publishable key unless execute is revoked.
revoke execute on function
  haversine_m(float8, float8, float8, float8),
  score_for_distance(float8, float8),
  auth_player(text, uuid, text),
  finish_round_if_done(uuid),
  submit_guess(text, uuid, text, float8, float8, int, int),
  finish_current_round(text),
  used_locations(text),
  insert_round(uuid, int, float8, float8, text),
  start_game(text, uuid, text, float8, float8, text),
  start_next_round(text, uuid, text, int, float8, float8, text)
from public, anon, authenticated;

grant execute on function
  haversine_m(float8, float8, float8, float8),
  score_for_distance(float8, float8),
  auth_player(text, uuid, text),
  finish_round_if_done(uuid),
  submit_guess(text, uuid, text, float8, float8, int, int),
  finish_current_round(text),
  used_locations(text),
  insert_round(uuid, int, float8, float8, text),
  start_game(text, uuid, text, float8, float8, text),
  start_next_round(text, uuid, text, int, float8, float8, text)
to service_role;
