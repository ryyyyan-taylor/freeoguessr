import { importLibrary, setOptions } from "@googlemaps/js-api-loader";

let configured = false;

// Client-side loader for the Maps JavaScript API. The browser key should be
// restricted to this site's domains in Google Cloud Console.
export function loadMapsLibrary<T extends keyof google.maps.ImportLibraryMap>(name: T) {
  if (!configured) {
    setOptions({ key: process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ?? "", v: "weekly" });
    configured = true;
  }
  return importLibrary(name);
}

// Advanced markers need a map ID. Google's DEMO_MAP_ID works for
// development; create a real one in Cloud Console for production.
export const MAP_ID = process.env.NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID || "DEMO_MAP_ID";

export const PLAYER_COLORS = ["#e11d48", "#2563eb", "#16a34a", "#d97706", "#9333ea", "#0891b2", "#db2777", "#65a30d"];
