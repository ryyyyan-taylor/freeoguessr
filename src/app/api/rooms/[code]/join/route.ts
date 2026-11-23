import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";
import { createPlayer } from "@/lib/auth";
import { withErrorHandling } from "@/lib/api-route";

export const POST = withErrorHandling(async (request: Request, { params }: { params: Promise<{ code: string }> }) => {
  const { code } = await params;
  const roomCode = code.toUpperCase();
  const { name } = await request.json();
  if (typeof name !== "string" || !name.trim()) {
    return NextResponse.json({ error: "Name is required" }, { status: 400 });
  }

  const supabase = supabaseAdmin();
  const { data: room } = await supabase.from("rooms").select("code, status").eq("code", roomCode).maybeSingle();
  if (!room) return NextResponse.json({ error: "Room not found" }, { status: 404 });
  if (room.status !== "lobby") {
    return NextResponse.json({ error: "This room's game has already started" }, { status: 409 });
  }

  const created = await createPlayer(supabase, roomCode, name, false);
  if ("error" in created) return NextResponse.json({ error: created.error }, { status: 500 });

  return NextResponse.json(created);
});
