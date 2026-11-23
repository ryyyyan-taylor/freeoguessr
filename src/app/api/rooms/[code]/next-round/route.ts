import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";
import { withErrorHandling } from "@/lib/api-route";
import { rpcError } from "@/lib/game";
import { locationKey, pickLocation } from "@/lib/locations";

export const POST = withErrorHandling(async (request: Request, { params }: { params: Promise<{ code: string }> }) => {
  const { code } = await params;
  const roomCode = code.toUpperCase();
  const { playerId, token, fromRound } = await request.json();

  const supabase = supabaseAdmin();
  const [{ data: used, error: usedError }, { data: game }] = await Promise.all([
    supabase.rpc("used_locations", { p_room_code: roomCode }),
    supabase
      .from("games")
      .select("location_filter")
      .eq("room_code", roomCode)
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);
  if (usedError) throw usedError;
  const location = pickLocation(game?.location_filter ?? null, new Set((used ?? []).map(locationKey)));
  if (!location) return NextResponse.json({ error: "Ran out of locations for this region" }, { status: 409 });

  // start_next_round checks the caller is host and that round `fromRound`
  // is the finished current round, so a double-click can't skip one.
  const { data, error } = await supabase.rpc("start_next_round", {
    p_room_code: roomCode,
    p_player_id: playerId,
    p_token: token,
    p_from_round: fromRound,
    p_lat: location.lat,
    p_lng: location.lng,
    p_pano_id: location.panoId,
    p_country: location.country,
  });
  if (error) throw error;
  return rpcError(data) ?? NextResponse.json({ ok: true });
});
