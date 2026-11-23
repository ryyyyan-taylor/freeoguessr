import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";
import { withErrorHandling } from "@/lib/api-route";
import { buildSnapshot } from "@/lib/snapshot";

export const GET = withErrorHandling(async (request: Request, { params }: { params: Promise<{ code: string }> }) => {
  const { code } = await params;
  const { searchParams } = new URL(request.url);
  const snapshot = await buildSnapshot(
    supabaseAdmin(),
    code.toUpperCase(),
    searchParams.get("playerId"),
    searchParams.get("token")
  );
  if (!snapshot) return NextResponse.json({ error: "Room not found" }, { status: 404 });
  return NextResponse.json(snapshot);
});
