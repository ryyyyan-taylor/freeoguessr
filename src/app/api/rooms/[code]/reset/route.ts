import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";
import { authenticatePlayer } from "@/lib/auth";
import { withErrorHandling } from "@/lib/api-route";

// Host sends everyone back to the lobby, abandoning any game in progress.
export const POST = withErrorHandling(async (request: Request, { params }: { params: Promise<{ code: string }> }) => {
  const { code } = await params;
  const roomCode = code.toUpperCase();
  const { playerId, token } = await request.json();

  const supabase = supabaseAdmin();
  const player = await authenticatePlayer(supabase, roomCode, playerId, token);
  if (!player?.is_host) {
    return NextResponse.json({ error: "Only the host can return to the lobby" }, { status: 403 });
  }

  await supabase
    .from("games")
    .update({ status: "finished", ended_at: new Date().toISOString() })
    .eq("room_code", roomCode)
    .eq("status", "active");
  const { error } = await supabase.from("rooms").update({ status: "lobby" }).eq("code", roomCode);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
});
