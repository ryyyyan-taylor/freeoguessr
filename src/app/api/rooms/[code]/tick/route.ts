import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";
import { withErrorHandling } from "@/lib/api-route";

// There's no server-side timer: every client calls this when its countdown
// hits zero, and whichever request arrives first past the deadline ends the
// round. It can't end a round early, so it needs no auth.
export const POST = withErrorHandling(async (_request: Request, { params }: { params: Promise<{ code: string }> }) => {
  const { code } = await params;
  const { data, error } = await supabaseAdmin().rpc("finish_current_round", { p_room_code: code.toUpperCase() });
  if (error) throw error;
  return NextResponse.json({ finished: Boolean(data) });
});
