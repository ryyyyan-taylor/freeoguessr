import pool from "./locations.json";

export interface PoolLocation {
  lat: number;
  lng: number;
  // Known Google panorama at this spot. Null for hand-entered seed points,
  // which get snapped to the nearest official panorama at round start.
  panoId: string | null;
}

export const LOCATION_POOL = pool as PoolLocation[];

const METADATA_URL = "https://maps.googleapis.com/maps/api/streetview/metadata";

export interface StreetViewMetadata {
  status: string;
  pano_id?: string;
  location?: { lat: number; lng: number };
  copyright?: string;
}

// Street View Static API metadata lookup. Free and unmetered (it's not a
// panorama load), so it's safe to call while picking locations. Only
// accepts official Google coverage — user-uploaded photospheres carry the
// uploader's name in `copyright` instead of "Google".
export async function lookupPanorama(lat: number, lng: number, radiusM: number): Promise<PoolLocation | null> {
  const key = process.env.GOOGLE_MAPS_SERVER_KEY;
  if (!key) throw new Error("GOOGLE_MAPS_SERVER_KEY is not set");
  const params = new URLSearchParams({
    location: `${lat},${lng}`,
    radius: String(radiusM),
    source: "outdoor",
    key,
  });
  const res = await fetch(`${METADATA_URL}?${params}`);
  if (!res.ok) return null;
  const data = (await res.json()) as StreetViewMetadata;
  if (data.status !== "OK" || !data.pano_id || !data.location || !data.copyright?.includes("Google")) return null;
  return { lat: data.location.lat, lng: data.location.lng, panoId: data.pano_id };
}

// Picks a pool location not already used in this game. Seed points without
// a panoId are snapped to a real panorama; ones with no coverage nearby
// are skipped.
export async function pickLocation(usedKeys: Set<string>): Promise<PoolLocation> {
  const candidates = LOCATION_POOL.filter((l) => !usedKeys.has(locationKey(l)));
  if (candidates.length === 0) throw new Error("Location pool exhausted");
  for (let attempt = 0; attempt < 10; attempt++) {
    const pick = candidates[Math.floor(Math.random() * candidates.length)];
    if (pick.panoId) return pick;
    const snapped = await lookupPanorama(pick.lat, pick.lng, 1000);
    if (snapped) return snapped;
  }
  throw new Error("Could not find a location with Street View coverage");
}

export function locationKey(l: { lat: number; lng: number }) {
  return `${l.lat.toFixed(4)},${l.lng.toFixed(4)}`;
}
