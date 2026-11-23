// Scoring itself happens in Postgres (score_for_distance and haversine_m in
// supabase/migrations/0002_game_functions.sql), inside the same transaction
// that records the guess.

export const MAX_ROUND_SCORE = 5000;

export interface LatLng {
  lat: number;
  lng: number;
}
