// Builds the location pool (src/lib/locations.json) and the region list
// the lobby filters by (src/lib/regions.json).
//
// For each country in Natural Earth's public-domain boundaries, samples
// random points inside its borders and asks the Street View metadata
// endpoint for the nearest official outdoor panorama. Metadata requests are
// free and don't count as panorama loads, so this costs nothing to run.
//
// Each country's share of the pool is SCALE × √(area in km²), clamped to
// [MIN, MAX]. Square-root weighting keeps mid-sized countries playable on
// their own (France ~1,270, Japan ~1,040) without giants taking over, and makes
// the combined World pool "balanced" the way GeoGuessr's official World
// map is: small countries show up more than their area alone suggests.
//
// Every location is tagged with a tier (city, town or rural) from the GHSL
// Degree of Urbanisation grid (scripts/lib/urbanisation.mjs), and each
// country's share is split into per-tier quotas (TIER_SHARE). Sampling by
// area alone lands ~85% of spots on open-country roads, so city and town
// spots are sampled from that tier's grid cells instead. The game then
// picks a tier per round (src/lib/selection.ts).
//
// Runs are incremental: existing locations are kept (and tagged if they
// aren't yet), and each country is topped up to its quotas. Spots past a
// quota are kept too; the game picks a tier first, so they don't skew it.
//
// Usage:
//   node --env-file=.env.local scripts/generate-locations.mjs
//   node --env-file=.env.local scripts/generate-locations.mjs --only US,FR
//     (top up just those countries)
//   node --env-file=.env.local scripts/generate-locations.mjs --fresh [--only US,FR]
//     (discard those countries' existing locations first)
//   node scripts/generate-locations.mjs --regions-only
//     (no lookups: de-duplicate and tag the existing pool, rebuild regions.json)

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { loadBoundaries, mergedCountries, polygonArea } from "./lib/natural-earth.mjs";
import { loadUrbanisation, tierOf, TIERS } from "./lib/urbanisation.mjs";

// Big on purpose: more spots means more variety, especially in cities.
// About half the targets are reachable (many countries have little or no
// coverage), giving a pool of 100k+ (~13 MB, server-side only).
const SCALE = 2;
const MIN_PER_COUNTRY = 250;
const MAX_PER_COUNTRY = 5000;
// Share of each country's quota per tier.
const TIER_SHARE = { city: 0.3, town: 0.35, rural: 0.35 };
// Rural points are often far from any road; in a city or town a wide
// search would just find the nearest highway.
const SEARCH_RADIUS_M = { city: 1_000, town: 1_000, rural: 10_000 };
const CONCURRENCY = 50;
// Give up on a country's tier after this many samples per target location,
// or once this many samples in a row have found nothing new (no coverage,
// or every reachable spot already found).
const MAX_ATTEMPTS_PER_TARGET = 40;
const STALL_ATTEMPTS = 300;
// Long runs save the pool this often, so they can be stopped and resumed.
const SAVE_EVERY_MS = 60_000;

const POOL_FILE = new URL("../src/lib/locations.json", import.meta.url);
const REGIONS_FILE = new URL("../src/lib/regions.json", import.meta.url);

const regionsOnly = process.argv.includes("--regions-only");
const fresh = process.argv.includes("--fresh");
const key = process.env.GOOGLE_MAPS_SERVER_KEY;
if (!key && !regionsOnly) {
  console.error("GOOGLE_MAPS_SERVER_KEY is not set (try: node --env-file=.env.local ...)");
  process.exit(1);
}

const onlyArg = process.argv.indexOf("--only");
const only = onlyArg > -1 ? new Set(process.argv[onlyArg + 1].toUpperCase().split(",")) : null;

// ---------- geometry ----------

const toRad = (d) => (d * Math.PI) / 180;

