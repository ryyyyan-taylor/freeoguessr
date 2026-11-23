import names from "./country-names.json";

// Client-safe: every country's display name, including ones with no
// locations (a guess can land anywhere).
const NAMES = names as Record<string, string>;

export function countryName(code: string | null | undefined): string {
  if (!code) return "Open water";
  return NAMES[code] ?? code;
}
