import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";
import { withErrorHandling } from "@/lib/api-route";
import { rpcError } from "@/lib/game";
import { filterPool } from "@/lib/locations";
import { filterLabel, mapSizeFor } from "@/lib/regions";
import { planLocations } from "@/lib/selection";
import { isLocationMix } from "@/lib/rules";

export const POST = withErrorHandling(async (request: Request, { params }: { params: Promise<{ code: string }> }) => {
  const { code } = await params;
  const roomCode = code.toUpperCase();
  const { playerId, token } = await request.json();

  const supabase = supabaseAdmin();
  const { data: room } = await supabase
    .from("rooms")
    .select("location_filter, round_count, location_mix")
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

  // Every round's location is planned now, for variety across the game.
  const mix = isLocationMix(room.location_mix) ? room.location_mix : "balanced";
  const locations = planLocations(filter, room.round_count, mix).map((l) => ({
    lat: l.lat,
    lng: l.lng,
    panoId: l.panoId,
    country: l.country,
  }));

  const { data, error } = await supabase.rpc("start_game", {
    p_room_code: roomCode,
    p_player_id: playerId,
    p_token: token,
    p_locations: locations,
    p_location_filter: filter,
    p_map_size_m: mapSizeFor(filter),
  });
  if (error) throw error;
  return rpcError(data) ?? NextResponse.json({ gameId: data.gameId });
});
