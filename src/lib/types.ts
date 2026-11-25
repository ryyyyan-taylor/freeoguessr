export type RoomStatus = "lobby" | "playing";
export type GameStatus = "active" | "finished";
export type RoundStatus = "active" | "finished";
export type { LocationMix, ScoringMode } from "@/lib/rules";
import type { LocationMix, ScoringMode } from "@/lib/rules";

// Shapes returned by our own API routes (camelCase).
export interface Player {
  id: string;
  name: string;
  isHost: boolean;
  connected: boolean;
}

export interface Room {
  code: string;
  status: RoomStatus;
  isPrivate: boolean;
  roundCount: number;
  roundTimeSeconds: number;
  // "country:US", "continent:Europe", or null for the world.
  locationFilter: string | null;
  scoringMode: ScoringMode;
  locationMix: LocationMix;
}

// Returned by GET /api/rooms for the home page's open-room list — already
// filtered to public rooms with a heartbeating player.
export interface OpenRoom {
  code: string;
  hostName: string;
  playerCount: number;
}

export interface Guess {
  playerId: string;
  lat: number;
  lng: number;
  distanceM: number;
  score: number;
  // Where the guess landed (null for open water), and its distance to the
  // answer's country's border (0 if it's in it).
  guessCountry: string | null;
  countryDistanceM: number | null;
}

export interface RoundSnapshot {
  id: string;
  roundNumber: number;
  status: RoundStatus;
  startedAt: string;
  deadlineAt: string;
  // Null while the round is active.
  answer: { lat: number; lng: number; country: string | null } | null;
  // Only filled once the round is finished (every player's guess), or with
  // just the requesting player's own guess while it's still active.
  guesses: Guess[];
}

export interface GameSnapshot {
  id: string;
  status: GameStatus;
  roundCount: number;
  roundTimeSeconds: number;
  locationFilter: string | null;
  scoringMode: ScoringMode;
  currentRound: number;
  players: { playerId: string; totalScore: number; lastGuessedRound: number }[];
  // Every round played so far, oldest first.
  rounds: RoundSnapshot[];
}

// Raw Postgres row shapes, as delivered by postgres_changes payloads
// (snake_case, matching the DB columns directly).
export interface PlayerRow {
  id: string;
  room_code: string;
  name: string;
  is_host: boolean;
  connected: boolean;
}

export interface RoomRow {
  code: string;
  host_player_id: string | null;
  status: RoomStatus;
  is_private: boolean;
  round_count: number;
  round_time_seconds: number;
  location_filter: string | null;
  scoring_mode: ScoringMode;
  location_mix: LocationMix;
}

export interface GameRow {
  id: string;
  room_code: string;
  status: GameStatus;
  round_count: number;
  round_time_seconds: number;
  current_round: number;
}

export interface GamePlayerRow {
  game_id: string;
  player_id: string;
  total_score: number;
  last_guessed_round: number;
}

export interface RoundRow {
  id: string;
  game_id: string;
  round_number: number;
  status: RoundStatus;
  started_at: string;
  deadline_at: string;
  answer_lat: number | null;
  answer_lng: number | null;
}

export function roomFromRow(row: RoomRow): Room {
  return {
    code: row.code,
    status: row.status,
    isPrivate: row.is_private,
    roundCount: row.round_count,
    roundTimeSeconds: row.round_time_seconds,
    locationFilter: row.location_filter,
    scoringMode: row.scoring_mode,
    locationMix: row.location_mix,
  };
}
