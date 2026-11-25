import { describe, expect, it } from "vitest";
import { filterPool, LOCATION_POOL, locationKey } from "./locations";
import { CONTINENTS, COUNTRIES, countriesByContinent, isValidFilter, mapSizeFor, WORLD_MAP_SIZE_M } from "./regions";

describe("location pool", () => {
  it("has valid coordinates, a panorama, a region and a tier for every entry", () => {
    // One expect per entry is too slow for a 100k pool; collect the bad ones.
    const bad = LOCATION_POOL.filter(
      (l) =>
        !(Math.abs(l.lat) <= 90) ||
        !(Math.abs(l.lng) <= 180) ||
        !l.panoId ||
        !COUNTRIES[l.country] ||
        !CONTINENTS[l.continent] ||
        !["city", "town", "rural"].includes(l.tier)
    );
    expect(bad).toEqual([]);
  });

  it("has no duplicate locations", () => {
    expect(new Set(LOCATION_POOL.map(locationKey)).size).toBe(LOCATION_POOL.length);
  });

  it("agrees with the region counts", () => {
    for (const [code, country] of Object.entries(COUNTRIES)) {
      expect(filterPool(`country:${code}`)).toHaveLength(country.count);
    }
    for (const [name, continent] of Object.entries(CONTINENTS)) {
      expect(filterPool(`continent:${name}`)).toHaveLength(continent.count);
    }
  });
});

describe("filters", () => {
  it("accepts world, continents and countries with enough locations", () => {
    expect(isValidFilter(null)).toBe(true);
    for (const name of Object.keys(CONTINENTS)) expect(isValidFilter(`continent:${name}`)).toBe(true);
    for (const [, countries] of countriesByContinent()) {
      for (const [code] of countries) expect(isValidFilter(`country:${code}`)).toBe(true);
    }
  });

  it("rejects unknown or malformed filters", () => {
    expect(isValidFilter("country:ZZ")).toBe(false);
    expect(isValidFilter("continent:Atlantis")).toBe(false);
    expect(isValidFilter("US")).toBe(false);
    expect(isValidFilter(42)).toBe(false);
  });

  it("scales the map size to the region", () => {
    expect(mapSizeFor(null)).toBe(WORLD_MAP_SIZE_M);
    for (const country of Object.values(COUNTRIES)) expect(country.mapSizeM).toBeLessThan(20_100_000);
  });
});
