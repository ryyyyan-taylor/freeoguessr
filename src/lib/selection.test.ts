import { describe, expect, it } from "vitest";
import { planLocations, tierSequence } from "./selection";
import { LOCATION_MIXES, type LocationMix } from "./rules";
import { filterPool, locationKey, type PoolLocation } from "./locations";
import { COUNTRIES } from "./regions";

// Seeded so the statistical checks are deterministic.
function seeded(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const average = (games: PoolLocation[][], measure: (g: PoolLocation[]) => number) =>
  games.reduce((s, g) => s + measure(g), 0) / games.length;

describe("planLocations", () => {
  it("returns the requested number of distinct locations", () => {
    const rng = seeded(1);
    for (const rounds of [1, 5, 10]) {
      const plan = planLocations(null, rounds, "balanced", rng);
      expect(plan).toHaveLength(rounds);
      expect(new Set(plan.map(locationKey)).size).toBe(rounds);
    }
  });

  it("never repeats a country in a World game", () => {
    const rng = seeded(2);
    for (let i = 0; i < 200; i++) {
      const plan = planLocations(null, 10, "balanced", rng);
      expect(new Set(plan.map((l) => l.country)).size).toBe(10);
    }
  });

  it("spreads World games across more continents than a random draw", () => {
    const rng = seeded(3);
    const pool = filterPool(null);
    const planned = Array.from({ length: 1000 }, () => planLocations(null, 5, "balanced", rng));
    const random = Array.from({ length: 1000 }, () =>
      Array.from({ length: 5 }, () => pool[Math.floor(rng() * pool.length)])
    );
    const continents = (g: PoolLocation[]) => new Set(g.map((l) => l.continent)).size;
    expect(average(planned, continents)).toBeGreaterThan(4.2);
    expect(average(planned, continents)).toBeGreaterThan(average(random, continents) + 0.7);
  });

  it("keeps every continent between 10% and 25% of World rounds", () => {
    const rng = seeded(4);
    const counts = new Map<string, number>();
    for (let i = 0; i < 2000; i++)
      for (const l of planLocations(null, 5, "balanced", rng)) counts.set(l.continent, (counts.get(l.continent) ?? 0) + 1);
    for (const n of counts.values()) {
      expect(n / 10_000).toBeGreaterThan(0.1);
      expect(n / 10_000).toBeLessThan(0.25);
    }
  });

  it("stays inside the filter and doesn't repeat countries on a continent map", () => {
    const rng = seeded(5);
    for (let i = 0; i < 100; i++) {
      const plan = planLocations("continent:Europe", 5, "balanced", rng);
      expect(plan.every((l) => l.continent === "Europe")).toBe(true);
      expect(new Set(plan.map((l) => l.country)).size).toBe(5);
    }
  });

  it("spreads a single-country game out more than a random draw", () => {
    const rng = seeded(6);
    const pool = filterPool("country:US");
    const closestPair = (g: PoolLocation[]) => {
      let min = Infinity;
      for (let i = 0; i < g.length; i++)
        for (let j = i + 1; j < g.length; j++)
          min = Math.min(min, Math.hypot(g[i].lat - g[j].lat, (g[i].lng - g[j].lng) * Math.cos((g[i].lat * Math.PI) / 180)));
      return min;
    };
    const planned = Array.from({ length: 300 }, () => planLocations("country:US", 5, "balanced", rng));
    // City spots cluster in metros, so compare with random spots of the
    // same tiers, not the whole pool.
    const random = planned.map((g) =>
      g.map(({ tier }) => {
        const same = pool.filter((l) => l.tier === tier);
        return same[Math.floor(rng() * same.length)];
      })
    );
    expect(planned.every((g) => g.every((l) => l.country === "US"))).toBe(true);
    expect(average(planned, closestPair)).toBeGreaterThan(2 * average(random, closestPair));
  });

  it("reuses countries (spread out) once a filter runs out of them", () => {
    const [code] = Object.entries(COUNTRIES).find(([, c]) => c.continent === "Oceania" && c.count >= 40)!;
    const rng = seeded(7);
    const plan = planLocations(`country:${code}`, 10, "balanced", rng);
    expect(new Set(plan.map(locationKey)).size).toBe(10);
  });

  it("refuses when the filter doesn't have enough locations", () => {
    const [code, small] = Object.entries(COUNTRIES).sort((a, b) => a[1].count - b[1].count)[0];
    expect(() => planLocations(`country:${code}`, small.count + 1)).toThrow();
  });
});

describe("location mix", () => {
  it("splits a 5-round Balanced game 2 city, 2 town, 1 rural", () => {
    const rng = seeded(8);
    for (let i = 0; i < 100; i++) {
      const tiers = tierSequence("balanced", 5, rng);
      expect(tiers.filter((t) => t === "city")).toHaveLength(2);
      expect(tiers.filter((t) => t === "town")).toHaveLength(2);
      expect(tiers.filter((t) => t === "rural")).toHaveLength(1);
    }
  });

  it("shuffles the tiers and draws leftover rounds by weight", () => {
    const rng = seeded(9);
    const firstRound = new Map<string, number>();
    for (let i = 0; i < 5000; i++) {
      const [tier] = tierSequence("balanced", 1, rng);
      firstRound.set(tier, (firstRound.get(tier) ?? 0) + 1);
    }
    expect(firstRound.get("city")! / 5000).toBeCloseTo(0.4, 1);
    expect(firstRound.get("town")! / 5000).toBeCloseTo(0.4, 1);
    expect(firstRound.get("rural")! / 5000).toBeCloseTo(0.2, 1);
  });

  it("gives every mix the right number of rounds in only its tiers", () => {
    const rng = seeded(10);
    for (const mix of Object.keys(LOCATION_MIXES) as LocationMix[]) {
      for (const rounds of [1, 3, 5, 10]) {
        const tiers = tierSequence(mix, rounds, rng);
        expect(tiers).toHaveLength(rounds);
        expect(tiers.every((t) => LOCATION_MIXES[mix].weights[t] > 0)).toBe(true);
      }
    }
  });

  it("plans World games with the mix's tiers", () => {
    const rng = seeded(11);
    for (let i = 0; i < 100; i++) {
      const plan = planLocations(null, 5, "balanced", rng);
      expect(plan.filter((l) => l.tier === "city")).toHaveLength(2);
      expect(plan.filter((l) => l.tier === "town")).toHaveLength(2);
      expect(plan.filter((l) => l.tier === "rural")).toHaveLength(1);
    }
    for (const mix of Object.keys(LOCATION_MIXES) as LocationMix[]) {
      for (let i = 0; i < 50; i++) {
        const plan = planLocations(null, 5, mix, rng);
        expect(plan.every((l) => LOCATION_MIXES[mix].weights[l.tier] > 0)).toBe(true);
      }
    }
  });

  it("falls back to the nearest tier when a filter runs out", () => {
    const rng = seeded(12);
    const cityCount = (code: string) => filterPool(`country:${code}`).filter((l) => l.tier === "city").length;
    // The playable country with the fewest city spots.
    const [code, country] = Object.entries(COUNTRIES)
      .filter(([, c]) => c.count >= 10)
      .sort((a, b) => cityCount(a[0]) - cityCount(b[0]))[0];
    const rounds = Math.min(10, country.count);
    expect(cityCount(code)).toBeLessThan(rounds);
    const plan = planLocations(`country:${code}`, rounds, "cities", rng);
    expect(plan).toHaveLength(rounds);
    expect(plan.filter((l) => l.tier === "city")).toHaveLength(cityCount(code));
  });
});
