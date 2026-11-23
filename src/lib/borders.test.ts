import { describe, expect, it } from "vitest";
import { locateGuess } from "./borders";

describe("locateGuess", () => {
  it("finds the country a point is in", () => {
    expect(locateGuess(48.8566, 2.3522).country).toBe("FR"); // Paris
    expect(locateGuess(52.52, 13.405).country).toBe("DE"); // Berlin
    expect(locateGuess(39.74, -104.99).country).toBe("US"); // Denver
    expect(locateGuess(-33.8688, 151.2093).country).toBe("AU"); // Sydney
  });

  it("counts waterfront clicks the coarse coastline leaves offshore", () => {
    expect(locateGuess(40.7128, -74.006).country).toBe("US"); // Lower Manhattan
    expect(locateGuess(64.7, 177.5).country).toBe("RU"); // Anadyr, across the antimeridian
  });

  it("returns no country for open ocean", () => {
    const { country, distances } = locateGuess(30, -40); // mid-Atlantic
    expect(country).toBeNull();
    expect(Math.min(...Object.values(distances))).toBeGreaterThan(500_000);
  });

  it("is zero for the country you're in and measures to the nearest border otherwise", () => {
    const { distances } = locateGuess(48.8566, 2.3522); // Paris
    expect(distances.FR).toBe(0);
    // Paris to Belgium's border is ~200 km; to Germany's (Saarland) ~280–300 km.
    expect(distances.BE / 1000).toBeGreaterThan(170);
    expect(distances.BE / 1000).toBeLessThan(230);
    expect(distances.DE / 1000).toBeGreaterThan(260);
    expect(distances.DE / 1000).toBeLessThan(330);
    expect(Object.keys(distances).length).toBeGreaterThan(200);
  });

  it("is small just across a border", () => {
    // Strasbourg, France, sits on the Rhine across from Germany.
    expect(locateGuess(48.5734, 7.7521).distances.DE / 1000).toBeLessThan(5);
  });

  it("is fast enough to run on every guess", () => {
    locateGuess(0, 0);
    const start = performance.now();
    for (let i = 0; i < 10; i++) locateGuess(Math.random() * 140 - 70, Math.random() * 360 - 180);
    expect((performance.now() - start) / 10).toBeLessThan(100);
  });
});
