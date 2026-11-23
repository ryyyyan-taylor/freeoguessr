import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";
import { withErrorHandling } from "@/lib/api-route";
import { rpcError } from "@/lib/game";

// The next round's location was planned when the game started, so this is
// one call. start_next_round checks the caller is host and that round
// `fromRound` is the finished current round, so a double-click can't skip one.
export const POST = withErrorHandling(async (request: Request, { params }: { params: Promise<{ code: string }> }) => {
  const { code } = await params;
  const { playerId, token, fromRound } = await request.json();

  const { data, error } = await supabaseAdmin().rpc("start_next_round", {
    p_room_code: code.toUpperCase(),
    p_player_id: playerId,
    p_token: token,
    p_from_round: fromRound,
  });
  if (error) throw error;
  return rpcError(data) ?? NextResponse.json({ ok: true });
});
