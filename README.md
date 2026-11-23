# Freeoguessr

A self-hosted GeoGuessr-style game for playing with friends or solo. Host a
room, share the 5-character code, and guess where in the world each Street
View panorama is. "Play Solo" makes a private room just for you.

Rules (v1): 5 rounds by default, 2 minutes each. As soon as one player guesses,
everyone else has 10 seconds left. Scoring follows GeoGuessr's curve: up to
5,000 points per round, falling off exponentially with distance.

## Setup

1. Create a Supabase project and run every file in `supabase/migrations/`
   against it, in order (SQL editor or `supabase db push`).
2. Create a Google Cloud project with billing enabled, and enable the
   **Maps JavaScript API** and the **Street View Static API**.
   - Make two API keys: a browser key (Maps JavaScript API only, restricted
     to your domains) and a server key (Street View Static API only).
   - Under *APIs & Services → Quotas*, put a hard daily cap on
     "Dynamic Street View" and "Dynamic Maps" loads so a bug can never run
     up a bill. Google gives 5,000 Street View and 10,000 map loads free per
     month.
3. Copy `.env.local.example` to `.env.local` and fill it in. For Supabase, use the **publishable** and **secret** keys from
   *Project Settings → API Keys* (not the legacy anon/service_role keys).
4. `npm install`
5. `npm run gen:locations` to build the location pool (free: it only uses
   metadata lookups). Until you do, a small seed list of 20 cities is used.
6. `npm run dev`

## Cost notes

Google bills Street View per `StreetViewPanorama` created, not per step a
player takes, and the map per `Map` created. The game creates one of each
per player and reuses them across rounds, so a game should cost about one
Street View load and one map load per player. Check the usage graphs in
Cloud Console after your first game to confirm.

## Scripts

- `npm run dev` — local dev server
- `npm run test` — unit tests (vitest)
- `npm run lint` — eslint
- `npm run build` — production build
- `npm run gen:locations -- [count]` — regenerate `src/lib/locations.json`
