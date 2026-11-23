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
// their own (France ~160, Japan ~130) without giants taking over, and makes
// the combined World pool "balanced" the way GeoGuessr's official World
// map is: small countries show up more than their area alone suggests.
//
// Usage:
//   node --env-file=.env.local scripts/generate-locations.mjs
//   node --env-file=.env.local scripts/generate-locations.mjs --only US,FR
//     (regenerate just those countries, keeping everyone else's locations)
//   node scripts/generate-locations.mjs --regions-only
//     (no lookups: de-duplicate the existing pool and rebuild regions.json)

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { loadBoundaries, mergedCountries, polygonArea } from "./lib/natural-earth.mjs";

const SCALE = 0.25;
const MIN_PER_COUNTRY = 40;
const MAX_PER_COUNTRY = 600;
const SEARCH_RADIUS_M = 10_000;
const CONCURRENCY = 20;
// Give up on a country after this many samples per target location, or
// early if it plainly has no coverage.
const MAX_ATTEMPTS_PER_TARGET = 40;
const NO_COVERAGE_ATTEMPTS = 300;

const POOL_FILE = new URL("../src/lib/locations.json", import.meta.url);
const REGIONS_FILE = new URL("../src/lib/regions.json", import.meta.url);

const regionsOnly = process.argv.includes("--regions-only");
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

async function lookup(point) {
  const params = new URLSearchParams({
    location: `${point.lat},${point.lng}`,
    radius: String(SEARCH_RADIUS_M),
    source: "outdoor",
    key,
  });
  const res = await fetch(`https://maps.googleapis.com/maps/api/streetview/metadata?${params}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (data.status === "REQUEST_DENIED") {
    console.error(`Request denied: ${data.error_message}`);
    process.exit(1);
  }
  // Official coverage only; user photospheres credit the uploader instead.
  if (data.status !== "OK" || !data.copyright?.includes("Google")) return null;
  return { lat: data.location.lat, lng: data.location.lng, panoId: data.pano_id };
}

// Two panoramas this close (~10 m) are the same spot as far as the game is
// concerned; it also keys "already used this game" on this.
const spotKey = (l) => `${l.lat.toFixed(4)},${l.lng.toFixed(4)}`;

async function generateCountry(country, target, seen) {
  const found = [];
  let attempts = 0;
  const pickPart = () => {
    let r = Math.random() * country.area;
    for (const part of country.parts) if ((r -= part.area) <= 0) return part;
    return country.parts[country.parts.length - 1];
  };
  const done = () =>
    found.length >= target ||
    attempts >= target * MAX_ATTEMPTS_PER_TARGET ||
    (attempts >= NO_COVERAGE_ATTEMPTS && found.length === 0);

  async function worker() {
    while (!done()) {
      attempts++;
      const point = samplePolygon(pickPart());
      if (!point) continue;
      try {
        const pano = await lookup(point);
        // The nearest panorama can be across a border.
        if (pano && !seen.has(pano.panoId) && !seen.has(spotKey(pano)) && inCountry(country, pano) && found.length < target) {
          seen.add(pano.panoId);
          seen.add(spotKey(pano));
          found.push(pano);
        }
      } catch (error) {
        console.error(`${country.code}: ${error.message}`);
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return { found, attempts };
}

// ---------- regions ----------

// Map size for scoring: the distance between the two furthest-apart
// locations, standing in for GeoGuessr's per-map size.
function mapSize(points) {
  let max = 0;
  for (let i = 0; i < points.length; i++)
    for (let j = i + 1; j < points.length; j++) max = Math.max(max, haversineM(points[i], points[j]));
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
let pool;

if (regionsOnly) {
  const spots = new Set();
  pool = JSON.parse(readFileSync(POOL_FILE, "utf8")).filter((l) => {
    if (spots.has(spotKey(l))) return false;
    spots.add(spotKey(l));
    return true;
  });
} else {
  const existing = only && existsSync(POOL_FILE) ? JSON.parse(readFileSync(POOL_FILE, "utf8")) : [];
  pool = existing.filter((l) => l.country && !only.has(l.country));
  const seen = new Set(pool.flatMap((l) => [l.panoId, spotKey(l)]));

  let totalAttempts = 0;
  for (const country of countries) {
    if (only && !only.has(country.code)) continue;
    const target = Math.min(MAX_PER_COUNTRY, Math.max(MIN_PER_COUNTRY, Math.round(SCALE * Math.sqrt(country.area))));
    const { found, attempts } = await generateCountry(country, target, seen);
    totalAttempts += attempts;
    for (const p of found) {
      pool.push({
        lat: Number(p.lat.toFixed(6)),
        lng: Number(p.lng.toFixed(6)),
        panoId: p.panoId,
        country: country.code,
        continent: continentOf(country, p),
      });
    }
    console.log(`${country.code.padEnd(4)} ${country.name.padEnd(28)} ${String(found.length).padStart(4)}/${target} (${attempts} samples)`);
  }
  console.log(`${totalAttempts} samples.`);
}

writeFileSync(POOL_FILE, "[\n" + pool.map((l) => JSON.stringify(l)).join(",\n") + "\n]\n");
writeFileSync(REGIONS_FILE, JSON.stringify(buildRegions(pool, countries), null, 2) + "\n");
console.log(`Wrote ${pool.length} locations and the region list.`);
