import pool from "./locations.json";
import { parseFilter, type LocationFilter } from "./regions";
import type { Tier } from "./rules";

export interface PoolLocation {
  lat: number;
  lng: number;
  panoId: string;
  country: string;
  continent: string;
  tier: Tier;
}

export const LOCATION_POOL = pool as PoolLocation[];

export function filterPool(filter: LocationFilter): PoolLocation[] {
  const parsed = parseFilter(filter);
  if (!parsed) return LOCATION_POOL;
  return LOCATION_POOL.filter((l) => (parsed.kind === "country" ? l.country : l.continent) === parsed.value);
}

export function locationKey(l: { lat: number; lng: number }) {
  return `${l.lat.toFixed(4)},${l.lng.toFixed(4)}`;
}
