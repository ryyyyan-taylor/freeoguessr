import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";
import { withErrorHandling } from "@/lib/api-route";
import { GUESS_GRACE_MS, GUESS_LOCK_SECONDS, rpcError } from "@/lib/game";
import { buildSnapshot } from "@/lib/snapshot";

// One database round trip for the guess itself (submit_guess does auth,
// scoring, the 10-second lock and ending the round), then the fresh
// snapshot so the client can show results without waiting on Realtime.
export const POST = withErrorHandling(async (request: Request, { params }: { params: Promise<{ code: string }> }) => {
  const { code } = await params;
  const roomCode = code.toUpperCase();
  const { playerId, token, lat, lng } = await request.json();
  if (typeof lat !== "number" || typeof lng !== "number" || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return NextResponse.json({ error: "Invalid guess" }, { status: 400 });
  }

  const supabase = supabaseAdmin();
  const { data, error } = await supabase.rpc("submit_guess", {
    p_room_code: roomCode,
    p_player_id: playerId,
    p_token: token,
    p_lat: lat,
    p_lng: lng,
    p_grace_ms: GUESS_GRACE_MS,
    p_lock_seconds: GUESS_LOCK_SECONDS,
  });
  if (error) throw error;
  const failure = rpcError(data);
  if (failure) return failure;

  const snapshot = await buildSnapshot(supabase, roomCode, playerId, token);
  return NextResponse.json({ ok: true, finished: data.finished, snapshot });
});
