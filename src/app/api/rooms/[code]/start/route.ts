import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";
import { withErrorHandling } from "@/lib/api-route";
import { rpcError } from "@/lib/game";
import { pickLocation } from "@/lib/locations";

export const POST = withErrorHandling(async (request: Request, { params }: { params: Promise<{ code: string }> }) => {
  const { code } = await params;
  const { playerId, token } = await request.json();

  const location = await pickLocation(new Set());
  const { data, error } = await supabaseAdmin().rpc("start_game", {
    p_room_code: code.toUpperCase(),
    p_player_id: playerId,
    p_token: token,
    p_lat: location.lat,
    p_lng: location.lng,
    p_pano_id: location.panoId,
  });
  if (error) throw error;
  return rpcError(data) ?? NextResponse.json({ gameId: data.gameId });
});
