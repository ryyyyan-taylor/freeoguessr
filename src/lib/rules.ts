// Shared by the client and API routes; keep free of server-only imports.

export const ROUND_TIME_OPTIONS = [30, 60, 90, 120, 180, 300] as const;
export const MAX_ROUNDS = 10;

export function formatSeconds(seconds: number) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s ? `${m}:${String(s).padStart(2, "0")}` : `${m} min`;
}

export function formatDistance(meters: number) {
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${Math.round(meters / 1000).toLocaleString()} km`;
}
