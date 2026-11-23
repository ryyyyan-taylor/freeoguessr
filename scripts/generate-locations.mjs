// Builds src/lib/locations.json: a pool of official Google Street View
// locations to draw rounds from.
//
// Samples points uniformly over the globe's surface and asks the Street View
// metadata endpoint for the nearest outdoor panorama within SEARCH_RADIUS_M.
// Metadata requests are free and don't count as panorama loads, so this costs
// nothing to run. Most samples land in the ocean or somewhere without
// coverage and are discarded; expect a few percent to hit.
//
// Uniform-by-area sampling roughly matches a "random world" map: big
// countries with good coverage show up most, tiny islands rarely. A
// hand-balanced pool is a possible later improvement.
//
// Usage: node --env-file=.env.local scripts/generate-locations.mjs [count]

import { writeFileSync } from "node:fs";

const TARGET = Number(process.argv[2] ?? 2000);
const SEARCH_RADIUS_M = 25_000;
const CONCURRENCY = 20;
const OUTPUT = new URL("../src/lib/locations.json", import.meta.url);

const key = process.env.GOOGLE_MAPS_SERVER_KEY;
if (!key) {
  console.error("GOOGLE_MAPS_SERVER_KEY is not set (try: node --env-file=.env.local ...)");
  process.exit(1);
}

// Uniform on a sphere: longitude uniform, latitude via arcsine of a uniform.
function randomPoint() {
  const lng = Math.random() * 360 - 180;
  const lat = (Math.asin(Math.random() * 2 - 1) * 180) / Math.PI;
  return { lat, lng };
}

async function sample() {
  const { lat, lng } = randomPoint();
  const params = new URLSearchParams({
    location: `${lat},${lng}`,
    radius: String(SEARCH_RADIUS_M),
    source: "outdoor",
    key,
  });
  const res = await fetch(`https://maps.googleapis.com/maps/api/streetview/metadata?${params}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (data.status === "REQUEST_DENIED") throw new Error(`Request denied: ${data.error_message}`);
  // Official coverage only; user photospheres credit the uploader instead.
  if (data.status !== "OK" || !data.copyright?.includes("Google")) return null;
  return { lat: data.location.lat, lng: data.location.lng, panoId: data.pano_id };
}

const found = new Map();
let attempts = 0;

async function worker() {
  while (found.size < TARGET) {
    attempts++;
    try {
      const location = await sample();
      if (location && !found.has(location.panoId)) {
        found.set(location.panoId, location);
        if (found.size % 50 === 0) console.log(`${found.size}/${TARGET} (${attempts} samples)`);
      }
    } catch (error) {
      console.error(error.message);
      if (error.message.startsWith("Request denied")) process.exit(1);
    }
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, worker));

const locations = [...found.values()].slice(0, TARGET).map((l) => ({
  lat: Number(l.lat.toFixed(6)),
  lng: Number(l.lng.toFixed(6)),
  panoId: l.panoId,
}));
writeFileSync(OUTPUT, JSON.stringify(locations, null, 0).replace(/},{/g, "},\n{") + "\n");
console.log(`Wrote ${locations.length} locations from ${attempts} samples to ${OUTPUT.pathname}`);
