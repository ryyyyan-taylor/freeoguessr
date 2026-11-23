import { supabaseBrowser } from "@/lib/supabase/browser";
import type { GamePlayerRow, GameRow, Player, PlayerRow, RoomRow, RoundRow } from "@/lib/types";

export function subscribeRoomRow(roomCode: string, onChange: (room: RoomRow) => void) {
  const supabase = supabaseBrowser();
  return supabase
    .channel(`room:${roomCode}`)
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "rooms", filter: `code=eq.${roomCode}` },
      (payload) => onChange(payload.new as RoomRow)
    )
    .subscribe();
}

function playerFromRow(row: PlayerRow): Player {
  return { id: row.id, name: row.name, isHost: row.is_host, connected: row.connected };
}

// Shared by Lobby/Race/Finish — join, name, and is_host changes (the last
// from host-transfer) all need to reach every screen live.
export function subscribePlayersTable(roomCode: string, onChange: (player: Player) => void) {
  const supabase = supabaseBrowser();
  return supabase
    .channel(`players:${roomCode}`)
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "players", filter: `room_code=eq.${roomCode}` },
      (payload) => onChange(playerFromRow(payload.new as PlayerRow))
    )
    .subscribe();
}

export function upsertPlayer(players: Player[], updated: Player): Player[] {
  const index = players.findIndex((p) => p.id === updated.id);
  if (index === -1) return [...players, updated];
  const copy = [...players];
  copy[index] = updated;
  return copy;
}

// Everything that changes during a game. Rounds are both inserted (a new
// round starts) and updated (deadline pulled in, round finished).
export function subscribeGame(
  gameId: string,
  handlers: {
    onGame: (game: GameRow) => void;
    onGamePlayer: (gamePlayer: GamePlayerRow) => void;
    onRound: (round: RoundRow) => void;
  }
) {
  const supabase = supabaseBrowser();
  return supabase
    .channel(`game:${gameId}`)
    .on(
      "postgres_changes",
      { event: "UPDATE", schema: "public", table: "games", filter: `id=eq.${gameId}` },
      (payload) => handlers.onGame(payload.new as GameRow)
    )
    .on(
      "postgres_changes",
      { event: "UPDATE", schema: "public", table: "game_players", filter: `game_id=eq.${gameId}` },
      (payload) => handlers.onGamePlayer(payload.new as GamePlayerRow)
    )
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "rounds", filter: `game_id=eq.${gameId}` },
      (payload) => handlers.onRound(payload.new as RoundRow)
    )
    .subscribe();
}
