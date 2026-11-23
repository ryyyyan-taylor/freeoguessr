import { filterPool, type PoolLocation } from "./locations";
import { parseFilter, type LocationFilter } from "./regions";

// Plans a whole game's locations up front, for variety rather than raw
// randomness. A uniform draw from the pool would mirror its make-up (about
// a third of World rounds in the Americas); instead, like wiki-race's
// topic-first article picks, each round chooses a continent, then a
// country, then a spot:
//
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

// `rounds` locations for a game with this filter, in play order, all
// distinct. Throws if the filter doesn't have enough.
export function planLocations(filter: LocationFilter, rounds: number, rng: Rng = Math.random): PoolLocation[] {
  const pool = filterPool(filter);
  if (pool.length < rounds) throw new Error(`Only ${pool.length} locations available`);

  const parsed = parseFilter(filter);
  const byCountry = groupBy(pool, (l) => l.country);
  const continentOfCountry = new Map(pool.map((l) => [l.country, l.continent]));
  const chosen: PoolLocation[] = [];
  const usedSpots = new Set<PoolLocation>();
  const usedCountries = new Set<string>();
  const continentUses = new Map<string, number>();

  while (chosen.length < rounds) {
    let countries = [...byCountry.keys()].filter((c) => byCountry.get(c)!.some((l) => !usedSpots.has(l)));
    // Every country used once already: allow repeats (spread out).
    const fresh = countries.filter((c) => !usedCountries.has(c));
    if (fresh.length > 0) countries = fresh;

    // Continent first, on the World map.
    if (!parsed) {
      const byContinent = groupBy(countries, (c) => continentOfCountry.get(c)!);
      const continent = weightedPick(
        [...byContinent.keys()],
        (k) => Math.sqrt(byContinent.get(k)!.length) * CONTINENT_REUSE_FACTOR ** (continentUses.get(k) ?? 0),
        rng
      );
      continentUses.set(continent, (continentUses.get(continent) ?? 0) + 1);
      countries = byContinent.get(continent)!;
    }

    const country = weightedPick(countries, (c) => Math.sqrt(byCountry.get(c)!.length), rng);
    usedCountries.add(country);

    const spot = spreadPick(
      byCountry.get(country)!.filter((l) => !usedSpots.has(l)),
      chosen,
      rng
    );
    usedSpots.add(spot);
    chosen.push(spot);
  }
  return chosen;
}
