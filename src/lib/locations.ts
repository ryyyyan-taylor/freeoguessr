import pool from "./locations.json";
import { parseFilter, type LocationFilter } from "./regions";

export interface PoolLocation {
  lat: number;
  lng: number;
  panoId: string;
  country: string;
  continent: string;
}

export const LOCATION_POOL = pool as PoolLocation[];

export function filterPool(filter: LocationFilter): PoolLocation[] {
  const parsed = parseFilter(filter);
  if (!parsed) return LOCATION_POOL;
  return LOCATION_POOL.filter((l) => (parsed.kind === "country" ? l.country : l.continent) === parsed.value);
}

// A random location from the filtered pool that hasn't been used yet this
// game. Null if the filter has run out.
export function pickLocation(filter: LocationFilter, usedKeys: Set<string>): PoolLocation | null {
  const candidates = filterPool(filter).filter((l) => !usedKeys.has(locationKey(l)));
  if (candidates.length === 0) return null;
  return candidates[Math.floor(Math.random() * candidates.length)];
}

export function locationKey(l: { lat: number; lng: number }) {
  return `${l.lat.toFixed(4)},${l.lng.toFixed(4)}`;
}
