import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";
import { withErrorHandling } from "@/lib/api-route";
import { rpcError } from "@/lib/game";
import { filterPool, pickLocation } from "@/lib/locations";
import { filterLabel, mapSizeFor } from "@/lib/regions";

export const POST = withErrorHandling(async (request: Request, { params }: { params: Promise<{ code: string }> }) => {
  const { code } = await params;
  const roomCode = code.toUpperCase();
  const { playerId, token } = await request.json();

  const supabase = supabaseAdmin();
  const { data: room } = await supabase
    .from("rooms")
    .select("location_filter, round_count")
    .eq("code", roomCode)
    .maybeSingle();
  if (!room) return NextResponse.json({ error: "Room not found" }, { status: 404 });

  const filter = room.location_filter as string | null;
  const available = filterPool(filter).length;
  if (available < room.round_count) {
    return NextResponse.json(
      { error: `${filterLabel(filter)} only has ${available} locations. Lower the number of rounds.` },
      { status: 400 }
    );
  }
  const location = pickLocation(filter, new Set())!;

  const { data, error } = await supabase.rpc("start_game", {
    p_room_code: roomCode,
    p_player_id: playerId,
    p_token: token,
    p_lat: location.lat,
    p_lng: location.lng,
    p_pano_id: location.panoId,
    p_location_filter: filter,
    p_map_size_m: mapSizeFor(filter),
    p_country: location.country,
  });
  if (error) throw error;
  return rpcError(data) ?? NextResponse.json({ gameId: data.gameId });
});
