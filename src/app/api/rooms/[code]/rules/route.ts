import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";
import { authenticatePlayer } from "@/lib/auth";
import { withErrorHandling } from "@/lib/api-route";
import { MAX_ROUNDS, ROUND_TIME_OPTIONS } from "@/lib/rules";

export const POST = withErrorHandling(async (request: Request, { params }: { params: Promise<{ code: string }> }) => {
  const { code } = await params;
  const roomCode = code.toUpperCase();
  const { playerId, token, roundCount, roundTimeSeconds, isPrivate } = await request.json();

  const supabase = supabaseAdmin();
  const player = await authenticatePlayer(supabase, roomCode, playerId, token);
  if (!player?.is_host) {
    return NextResponse.json({ error: "Only the host can change rules" }, { status: 403 });
  }

  const update: Record<string, unknown> = {};
  if (roundCount !== undefined) {
    if (!Number.isInteger(roundCount) || roundCount < 1 || roundCount > MAX_ROUNDS) {
      return NextResponse.json({ error: `Rounds must be between 1 and ${MAX_ROUNDS}` }, { status: 400 });
    }
    update.round_count = roundCount;
  }
  if (roundTimeSeconds !== undefined) {
    if (!(ROUND_TIME_OPTIONS as readonly number[]).includes(roundTimeSeconds)) {
      return NextResponse.json({ error: "Invalid round time" }, { status: 400 });
    }
    update.round_time_seconds = roundTimeSeconds;
  }
  if (isPrivate !== undefined) update.is_private = Boolean(isPrivate);

  const { error } = await supabase.from("rooms").update(update).eq("code", roomCode);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
});
