"use client";

import { useEffect, useRef } from "react";
import { loadMapsLibrary } from "@/lib/google-maps";

// Google bills a Dynamic Street View load each time a StreetViewPanorama is
// constructed, so this creates exactly one per mount and switches rounds
// with setPano() instead. Keep it mounted for the whole game (hide it,
// don't unmount it) so a game costs one load per player.
export function StreetView({ panoId, resetKey }: { panoId: string | null; resetKey: number }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const panoramaRef = useRef<google.maps.StreetViewPanorama | null>(null);
  const panoIdRef = useRef(panoId);

  useEffect(() => {
    panoIdRef.current = panoId;
  }, [panoId]);

  useEffect(() => {
    let cancelled = false;
    loadMapsLibrary("streetView").then(({ StreetViewPanorama }) => {
      if (cancelled || !containerRef.current || panoramaRef.current) return;
      panoramaRef.current = new StreetViewPanorama(containerRef.current, {
        pano: panoIdRef.current ?? undefined,
        pov: { heading: 0, pitch: 0 },
        zoom: 0,
        // These would give the answer away.
        addressControl: false,
        showRoadLabels: false,
        // Not useful in a game.
        fullscreenControl: false,
        enableCloseButton: false,
        motionTracking: false,
        motionTrackingControl: false,
        imageDateControl: false,
        linksControl: true,
        clickToGo: true,
        panControl: true,
        zoomControl: true,
      });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // New round (panoId changes) or "return to start" (resetKey changes).
  useEffect(() => {
    const panorama = panoramaRef.current;
    if (!panorama || !panoId) return;
    panorama.setPano(panoId);
    panorama.setPov({ heading: 0, pitch: 0 });
    panorama.setZoom(0);
  }, [panoId, resetKey]);

  return <div ref={containerRef} className="absolute inset-0" />;
}