function haversineM(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6_371_008.8 * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Ray casting on one ring of [lng, lat] pairs.
function inRing(lng, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// A polygon is [outer, ...holes].
const inPolygon = (lng, lat, polygon) => inRing(lng, lat, polygon[0]) && !polygon.slice(1).some((h) => inRing(lng, lat, h));

function bbox(ring) {
  let w = 180, e = -180, s = 90, n = -90;
  for (const [x, y] of ring) {
    w = Math.min(w, x); e = Math.max(e, x); s = Math.min(s, y); n = Math.max(n, y);
  }
  return { w, e, s, n };
}

// Uniform-by-area point inside the polygon's bounding box, retried until it
// falls inside the polygon.
function samplePolygon(part) {
  const { w, e, s, n } = part.bbox;
  const sinS = Math.sin(toRad(s));
  const sinN = Math.sin(toRad(n));
  for (let i = 0; i < 100; i++) {
    const lng = w + Math.random() * (e - w);
    const lat = (Math.asin(sinS + Math.random() * (sinN - sinS)) * 180) / Math.PI;
    if (inPolygon(lng, lat, part.polygon)) return { lat, lng };
  }
  return null;
}

// ---------- countries ----------

function countriesFrom(geojson) {
  return mergedCountries(geojson)
    .filter((c) => c.continent !== "Antarctica" && !c.continent.startsWith("Seven seas"))
    .map((c) => ({ ...c, parts: c.polygons.map((polygon) => ({ polygon, area: polygonArea(polygon), bbox: bbox(polygon[0]) })) }));
}

const inCountry = (country, { lat, lng }) => country.parts.some((part) => inPolygon(lng, lat, part.polygon));

// Natural Earth files overseas departments under their sovereign's
// continent; put them where they actually are.
function continentOf(country, { lat, lng }) {
  if (country.code === "FR") {
    if (lng < -30) return lat < 8 ? "South America" : "North America";
    if (lng > 40) return "Africa";
  }
  if (country.code === "NL" && lng < -30) return "North America";
  // Natural Earth puts all of Russia in Europe; east of the Urals is Asia.
  if (country.code === "RU" && lng > 60) return "Asia";
  return country.continent;
}

// ---------- Street View ----------

async function lookup(point, radius) {
  const params = new URLSearchParams({
    location: `${point.lat},${point.lng}`,
    radius: String(radius),
    source: "outdoor",
    key,
  });
  let data;
  // Rate-limited: back off and retry, rather than mistaking it for "no
  // coverage here" and giving up on the country.
  for (let delay = 1000; ; delay *= 2) {
    const res = await fetch(`https://maps.googleapis.com/maps/api/streetview/metadata?${params}`);
    data = res.ok ? await res.json() : { status: res.status === 429 ? "OVER_QUERY_LIMIT" : `HTTP ${res.status}` };
    if (data.status !== "OVER_QUERY_LIMIT" || delay > 60_000) break;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  if (data.status.startsWith("HTTP") || data.status === "OVER_QUERY_LIMIT" || data.status === "UNKNOWN_ERROR") {
    throw new Error(data.status);
  }
  if (data.status === "REQUEST_DENIED") {
    console.error(`Request denied: ${data.error_message}`);
    process.exit(1);
  }
  // Official coverage only; user photospheres credit the uploader instead.
  if (data.status !== "OK" || !data.copyright?.includes("Google")) return null;
  // Rounded here, as stored, so duplicate checks see what's saved.
  return { lat: Number(data.location.lat.toFixed(6)), lng: Number(data.location.lng.toFixed(6)), panoId: data.pano_id };
}

// Two panoramas this close (~10 m) are the same spot as far as the game is
// concerned; it also keys "already used this game" on this.
const spotKey = (l) => `${l.lat.toFixed(4)},${l.lng.toFixed(4)}`;

// Tops up `need` ({ city, town, rural } counts) for one country. Each
// panorama is tagged by the cell it actually stands in, which isn't always
// the tier it was sampled for; it's kept if that tier still needs spots.
async function generateCountry(country, need, seen, urbanisation, cells) {
  const found = [];
  const attempts = { city: 0, town: 0, rural: 0 };
  const sinceNew = { city: 0, town: 0, rural: 0 };
  const tierCells = {};
  for (const tier of ["city", "town"]) {
    tierCells[tier] = country.parts.flatMap((part) =>
      cells.inBox(part.bbox, tier).filter((c) => inPolygon(c.lng, c.lat, part.polygon))
    );
  }
  const pickPart = () => {
    let r = Math.random() * country.area;
    for (const part of country.parts) if ((r -= part.area) <= 0) return part;
    return country.parts[country.parts.length - 1];
  };
  const exhausted = (tier) =>
    (tier !== "rural" && tierCells[tier].length === 0) ||
    attempts[tier] >= Math.max(1, need[tier]) * MAX_ATTEMPTS_PER_TARGET ||
    sinceNew[tier] >= STALL_ATTEMPTS;
  const open = () => TIERS.filter((t) => need[t] > 0 && !exhausted(t));

  function samplePoint(tier) {
    if (tier === "rural") return samplePolygon(pickPart());
    const list = tierCells[tier];
    const c = list[Math.floor(Math.random() * list.length)];
    return urbanisation.randomPointIn(c.col, c.row);
  }

  async function worker() {
    for (let tiers = open(); tiers.length > 0; tiers = open()) {
      const tier = tiers[Math.floor(Math.random() * tiers.length)];
      attempts[tier]++;
      sinceNew[tier]++;
      const point = samplePoint(tier);
      if (!point) continue;
      try {
        const pano = await lookup(point, SEARCH_RADIUS_M[tier]);
        // The nearest panorama can be across a border.
        if (!pano || !inCountry(country, pano)) continue;
        const actual = tierOf(await urbanisation.classAt(pano.lat, pano.lng));
        if (need[actual] > 0 && !seen.has(pano.panoId) && !seen.has(spotKey(pano))) {
          seen.add(pano.panoId);
          seen.add(spotKey(pano));
          need[actual]--;
          sinceNew[tier] = 0;
          found.push({ ...pano, tier: actual });
        }
      } catch (error) {
        console.error(`${country.code}: ${error.message}`);
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return { found, attempts: attempts.city + attempts.town + attempts.rural };
}

// ---------- regions ----------

// Map size for scoring: the distance between the two furthest-apart
// locations, standing in for GeoGuessr's per-map size.
function mapSize(points) {
  if (points.length > 3000) return approximateMapSize(points);
  let max = 0;
  for (let i = 0; i < points.length; i++)
    for (let j = i + 1; j < points.length; j++) max = Math.max(max, haversineM(points[i], points[j]));
  return Math.round(max);
}

// Exact is O(n²), too slow for continents. Repeatedly jumping to the point
// farthest from the current one climbs to the diameter (or very near it)
// in a few sweeps; a few starting points guard against a local maximum.
function approximateMapSize(points) {
  let max = 0;
  for (let start = 0; start < 8; start++) {
    let from = points[Math.floor((start / 8) * points.length)];
    for (let sweep = 0; sweep < 4; sweep++) {
      let far = from;
      let farD = 0;
      for (const p of points) {
        const d = haversineM(from, p);
        if (d > farD) [far, farD] = [p, d];
      }
      max = Math.max(max, farD);
      from = far;
    }
  }
  return Math.round(max);
}

// Smallest lat/lng box containing the points, allowing it to cross the
// antimeridian (east < west), for the guess map's starting view.
function bounds(points) {
  const lats = points.map((p) => p.lat);
  const lngs = [...new Set(points.map((p) => p.lng))].sort((a, b) => a - b);
  let gap = lngs[0] + 360 - lngs[lngs.length - 1];
  let west = lngs[0];
  let east = lngs[lngs.length - 1];
  for (let i = 1; i < lngs.length; i++) {
    if (lngs[i] - lngs[i - 1] > gap) {
      gap = lngs[i] - lngs[i - 1];
      west = lngs[i];
      east = lngs[i - 1];
    }
  }
  const r = (x) => Number(x.toFixed(3));
  return { north: r(Math.max(...lats)), south: r(Math.min(...lats)), east: r(east), west: r(west) };
}

function buildRegions(pool, countries) {
  const names = new Map(countries.map((c) => [c.code, c.name]));
  const byCountry = new Map();
  const byContinent = new Map();
  for (const l of pool) {
    if (!byCountry.has(l.country)) byCountry.set(l.country, []);
    byCountry.get(l.country).push(l);
    if (!byContinent.has(l.continent)) byContinent.set(l.continent, []);
    byContinent.get(l.continent).push(l);
  }
  const region = (points) => ({ count: points.length, mapSizeM: mapSize(points), bounds: bounds(points) });
  return {
    continents: Object.fromEntries(
      [...byContinent].sort(([a], [b]) => a.localeCompare(b)).map(([name, points]) => [name, region(points)])
    ),
    countries: Object.fromEntries(
      [...byCountry]
        .sort(([a], [b]) => names.get(a).localeCompare(names.get(b)))
        .map(([code, points]) => {
          const continent = countries.find((c) => c.code === code).continent;
          return [code, { name: names.get(code), continent, ...region(points) }];
        })
    ),
  };
}

// ---------- main ----------

const countries = countriesFrom(await loadBoundaries());
const urbanisation = await loadUrbanisation();
const readPool = () => (existsSync(POOL_FILE) ? JSON.parse(readFileSync(POOL_FILE, "utf8")) : []);

// Tags any location that has no tier yet.
async function tagged(locations) {
  for (const l of locations) l.tier ??= tierOf(await urbanisation.classAt(l.lat, l.lng));
  return locations;
}

function writePool(locations) {
  writeFileSync(POOL_FILE, "[\n" + locations.map((l) => JSON.stringify(l)).join(",\n") + "\n]\n");
}

let pool;

if (regionsOnly) {
  const spots = new Set();
  pool = await tagged(
    readPool().filter((l) => {
      if (spots.has(spotKey(l))) return false;
      spots.add(spotKey(l));
      return true;
    })
  );
} else {
  const selected = (code) => !only || only.has(code);
  pool = await tagged(readPool().filter((l) => l.country && !(fresh && selected(l.country))));
  const seen = new Set(pool.flatMap((l) => [l.panoId, spotKey(l)]));
  const cells = await urbanisation.builtUpCells();

  let totalAttempts = 0;
  let lastSave = Date.now();
  for (const country of countries) {
    if (!selected(country.code)) continue;
    if (Date.now() - lastSave > SAVE_EVERY_MS) {
      writePool(pool);
      lastSave = Date.now();
    }
    const target = Math.min(MAX_PER_COUNTRY, Math.max(MIN_PER_COUNTRY, Math.round(SCALE * Math.sqrt(country.area))));
    const have = { city: 0, town: 0, rural: 0 };
    for (const l of pool) if (l.country === country.code) have[l.tier]++;
    const need = Object.fromEntries(TIERS.map((t) => [t, Math.max(0, Math.round(target * TIER_SHARE[t]) - have[t])]));
    const wanted = { ...need };
    const { found, attempts } = await generateCountry(country, need, seen, urbanisation, cells);
    totalAttempts += attempts;
    for (const p of found) {
      pool.push({
        lat: p.lat,
        lng: p.lng,
        panoId: p.panoId,
        country: country.code,
        continent: continentOf(country, p),
        tier: p.tier,
      });
      have[p.tier]++;
    }
    const summary = TIERS.map((t) => `${t} ${have[t]}${wanted[t] ? ` (+${wanted[t] - need[t]}/${wanted[t]})` : ""}`).join(", ");
    console.log(`${country.code.padEnd(4)} ${country.name.padEnd(28)} ${summary} [${attempts} samples]`);
  }
  console.log(`${totalAttempts} samples.`);
}

writePool(pool);
writeFileSync(REGIONS_FILE, JSON.stringify(buildRegions(pool, countries), null, 2) + "\n");
console.log(`Wrote ${pool.length} locations and the region list.`);
