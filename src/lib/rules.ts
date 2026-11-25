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

// How a game's rounds are split between city, town and rural locations
// (tiers from the GHSL Degree of Urbanisation; see
// scripts/generate-locations.mjs). Weights per tier: a 5-round Balanced game
// is exactly 2 city, 2 town, 1 rural, in random order.
export type Tier = "city" | "town" | "rural";
export const TIERS: readonly Tier[] = ["city", "town", "rural"];
export type LocationMix = "balanced" | "built-up" | "cities" | "countryside";
export const LOCATION_MIXES: Record<LocationMix, { label: string; description: string; weights: Record<Tier, number> }> = {
  balanced: {
    label: "Balanced",
    description: "2 city, 2 town, 1 rural in every 5 rounds.",
    weights: { city: 2, town: 2, rural: 1 },
  },
  "built-up": {
    label: "Cities & towns",
    description: "Half city, half town or village. No open country.",
    weights: { city: 1, town: 1, rural: 0 },
  },
  cities: {
    label: "Cities only",
    description: "Big-city streets wherever the map has them.",
    weights: { city: 1, town: 0, rural: 0 },
  },
  countryside: {
    label: "Countryside",
    description: "Open-country roads only.",
    weights: { city: 0, town: 0, rural: 1 },
  },
};
export const isLocationMix = (value: unknown): value is LocationMix =>
  typeof value === "string" && Object.hasOwn(LOCATION_MIXES, value);

export function formatSeconds(seconds: number) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s ? `${m}:${String(s).padStart(2, "0")}` : `${m} min`;
}

export function formatDistance(meters: number) {
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${Math.round(meters / 1000).toLocaleString()} km`;
}
