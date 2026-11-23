import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Client-side client using the publishable key (sb_publishable_...), which
// acts as the anon role. It's only used for Realtime subscriptions, which
// can see the public-read tables (rooms, players, games, game_players,
// rounds); all writes go through the Next.js API routes instead, using the
// secret key server-side.
//
// Memoized — several independent subscribe calls each ask for one of these
// per mount, and supabase-js spins up its own auth client per instance, so
// without this they pile up and warn about duplicate GoTrueClients sharing
// the same localStorage key.
let client: SupabaseClient | undefined;

export function supabaseBrowser() {
  if (!client) {
    client = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!);
  }
  return client;
}
