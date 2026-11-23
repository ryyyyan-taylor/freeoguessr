// Natural Earth 1:50m country boundaries (public domain), downloaded once
// into scripts/.cache and shared by the generator scripts.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const BOUNDARIES_URL =
  "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_admin_0_countries.geojson";
const CACHE_DIR = new URL("../.cache/", import.meta.url);
const BOUNDARIES_FILE = new URL("ne_50m_admin_0_countries.geojson", CACHE_DIR);

export async function loadBoundaries() {
  if (!existsSync(BOUNDARIES_FILE)) {
    mkdirSync(CACHE_DIR, { recursive: true });
    console.log("Downloading Natural Earth country boundaries…");
    const res = await fetch(BOUNDARIES_URL);
    if (!res.ok) throw new Error(`Boundary download failed: HTTP ${res.status}`);
    writeFileSync(BOUNDARIES_FILE, await res.text());
  }
  return JSON.parse(readFileSync(BOUNDARIES_FILE, "utf8"));
}

// ISO_A2_EH fixes Natural Earth's -99 for France/Norway; the few disputed
// areas with no ISO code at all fall back to ADM0_A3. Both generators must
// use this so the pool's country codes match the borders file.
export function countryCode(properties) {
  return properties.ISO_A2_EH && properties.ISO_A2_EH !== "-99" ? properties.ISO_A2_EH : properties.ADM0_A3;
}

// Every feature's geometry as a list of polygons, each [outer, ...holes].
export function polygonsOf(feature) {
  return feature.geometry.type === "Polygon" ? [feature.geometry.coordinates] : feature.geometry.coordinates;
}

const toRad = (d) => (d * Math.PI) / 180;

// Approximate area (km², equirectangular with cos-latitude scaling) — only
// used for relative weighting.
function ringArea(ring) {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [x1, y1] = ring[j];
    const [x2, y2] = ring[i];
    const k = Math.cos(toRad((y1 + y2) / 2));
    sum += x1 * k * y2 - x2 * k * y1;
  }
  return Math.abs(sum / 2) * 111.32 * 111.32;
}

export function polygonArea(polygon) {
  return Math.max(0, ringArea(polygon[0]) - polygon.slice(1).reduce((s, h) => s + ringArea(h), 0));
}

// One entry per country code. Natural Earth sometimes splits a code across
// features (Australia's AU also covers Ashmore and Cartier Is. and Indian
// Ocean Ter.); those are merged, taking the name and continent of the
// largest one.
export function mergedCountries(geojson) {
  const byCode = new Map();
  for (const feature of geojson.features) {
    const p = feature.properties;
    const code = countryCode(p);
    const polygons = polygonsOf(feature);
    const area = polygons.reduce((s, polygon) => s + polygonArea(polygon), 0);
    const entry = byCode.get(code) ?? { code, polygons: [], area: 0, largest: -1 };
    entry.polygons.push(...polygons);
    entry.area += area;
    if (area > entry.largest) {
      entry.largest = area;
      entry.name = p.NAME;
      entry.continent = p.CONTINENT;
    }
    byCode.set(code, entry);
  }
  return [...byCode.values()].map(({ code, name, continent, polygons, area }) => ({ code, name, continent, polygons, area }));
}
