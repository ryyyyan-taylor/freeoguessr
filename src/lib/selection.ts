import { filterPool, type PoolLocation } from "./locations";
import { parseFilter, type LocationFilter } from "./regions";
import { LOCATION_MIXES, TIERS, type LocationMix, type Tier } from "./rules";

// Plans a whole game's locations up front, for variety rather than raw
// randomness. A uniform draw from the pool would mirror its make-up (about
// a third of World rounds in the Americas, and mostly open-country roads);
// instead, like wiki-race's topic-first article picks, each round chooses a
// tier, then a continent, then a country, then a spot:
//
// - Tier: the room's location mix sets each tier's share of the game's
//   rounds (see tierSequence). If the filter has no spots left in a
//   round's tier, it falls back to the nearest one (FALLBACK). The steps
//   below then only consider spots in that tier.
// - Continent: weighted by √(number of countries), and each time one is
//   used its weight drops to CONTINENT_REUSE_FACTOR of what it was, so a
//   5-round World game nearly always visits 5 continents but can repeat.
// - Country: never one already used this game (until the filter runs out
//   of countries), weighted by √(its location count) so well-covered
//   countries come up more than tiny ones, but not proportionally more.
// - Spot: the best of SPREAD_CANDIDATES random picks, scored by distance
//   from the game's other locations, so repeats within a country (and
//   every round of a single-country game) are spread out.

const CONTINENT_REUSE_FACTOR = 0.2;
const SPREAD_CANDIDATES = 8;
const FALLBACK: Record<Tier, Tier[]> = {
  city: ["city", "town", "rural"],
  town: ["town", "city", "rural"],
  rural: ["rural", "town", "city"],
};

export type Rng = () => number;

const EARTH_RADIUS_M = 6_371_008.8;
const toRad = (deg: number) => (deg * Math.PI) / 180;

function haversine(a: PoolLocation, b: PoolLocation) {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

function weightedPick<T>(items: T[], weight: (item: T) => number, rng: Rng): T {
  const weights = items.map(weight);
  let r = rng() * weights.reduce((s, w) => s + w, 0);
  for (let i = 0; i < items.length; i++) if ((r -= weights[i]) <= 0) return items[i];
  return items[items.length - 1];
}

// Of a few random candidates, the one farthest from everything chosen so far.
function spreadPick(candidates: PoolLocation[], chosen: PoolLocation[], rng: Rng): PoolLocation {
  let best = candidates[Math.floor(rng() * candidates.length)];
  if (chosen.length === 0) return best;
  let bestScore = -1;
  for (let i = 0; i < Math.min(SPREAD_CANDIDATES, candidates.length); i++) {
    const candidate = candidates[Math.floor(rng() * candidates.length)];
    const score = Math.min(...chosen.map((c) => haversine(c, candidate)));
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

function groupBy<T>(items: T[], key: (item: T) => string) {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(item);
  }
  return groups;
}

// Each round's tier, in play order. Every tier gets the whole rounds its
// weight entitles it to (2, 2 and 1 of 5 for Balanced); the leftover rounds
// are drawn by the fractional parts, so a 1-round Balanced game is city or
// town 40% of the time each and rural 20%.
export function tierSequence(mix: LocationMix, rounds: number, rng: Rng = Math.random): Tier[] {
  const weights = LOCATION_MIXES[mix].weights;
  const total = TIERS.reduce((s, t) => s + weights[t], 0);
  const exact = TIERS.map((t) => (rounds * weights[t]) / total);
  const sequence = TIERS.flatMap((t, i) => Array<Tier>(Math.floor(exact[i])).fill(t));
  const remainders = new Map(TIERS.map((t, i) => [t, exact[i] - Math.floor(exact[i])]));
  while (sequence.length < rounds) {
    const tier = weightedPick(
      TIERS.filter((t) => remainders.get(t)! > 1e-9),
      (t) => remainders.get(t)!,
      rng
    );
    remainders.set(tier, 0);
    sequence.push(tier);
  }
  // Fisher-Yates, so the tiers come in random order.
  for (let i = sequence.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [sequence[i], sequence[j]] = [sequence[j], sequence[i]];
  }
  return sequence;
}

// A filter's spots grouped by tier, then country. The pool is ~100k spots,
// so this is built once per filter and kept for the life of the server.
interface PoolIndex {
  size: number;
  countries: Map<string, number>; // country -> its spot count, any tier
  continentOf: Map<string, string>;
  byTier: Map<Tier, Map<string, PoolLocation[]>>;
}
const indexes = new Map<string, PoolIndex>();

function indexFor(filter: LocationFilter): PoolIndex {
  const key = filter ?? "";
  let index = indexes.get(key);
  if (!index) {
    const pool = filterPool(filter);
    index = {
      size: pool.length,
      countries: new Map([...groupBy(pool, (l) => l.country)].map(([c, ls]) => [c, ls.length])),
      continentOf: new Map(pool.map((l) => [l.country, l.continent])),
      byTier: new Map(TIERS.map((t) => [t, groupBy(pool.filter((l) => l.tier === t), (l) => l.country)])),
    };
    indexes.set(key, index);
  }
  return index;
}

// `rounds` locations for a game with this filter and mix, in play order,
// all distinct. Throws if the filter doesn't have enough.
export function planLocations(
  filter: LocationFilter,
  rounds: number,
  mix: LocationMix = "balanced",
  rng: Rng = Math.random
): PoolLocation[] {
  const index = indexFor(filter);
  if (index.size < rounds) throw new Error(`Only ${index.size} locations available`);

  const parsed = parseFilter(filter);
  const chosen: PoolLocation[] = [];
  const usedSpots = new Set<PoolLocation>();
  const usedCountries = new Set<string>();
  const continentUses = new Map<string, number>();
  // At most MAX_ROUNDS spots are ever used, so any country with more spots
  // than this game has used in total still has some left.
  const unused = (tier: Tier, country: string) =>
    index.byTier.get(tier)!.get(country)!.filter((l) => !usedSpots.has(l));
  const hasUnused = (tier: Tier, country: string) =>
    index.byTier.get(tier)!.get(country)!.length > usedSpots.size || unused(tier, country).length > 0;
  const countriesWith = (tier: Tier) => [...index.byTier.get(tier)!.keys()].filter((c) => hasUnused(tier, c));

  for (const wanted of tierSequence(mix, rounds, rng)) {
    const tier = FALLBACK[wanted].find((t) => countriesWith(t).length > 0)!;
    let countries = countriesWith(tier);
    // Every country used once already: allow repeats (spread out).
    const fresh = countries.filter((c) => !usedCountries.has(c));
    if (fresh.length > 0) countries = fresh;

    // Continent first, on the World map.
    if (!parsed) {
      const byContinent = groupBy(countries, (c) => index.continentOf.get(c)!);
      const continent = weightedPick(
        [...byContinent.keys()],
        (k) => Math.sqrt(byContinent.get(k)!.length) * CONTINENT_REUSE_FACTOR ** (continentUses.get(k) ?? 0),
        rng
      );
      continentUses.set(continent, (continentUses.get(continent) ?? 0) + 1);
      countries = byContinent.get(continent)!;
    }

    const country = weightedPick(countries, (c) => Math.sqrt(index.countries.get(c)!), rng);
    usedCountries.add(country);

    const spot = spreadPick(
      unused(tier, country),
      chosen,
      rng
    );
    usedSpots.add(spot);
    chosen.push(spot);
  }
  return chosen;
}
