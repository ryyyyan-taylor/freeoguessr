import type { SupabaseClient } from "@supabase/supabase-js";
import { authenticatePlayer } from "@/lib/auth";
import { roomFromRow, type GameSnapshot, type Guess, type Player, type Room, type RoundSnapshot } from "@/lib/types";

export interface RoomSnapshot {
  room: Room;
  players: Player[];
  game: GameSnapshot | null;
  // The current round's panorama, only for an authenticated player in the
  // game. (Anyone with the pano id can look up its location through Google,
  // so this is a speed bump rather than real secrecy — fine among friends.)
  panoId: string | null;
  serverNow: string;
}

// Everything a screen needs to render a room, in two parallel batches of
// queries. Pass credentials to also get your own guess while a round is
// open, and the panorama.
export async function buildSnapshot(
  supabase: SupabaseClient,
  roomCode: string,
  playerId: unknown,
  token: unknown
): Promise<RoomSnapshot | null> {
  const [{ data: room }, { data: players }, me, { data: latestGame }] = await Promise.all([
    supabase.from("rooms").select("*").eq("code", roomCode).maybeSingle(),
    supabase
      .from("players")
      .select("id, name, is_host, connected")
      .eq("room_code", roomCode)
      .order("created_at", { ascending: true }),
    authenticatePlayer(supabase, roomCode, playerId, token),
    supabase
      .from("games")
      .select("*")
      .eq("room_code", roomCode)
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);
  if (!room) return null;

  let game: GameSnapshot | null = null;
  let panoId: string | null = null;

  if (latestGame) {
    const [{ data: gamePlayers }, { data: rounds }, { data: guesses }, { data: currentAnswer }] = await Promise.all([
      supabase.from("game_players").select("*").eq("game_id", latestGame.id),
      supabase.from("rounds").select("*").eq("game_id", latestGame.id).order("round_number", { ascending: true }),
      supabase.from("guesses").select("*, rounds!inner(game_id)").eq("rounds.game_id", latestGame.id),
      me
        ? supabase
            .from("round_answers")
            .select("pano_id, rounds!inner(game_id, round_number)")
            .eq("rounds.game_id", latestGame.id)
            .eq("rounds.round_number", latestGame.current_round)
            .maybeSingle()
        : Promise.resolve({ data: null }),
    ]);

    const roundSnapshots: RoundSnapshot[] = (rounds ?? []).map((r) => {
      const finished = r.status === "finished";
      // Other players' guesses stay hidden until the round is over.
      const visible = (guesses ?? []).filter((g) => g.round_id === r.id && (finished || g.player_id === me?.id));
      return {
        id: r.id,
        roundNumber: r.round_number,
        status: r.status,
        startedAt: r.started_at,
        deadlineAt: r.deadline_at,
        answer:
          finished && r.answer_lat !== null
            ? { lat: r.answer_lat, lng: r.answer_lng, country: r.answer_country }
            : null,
        guesses: visible.map(
          (g): Guess => ({
            playerId: g.player_id,
            lat: g.lat,
            lng: g.lng,
            distanceM: g.distance_m,
            score: g.score,
            guessCountry: g.guess_country,
            countryDistanceM: g.country_distance_m,
          })
        ),
      };
    });

    game = {
      id: latestGame.id,
      status: latestGame.status,
      roundCount: latestGame.round_count,
      roundTimeSeconds: latestGame.round_time_seconds,
      locationFilter: latestGame.location_filter,
      scoringMode: latestGame.scoring_mode,
      currentRound: latestGame.current_round,
      players: (gamePlayers ?? []).map((gp) => ({
        playerId: gp.player_id,
        totalScore: gp.total_score,
        lastGuessedRound: gp.last_guessed_round,
      })),
      rounds: roundSnapshots,
    };

    if (me && gamePlayers?.some((gp) => gp.player_id === me.id)) {
      panoId = currentAnswer?.pano_id ?? null;
    }
  }

  return {
    room: roomFromRow(room),
    players: (players ?? []).map((p) => ({ id: p.id, name: p.name, isHost: p.is_host, connected: p.connected })),
    game,
    panoId,
    serverNow: new Date().toISOString(),
  };
}
