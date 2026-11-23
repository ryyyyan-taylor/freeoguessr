// Shared by the client and API routes; keep free of server-only imports.

export const ROUND_TIME_OPTIONS = [30, 60, 90, 120, 180, 300] as const;
export const MAX_ROUNDS = 10;

// "distance": classic GeoGuessr, scored by distance to the exact spot.
// "country": the right country scores 5000; otherwise scored by distance
// to that country's nearest border.
export type ScoringMode = "distance" | "country";
export const SCORING_MODES: readonly string[] = ["distance", "country"];
export const SCORING_MODE_LABELS: Record<ScoringMode, string> = {
  distance: "Distance (classic)",
  country: "Country first",
};

export function formatSeconds(seconds: number) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s ? `${m}:${String(s).padStart(2, "0")}` : `${m} min`;
}

export function formatDistance(meters: number) {
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${Math.round(meters / 1000).toLocaleString()} km`;
}
