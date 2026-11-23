import { describe, expect, it } from "vitest";
import { LOCATION_POOL, locationKey } from "./locations";

describe("location pool", () => {
  it("is big enough for a full game", () => {
    expect(LOCATION_POOL.length).toBeGreaterThanOrEqual(10);
  });

  it("has valid coordinates and a panorama for every entry", () => {
    for (const l of LOCATION_POOL) {
      expect(Math.abs(l.lat)).toBeLessThanOrEqual(90);
      expect(Math.abs(l.lng)).toBeLessThanOrEqual(180);
      expect(l.panoId).toBeTruthy();
    }
  });

  it("has no duplicate locations", () => {
    expect(new Set(LOCATION_POOL.map(locationKey)).size).toBe(LOCATION_POOL.length);
  });
});
