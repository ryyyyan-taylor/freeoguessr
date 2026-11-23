import regionsData from "./regions.json";

// Client-safe: the region list is small. The full location pool
// (locations.json) stays server-side.

export interface RegionBounds {
  north: number;
  south: number;
  east: number;
  west: number;
}

export interface Region {
  count: number;
  // Scoring scale: distance between the region's two furthest locations.
  mapSizeM: number;
  bounds: RegionBounds;
}

export interface CountryRegion extends Region {
  name: string;
  continent: string;
}

export const CONTINENTS = regionsData.continents as Record<string, Region>;
export const COUNTRIES = regionsData.countries as Record<string, CountryRegion>;

// GeoGuessr's World map size; used when there's no filter.
export const WORLD_MAP_SIZE_M = 14_916_862;

// Countries with fewer locations than this aren't offered as a filter.
export const MIN_FILTER_LOCATIONS = 10;

// A filter is "country:US", "continent:Europe", or null for the world.
export type LocationFilter = string | null;

export function parseFilter(filter: LocationFilter): { kind: "country" | "continent"; value: string } | null {
  if (!filter) return null;
  const [kind, value] = filter.split(":", 2);
  if (kind === "country" && COUNTRIES[value]) return { kind, value };
  if (kind === "continent" && CONTINENTS[value]) return { kind, value };
  return null;
}

export function isValidFilter(filter: unknown): filter is LocationFilter {
  if (filter === null) return true;
  if (typeof filter !== "string") return false;
  const parsed = parseFilter(filter);
  if (!parsed) return false;
  return parsed.kind === "continent" || COUNTRIES[parsed.value].count >= MIN_FILTER_LOCATIONS;
}

export function regionFor(filter: LocationFilter): Region | null {
  const parsed = parseFilter(filter);
  if (!parsed) return null;
  return parsed.kind === "country" ? COUNTRIES[parsed.value] : CONTINENTS[parsed.value];
}

export function filterLabel(filter: LocationFilter): string {
  const parsed = parseFilter(filter);
  if (!parsed) return "World";
  return parsed.kind === "country" ? COUNTRIES[parsed.value].name : parsed.value;
}

export function mapSizeFor(filter: LocationFilter): number {
  return regionFor(filter)?.mapSizeM ?? WORLD_MAP_SIZE_M;
}

// Countries offered as filters, grouped by continent, for the lobby picker.
export function countriesByContinent(): [string, [string, CountryRegion][]][] {
  const groups = new Map<string, [string, CountryRegion][]>();
  for (const [code, country] of Object.entries(COUNTRIES)) {
    if (country.count < MIN_FILTER_LOCATIONS) continue;
    if (!groups.has(country.continent)) groups.set(country.continent, []);
    groups.get(country.continent)!.push([code, country]);
  }
  return [...groups].sort(([a], [b]) => a.localeCompare(b));
}
