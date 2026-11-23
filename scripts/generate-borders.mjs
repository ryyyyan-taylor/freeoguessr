// Builds the country data used by country-first scoring:
//   src/lib/borders.json        country code -> polygons (server only)
//   src/lib/country-names.json  country code -> name (client-safe)
//
// From the same Natural Earth boundaries as generate-locations.mjs, with
// coordinates rounded to 3 decimals (~100 m) to keep the file small.
//
// Usage: node scripts/generate-borders.mjs

import { writeFileSync } from "node:fs";
import { loadBoundaries, mergedCountries } from "./lib/natural-earth.mjs";

const round = (x) => Math.round(x * 1000) / 1000;

// Drops consecutive points that round to the same spot.
function compactRing(ring) {
  const out = [];
  for (const [lng, lat] of ring) {
    const point = [round(lng), round(lat)];
    const last = out[out.length - 1];
    if (!last || last[0] !== point[0] || last[1] !== point[1]) out.push(point);
  }
  return out;
}

const borders = {};
const names = {};
for (const country of mergedCountries(await loadBoundaries())) {
  borders[country.code] = country.polygons
    .map((polygon) => polygon.map(compactRing).filter((ring) => ring.length >= 4))
    .filter((polygon) => polygon.length > 0);
  names[country.code] = country.name;
}

writeFileSync(new URL("../src/lib/borders.json", import.meta.url), JSON.stringify(borders) + "\n");
writeFileSync(new URL("../src/lib/country-names.json", import.meta.url), JSON.stringify(names, null, 0) + "\n");
console.log(`Wrote ${Object.keys(borders).length} countries.`);
