"use client";

import { useEffect, useRef, useState } from "react";
import { loadMapsLibrary, MAP_ID } from "@/lib/google-maps";
import type { LatLng } from "@/lib/scoring";
import type { RegionBounds } from "@/lib/regions";

export interface MapGuess {
  position: LatLng;
  label: string;
  color: string;
}

export interface MapRound {
  answer: LatLng;
  guesses: MapGuess[];
}

interface Props {
  // "guess": click to place your pin. "results": show answers and guesses.
  mode: "guess" | "results";
  pin: LatLng | null;
  onPick: (position: LatLng) => void;
  // Rounds to draw in results mode (one for a round recap, all of them for
  // the final summary).
  results: MapRound[];
  // Where the guess map starts each round: the filtered region, or the
  // whole world when null.
  startBounds: RegionBounds | null;
}

const WORLD_VIEW = { center: { lat: 20, lng: 0 }, zoom: 1 };

function dot(color: string, label: string) {
  const el = document.createElement("div");
  el.textContent = label;
  el.style.cssText = `background:${color};color:white;width:24px;height:24px;border-radius:9999px;border:2px solid white;display:flex;align-items:center;justify-content:center;font:600 12px sans-serif;box-shadow:0 1px 4px rgba(0,0,0,.4);transform:translateY(50%)`;
  return el;
}

// One map instance for the whole game (each `new Map` is a billed map
// load); switching modes only changes what's drawn on it.
export function GameMap({ mode, pin, onPick, results, startBounds }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [map, setMap] = useState<google.maps.Map | null>(null);
  const onPickRef = useRef(onPick);
  const modeRef = useRef(mode);

  useEffect(() => {
    onPickRef.current = onPick;
    modeRef.current = mode;
  }, [onPick, mode]);

  useEffect(() => {
    let cancelled = false;
    loadMapsLibrary("maps").then(({ Map }) => {
      if (cancelled || !containerRef.current) return;
      const instance = new Map(containerRef.current, {
        ...WORLD_VIEW,
        mapId: MAP_ID,
        disableDefaultUI: true,
        zoomControl: true,
        // The pegman would open Street View on the guess map — instant answer.
        streetViewControl: false,
        clickableIcons: false,
        gestureHandling: "greedy",
        draggableCursor: "crosshair",
      });
      instance.addListener("click", (e: google.maps.MapMouseEvent) => {
        if (modeRef.current === "guess" && e.latLng) onPickRef.current(e.latLng.toJSON());
      });
      setMap(instance);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Your own pin while guessing.
  useEffect(() => {
    if (!map || mode !== "guess" || !pin) return;
    let marker: google.maps.marker.AdvancedMarkerElement | null = null;
    let cancelled = false;
    loadMapsLibrary("marker").then(({ AdvancedMarkerElement }) => {
      if (cancelled) return;
      marker = new AdvancedMarkerElement({ map, position: pin, content: dot("#111827", "") });
    });
    return () => {
      cancelled = true;
      if (marker) marker.map = null;
    };
  }, [map, mode, pin]);

  // Back to the starting view at the start of each guessing phase.
  useEffect(() => {
    if (!map || mode !== "guess") return;
    map.setOptions({ draggableCursor: "crosshair" });
    if (startBounds) {
      map.fitBounds(
        new google.maps.LatLngBounds(
          { lat: startBounds.south, lng: startBounds.west },
          { lat: startBounds.north, lng: startBounds.east }
        ),
        20
      );
    } else {
      map.setCenter(WORLD_VIEW.center);
      map.setZoom(WORLD_VIEW.zoom);
    }
  }, [map, mode, startBounds]);

  // Answers, guesses and the lines between them.
  useEffect(() => {
    if (!map || mode !== "results" || results.length === 0) return;
    let cancelled = false;
    const markers: google.maps.marker.AdvancedMarkerElement[] = [];
    const lines: google.maps.Polyline[] = [];
    map.setOptions({ draggableCursor: null });

    Promise.all([loadMapsLibrary("marker"), loadMapsLibrary("maps")]).then(
      ([{ AdvancedMarkerElement, PinElement }, { Polyline }]) => {
        if (cancelled) return;
        const bounds = new google.maps.LatLngBounds();
        results.forEach((round, index) => {
          const flag = new PinElement({
            background: "#16a34a",
            borderColor: "#14532d",
            glyphColor: "white",
            glyph: results.length > 1 ? String(index + 1) : "",
          });
          markers.push(new AdvancedMarkerElement({ map, position: round.answer, content: flag.element }));
          bounds.extend(round.answer);
          for (const guess of round.guesses) {
            markers.push(
              new AdvancedMarkerElement({ map, position: guess.position, content: dot(guess.color, guess.label) })
            );
            lines.push(
              new Polyline({
                map,
                path: [guess.position, round.answer],
                geodesic: true,
                strokeOpacity: 0,
                icons: [
                  {
                    icon: { path: "M 0,-1 0,1", strokeOpacity: 1, strokeColor: guess.color, scale: 2 },
                    offset: "0",
                    repeat: "10px",
                  },
                ],
              })
            );
            bounds.extend(guess.position);
          }
        });
        map.fitBounds(bounds, 60);
        if ((map.getZoom() ?? 0) > 14) map.setZoom(14);
      }
    );
    return () => {
      cancelled = true;
      markers.forEach((m) => (m.map = null));
      lines.forEach((l) => l.setMap(null));
    };
  }, [map, mode, results]);

  return <div ref={containerRef} className="h-full w-full" />;
}
