-- Freeoguessr schema.
--
-- Same trust model as wiki-race: no Supabase Auth. Every write goes through
-- Next.js API routes using the secret key (service_role), and each player proves who
-- they are with the per-player `token` stored in their tab's sessionStorage.
--
-- Realtime uses Postgres Changes, which enforces RLS as the anon role, so
-- the tables clients subscribe to get a public-read policy. Anything that
-- would give away an answer (the round's true location, other players'
-- guesses while a round is still open) lives in tables with RLS on and NO
-- policies, so only the service role can read them; API routes hand them
-- out once the round is over.

create table rooms (
  code text primary key,
  host_player_id uuid,
  status text not null default 'lobby' check (status in ('lobby', 'playing')),
  -- Private rooms (including solo games) are joinable by code but never
  -- appear in the home page's open-room list.
  is_private boolean not null default false,
  -- Host-configurable rules for the next game.
  round_count int not null default 5 check (round_count between 1 and 10),
  round_time_seconds int not null default 120 check (round_time_seconds between 10 and 600),
  created_at timestamptz not null default now()
);

create table players (
  id uuid primary key default gen_random_uuid(),
  room_code text not null references rooms(code) on delete cascade,
  name text not null,
  is_host boolean not null default false,
  connected boolean not null default true,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

alter table rooms
  add constraint rooms_host_player_id_fkey
  foreign key (host_player_id) references players(id) on delete set null;

-- Each player's secret token, kept out of `players` because that table is
-- public-read (for Realtime). Service-role only.
create table player_tokens (
  player_id uuid primary key references players(id) on delete cascade,
  token text not null unique
);

-- One run of N rounds. Rules are copied from the room at start, so the host
-- changing them mid-game only affects the next game.
create table games (
  id uuid primary key default gen_random_uuid(),
  room_code text not null references rooms(code) on delete cascade,
  status text not null default 'active' check (status in ('active', 'finished')),
  round_count int not null,
  round_time_seconds int not null,
  current_round int not null default 1,
  started_at timestamptz not null default now(),
  ended_at timestamptz
);

create index games_room_idx on games (room_code, started_at desc);

-- A player's participation in a game. `last_guessed_round` is the public
-- "has this player guessed yet" signal; the guess itself stays hidden in
-- `guesses` until the round ends.
create table game_players (
  game_id uuid not null references games(id) on delete cascade,
  player_id uuid not null references players(id) on delete cascade,
  total_score int not null default 0,
  last_guessed_round int not null default 0,
  primary key (game_id, player_id)
);

-- Public round state. `deadline_at` starts at started_at + round time and
-- is pulled in to (first guess + 10s) when someone guesses first. The
-- answer columns stay null until the round is finished.
create table rounds (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references games(id) on delete cascade,
  round_number int not null,
  status text not null default 'active' check (status in ('active', 'finished')),
  started_at timestamptz not null default now(),
  deadline_at timestamptz not null,
  ended_at timestamptz,
  answer_lat double precision,
  answer_lng double precision,
  unique (game_id, round_number)
);

-- The real location for each round. Service-role only.
create table round_answers (
  round_id uuid primary key references rounds(id) on delete cascade,
  lat double precision not null,
  lng double precision not null,
  pano_id text
);

-- Service-role only; revealed through the API once the round is finished.
create table guesses (
  round_id uuid not null references rounds(id) on delete cascade,
  player_id uuid not null references players(id) on delete cascade,
  lat double precision not null,
  lng double precision not null,
  distance_m double precision not null,
  score int not null,
  guessed_at timestamptz not null default now(),
  primary key (round_id, player_id)
);

alter table rooms enable row level security;
alter table players enable row level security;
alter table player_tokens enable row level security;
alter table games enable row level security;
alter table game_players enable row level security;
alter table rounds enable row level security;
alter table round_answers enable row level security;
alter table guesses enable row level security;

create policy "public read" on rooms for select using (true);
create policy "public read" on players for select using (true);
create policy "public read" on games for select using (true);
create policy "public read" on game_players for select using (true);
create policy "public read" on rounds for select using (true);
-- player_tokens, round_answers and guesses: deliberately no policies.

alter publication supabase_realtime add table rooms, players, games, game_players, rounds;

-- Purge rooms older than 24 hours; everything else cascades from `rooms`.
-- If `create extension` errors on permissions, enable pg_cron under
-- Database -> Extensions in the dashboard and re-run just cron.schedule.
create extension if not exists pg_cron with schema extensions;

select cron.schedule(
  'cleanup-stale-rooms',
  '0 * * * *',
  $$ delete from public.rooms where created_at < now() - interval '24 hours'; $$
);
