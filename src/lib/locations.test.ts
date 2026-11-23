import { describe, expect, it } from "vitest";
import { filterPool, LOCATION_POOL, locationKey, pickLocation } from "./locations";
import { CONTINENTS, COUNTRIES, countriesByContinent, isValidFilter, mapSizeFor, WORLD_MAP_SIZE_M } from "./regions";

describe("location pool", () => {
  it("has valid coordinates, a panorama and a region for every entry", () => {
    for (const l of LOCATION_POOL) {
      expect(Math.abs(l.lat)).toBeLessThanOrEqual(90);
      expect(Math.abs(l.lng)).toBeLessThanOrEqual(180);
      expect(l.panoId).toBeTruthy();
      expect(COUNTRIES[l.country]).toBeDefined();
      expect(CONTINENTS[l.continent]).toBeDefined();
    }
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

  it("only picks locations inside the filter, without repeats", () => {
    const [code] = Object.keys(COUNTRIES);
    const used = new Set<string>();
    for (let i = 0; i < Math.min(10, COUNTRIES[code].count); i++) {
      const l = pickLocation(`country:${code}`, used)!;
      expect(l.country).toBe(code);
      expect(used.has(locationKey(l))).toBe(false);
      used.add(locationKey(l));
    }
  });

  it("scales the map size to the region", () => {
    expect(mapSizeFor(null)).toBe(WORLD_MAP_SIZE_M);
    for (const country of Object.values(COUNTRIES)) expect(country.mapSizeM).toBeLessThan(20_100_000);
  });
});
