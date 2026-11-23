import { NextResponse } from "next/server";

// Once anyone guesses, everyone else has this long to get theirs in.
export const GUESS_LOCK_SECONDS = 10;
// Accepts guesses this long past the deadline, to absorb request latency
// for a guess the client sent just as its timer hit zero.
export const GUESS_GRACE_MS = 1500;

// The game's Postgres functions (supabase/migrations/0002) return either
// {ok: true, ...} or {error, status}; turn the latter into an HTTP error.
export function rpcError(result: unknown): NextResponse | null {
  const r = result as { error?: string; status?: number } | null;
  if (!r) return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
  if (r.error) return NextResponse.json({ error: r.error }, { status: r.status ?? 400 });
  return null;
}
