import type { SupabaseClient } from "@supabase/supabase-js";

export interface AuthedPlayer {
  id: string;
  room_code: string;
  name: string;
  is_host: boolean;
}

// Tokens live in `player_tokens` (secret-key only), not on the
// public-read `players` row. One query: the token row joined to its player.
export async function authenticatePlayer(
  supabase: SupabaseClient,
  roomCode: string,
  playerId: unknown,
  token: unknown
): Promise<AuthedPlayer | null> {
  if (typeof playerId !== "string" || typeof token !== "string") return null;
  const { data } = await supabase
    .from("player_tokens")
    .select("players!inner(id, room_code, name, is_host)")
    .eq("player_id", playerId)
    .eq("token", token)
    .eq("players.room_code", roomCode)
    .maybeSingle();
  return (data?.players as unknown as AuthedPlayer | undefined) ?? null;
}

// Shared by room creation and join.
export async function createPlayer(
  supabase: SupabaseClient,
  roomCode: string,
  name: string,
  isHost: boolean
): Promise<{ playerId: string; token: string } | { error: string }> {
  const playerId = crypto.randomUUID();
  const token = crypto.randomUUID();
  const { error } = await supabase
    .from("players")
    .insert({ id: playerId, room_code: roomCode, name: name.trim().slice(0, 30), is_host: isHost });
  if (error) return { error: error.message };
  const { error: tokenError } = await supabase.from("player_tokens").insert({ player_id: playerId, token });
  if (tokenError) return { error: tokenError.message };
  return { playerId, token };
}
