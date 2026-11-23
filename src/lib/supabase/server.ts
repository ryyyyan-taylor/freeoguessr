import { createClient } from "@supabase/supabase-js";

// Server-only client using the secret key (sb_secret_...), which acts as
// the service_role and bypasses RLS. Every table write and every read of
// hidden data goes through this — never import it from a client component.
// Supabase also rejects secret keys sent from a browser.
export function supabaseAdmin() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!, {
    auth: { persistSession: false },
  });
}
