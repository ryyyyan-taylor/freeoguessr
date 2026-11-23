"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useIdentity, type Identity } from "@/lib/identity";
import { subscribeGame, subscribePlayersTable, subscribeRoomRow, upsertPlayer } from "@/lib/realtime/tables";
import { useHostFailover } from "@/lib/realtime/presence";
import { PLAYER_COLORS } from "@/lib/google-maps";
import { formatDistance, SCORING_MODE_LABELS } from "@/lib/rules";
import { countryName } from "@/lib/country-names";
import { MAX_ROUND_SCORE, type LatLng } from "@/lib/scoring";
import { StreetView } from "@/components/StreetView";
import { GameMap, type MapRound } from "@/components/GameMap";
import type { GameSnapshot, Guess, Player, Room, RoundSnapshot, ScoringMode } from "@/lib/types";
import { filterLabel, regionFor } from "@/lib/regions";

interface Snapshot {
  room: Room;
  players: Player[];
  game: GameSnapshot | null;
  panoId: string | null;
  serverNow: string;
}

const TICK_RETRY_MS = 2000;
const REFRESH_BATCH_MS = 50;

function post(path: string, identity: Identity, body: Record<string, unknown> = {}) {
  return fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ playerId: identity.playerId, token: identity.token, ...body }),
  });
}

export function GameView({ roomCode }: { roomCode: string }) {
  const router = useRouter();
  const identity = useIdentity(roomCode);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [players, setPlayers] = useState<Player[]>([]);
  const [error, setError] = useState<string | null>(null);
  // Server time minus local time, so every client counts down to the same
  // server-side deadline regardless of its own clock.
  const [clockOffset, setClockOffset] = useState(0);

  // Snapshots arrive from refetches and from guess responses, and can land
  // out of order. Each request takes a sequence number when it starts, and
  // a response older than the last one applied is dropped, so a slow
  // refetch can't overwrite fresher results.
  const seq = useRef({ next: 0, applied: -1 });
  const beginRequest = useCallback(() => seq.current.next++, []);
  const applySnapshot = useCallback(
    (data: Snapshot, requestSeq: number) => {
      if (requestSeq <= seq.current.applied) return;
      seq.current.applied = requestSeq;
      setClockOffset(Date.parse(data.serverNow) - Date.now());
      setSnapshot(data);
      setPlayers(data.players);
      if (data.room.status === "lobby") router.replace(`/lobby/${roomCode}`);
    },
    [roomCode, router]
  );

  const load = useCallback(async () => {
    const requestSeq = beginRequest();
    const query = identity ? `?playerId=${identity.playerId}&token=${identity.token}` : "";
    const res = await fetch(`/api/rooms/${roomCode}${query}`);
    if (!res.ok) {
      setError("Room not found");
      return;
    }
    applySnapshot((await res.json()) as Snapshot, requestSeq);
  }, [roomCode, identity, beginRequest, applySnapshot]);

  // One guess fires several Realtime events at once (the guess flag, the
  // round ending, the totals), so batch them into a single refetch.
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refresh = useCallback(() => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = null;
      load();
    }, REFRESH_BATCH_MS);
  }, [load]);

  useEffect(() => {
    // Initial load; later updates arrive through the subscriptions below.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  useEffect(() => {
    const roomChannel = subscribeRoomRow(roomCode, (row) => {
      if (row.status === "lobby") router.push(`/lobby/${roomCode}`);
    });
    const playersChannel = subscribePlayersTable(roomCode, (player) => setPlayers((prev) => upsertPlayer(prev, player)));
    return () => {
      roomChannel.unsubscribe();
      playersChannel.unsubscribe();
    };
  }, [roomCode, router]);

  const gameId = snapshot?.game?.id;
  useEffect(() => {
    if (!gameId) return;
    // Round and game changes (new round, deadline pulled in, round over)
    // need hidden data from the API, so refetch. "Has guessed" flags are
    // public and patched in place.
    const channel = subscribeGame(gameId, {
      onGame: () => refresh(),
      onRound: () => refresh(),
      onGamePlayer: (row) =>
        setSnapshot((prev) =>
          prev?.game
            ? {
                ...prev,
                game: {
                  ...prev.game,
                  players: prev.game.players.map((p) =>
                    p.playerId === row.player_id
                      ? { ...p, lastGuessedRound: row.last_guessed_round, totalScore: row.total_score }
                      : p
                  ),
                },
              }
            : prev
        ),
    });
    return () => {
      channel.unsubscribe();
    };
  }, [gameId, refresh]);

  useHostFailover(roomCode, players, identity);

  if (error) return <div className="flex flex-1 items-center justify-center">{error}</div>;
  if (!identity) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4">
        <p>This game is already in progress.</p>
        <Link href="/" className="underline">
          Back to home
        </Link>
      </div>
    );
  }
  if (!snapshot?.game) return <div className="flex flex-1 items-center justify-center">Loading…</div>;

  return (
    <GameScreen
      roomCode={roomCode}
      identity={identity}
      game={snapshot.game}
      panoId={snapshot.panoId}
      players={players}
      clockOffset={clockOffset}
      beginRequest={beginRequest}
      applySnapshot={applySnapshot}
    />
  );
}

function GameScreen({
  roomCode,
  identity,
  game,
  panoId,
  players,
  clockOffset,
  beginRequest,
  applySnapshot,
}: {
  roomCode: string;
  identity: Identity;
  game: GameSnapshot;
  panoId: string | null;
  players: Player[];
  clockOffset: number;
  beginRequest: () => number;
  applySnapshot: (data: Snapshot, requestSeq: number) => void;
}) {
  const round = game.rounds.find((r) => r.roundNumber === game.currentRound) ?? null;
  const isHost = players.find((p) => p.id === identity.playerId)?.isHost ?? false;
  const myGuess = round?.guesses.find((g) => g.playerId === identity.playerId) ?? null;
  const myTotal = game.players.find((p) => p.playerId === identity.playerId)?.totalScore ?? 0;

  // Join order decides colours, so they're the same on every screen.
  const colorFor = useCallback(
    (playerId: string) => {
      const index = players.findIndex((p) => p.id === playerId);
      return PLAYER_COLORS[(index < 0 ? 0 : index) % PLAYER_COLORS.length];
    },
    [players]
  );
  const nameFor = useCallback(
    (playerId: string) => players.find((p) => p.id === playerId)?.name ?? "?",
    [players]
  );

  const [pin, setPin] = useState<LatLng | null>(null);
  const [mapExpanded, setMapExpanded] = useState(false);
  const [resetKey, setResetKey] = useState(0);
  const [showFinal, setShowFinal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // Clear the pin when a new round starts.
  const roundId = round?.id;
  const [pinRoundId, setPinRoundId] = useState(roundId);
  if (pinRoundId !== roundId) {
    setPinRoundId(roundId);
    setPin(null);
    setMapExpanded(false);
  }

  const now = useNow(250) + clockOffset;
  const roundActive = round?.status === "active";
  const msLeft = round ? new Date(round.deadlineAt).getTime() - now : 0;

  // Locks the guess in on screen immediately; the response carries the
  // fresh snapshot (with results, if this guess ended the round), so
  // there's no wait for Realtime.
  const [lockedRoundId, setLockedRoundId] = useState<string | null>(null);
  const submitGuess = useCallback(
    async (position: LatLng, forRoundId: string) => {
      setLockedRoundId(forRoundId);
      setActionError(null);
      const requestSeq = beginRequest();
      const res = await post(`/api/rooms/${roomCode}/guess`, identity, { lat: position.lat, lng: position.lng });
      const data = await res.json();
      if (!res.ok) {
        setLockedRoundId(null);
        setActionError(data.error ?? "Could not submit guess");
        return;
      }
      applySnapshot(data.snapshot, requestSeq);
    },
    [roomCode, identity, beginRequest, applySnapshot]
  );
  const guessLocked = Boolean(myGuess) || (lockedRoundId !== null && lockedRoundId === roundId);

  // Space locks in a placed pin, like GeoGuessr.
  const canGuess = round?.status === "active" && pin !== null && !guessLocked;
  useEffect(() => {
    if (!canGuess || !round || !pin) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code !== "Space" || e.repeat) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable]")) return;
      e.preventDefault();
      submitGuess(pin, round.id);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [canGuess, round, pin, submitGuess]);

  // When time runs out: submit a placed-but-unconfirmed pin, then ask the
  // server to end the round, retrying until it does.
  const expiredRoundRef = useRef<string | null>(null);
  const pinRef = useRef(pin);
  const myGuessRef = useRef(myGuess);
  useEffect(() => {
    pinRef.current = pin;
    myGuessRef.current = myGuess;
  });
  const timeUp = roundActive && msLeft <= 0;
  useEffect(() => {
    if (!timeUp || !round || expiredRoundRef.current === round.id) return;
    expiredRoundRef.current = round.id;
    let stopped = false;
    let retry: ReturnType<typeof setTimeout>;
    (async () => {
      if (pinRef.current && !myGuessRef.current) await submitGuess(pinRef.current, round.id);
      const tick = async () => {
        if (stopped) return;
        const res = await post(`/api/rooms/${roomCode}/tick`, identity);
        const data = res.ok ? await res.json() : null;
        if (!data?.finished && !stopped) retry = setTimeout(tick, TICK_RETRY_MS);
      };
      tick();
    })();
    return () => {
      stopped = true;
      clearTimeout(retry);
    };
  }, [timeUp, round, roomCode, identity, submitGuess]);

  async function hostAction(path: string, body: Record<string, unknown> = {}) {
    setBusy(true);
    setActionError(null);
    const res = await post(path, identity, body);
    setBusy(false);
    if (!res.ok) {
      const data = await res.json();
      setActionError(data.error ?? "Something went wrong");
      return false;
    }
    return true;
  }

  async function playAgain() {
    if (await hostAction(`/api/rooms/${roomCode}/reset`)) await hostAction(`/api/rooms/${roomCode}/start`);
  }

  // Memoized so the map only redraws when results actually change, not on
  // every timer tick.
  const roundResults = useMemo<MapRound[]>(() => {
    const toMapRound = (r: RoundSnapshot): MapRound | null =>
      r.answer
        ? {
            answer: r.answer,
            guesses: r.guesses.map((g) => ({
              position: { lat: g.lat, lng: g.lng },
              label: nameFor(g.playerId).charAt(0).toUpperCase(),
              color: colorFor(g.playerId),
            })),
          }
        : null;
    const rounds = showFinal ? game.rounds : game.rounds.filter((r) => r.roundNumber === game.currentRound);
    return rounds.map(toMapRound).filter((r): r is MapRound => r !== null);
  }, [showFinal, game.rounds, game.currentRound, nameFor, colorFor]);

  const phase: "guessing" | "results" | "final" =
    showFinal && game.status === "finished" ? "final" : roundActive ? "guessing" : "results";
  const isLastRound = game.currentRound >= game.roundCount;
  const guessedIds = new Set(game.players.filter((p) => p.lastGuessedRound >= game.currentRound).map((p) => p.playerId));
  const standings = [...game.players].sort((a, b) => b.totalScore - a.totalScore);

  return (
    <div className="relative h-dvh w-full overflow-hidden bg-zinc-900">
      {/* Kept mounted across rounds so it's only ever created once. */}
      <div className={phase === "guessing" ? "" : "invisible"}>
        <StreetView panoId={panoId} resetKey={resetKey} />
      </div>

      {phase === "guessing" && (
        <>
          <div className="absolute left-3 top-3 z-10 flex gap-2 text-white">
            <HudBox label="Map" value={filterLabel(game.locationFilter)} />
            {game.scoringMode === "country" && <HudBox label="Scoring" value={SCORING_MODE_LABELS.country} />}
            <HudBox label="Round" value={`${game.currentRound} / ${game.roundCount}`} />
            <HudBox label="Score" value={myTotal.toLocaleString()} />
            <HudBox label="Time" value={formatClock(msLeft)} urgent={msLeft <= 10_000} />
          </div>
          <div className="absolute right-3 top-3 z-10 flex flex-col items-end gap-2">
            <div className="flex flex-wrap justify-end gap-1">
              {players
                .filter((p) => game.players.some((gp) => gp.playerId === p.id))
                .map((p) => (
                  <span
                    key={p.id}
                    className="rounded-full px-2 py-0.5 text-xs text-white"
                    style={{ backgroundColor: colorFor(p.id), opacity: guessedIds.has(p.id) ? 1 : 0.5 }}
                  >
                    {guessedIds.has(p.id) ? "✓ " : ""}
                    {p.name}
                  </span>
                ))}
            </div>
            <button
              onClick={() => setResetKey((k) => k + 1)}
              className="rounded bg-black/70 px-3 py-1 text-sm text-white hover:bg-black"
            >
              Return to start
            </button>
          </div>
        </>
      )}

      {/* The map element is never unmounted, only moved and resized, so
          the game only pays for one map load. */}
      <div
        className={
          phase === "guessing"
            ? `group absolute bottom-3 right-3 z-10 flex flex-col gap-2 transition-all ${
                mapExpanded ? "h-[70vh] w-[min(56rem,calc(100vw-1.5rem))]" : "h-56 w-80 hover:h-[60vh] hover:w-[min(48rem,calc(100vw-1.5rem))]"
              }`
            : "absolute inset-x-0 top-0 z-10 h-[55vh]"
        }
      >
        <div className="relative min-h-0 flex-1 overflow-hidden rounded-lg h-full">
          <GameMap
            mode={phase === "guessing" ? "guess" : "results"}
            pin={pin}
            onPick={guessLocked ? ignorePick : setPin}
            results={roundResults}
            startBounds={regionFor(game.locationFilter)?.bounds ?? null}
          />
          {phase === "guessing" && (
            <button
              onClick={() => setMapExpanded((e) => !e)}
              className="absolute left-2 top-2 rounded bg-white/90 px-2 py-0.5 text-xs text-black shadow"
            >
              {mapExpanded ? "Shrink" : "Expand"}
            </button>
          )}
        </div>
        {phase === "guessing" && (
          <button
            onClick={() => pin && round && submitGuess(pin, round.id)}
            disabled={!pin || guessLocked}
            className="rounded-full bg-green-600 py-2 font-semibold text-white disabled:bg-zinc-600 disabled:text-zinc-300"
          >
            {myGuess
              ? "Guessed. Waiting for others…"
              : guessLocked
                ? "Locking in…"
                : pin
                  ? "Guess (Space)"
                  : "Place your pin on the map"}
          </button>
        )}
        {phase === "guessing" && actionError && <p className="text-sm text-red-400">{actionError}</p>}
      </div>

      {phase === "results" && round && (
        <ResultsPanel>
          <h2 className="text-xl font-bold">
            Round {round.roundNumber} of {game.roundCount}
          </h2>
          {round.answer?.country && (
            <p>
              The location was in <strong>{countryName(round.answer.country)}</strong>.
            </p>
          )}
          <p className="text-zinc-500">
            {myGuess
              ? `${guessSummary(myGuess, game.scoringMode, round.answer?.country ?? null)}: ${myGuess.score.toLocaleString()} points`
              : "You didn't guess in time: 0 points"}
          </p>
          <ScoreBar score={myGuess?.score ?? 0} />
          <table className="w-full text-sm">
            <thead className="text-left text-zinc-500">
              <tr>
                <th className="py-1">Player</th>
                <th>{game.scoringMode === "country" ? "Guess" : "Distance"}</th>
                <th className="text-right">Round</th>
                <th className="text-right">Total</th>
              </tr>
            </thead>
            <tbody>
              {standings.map((p) => {
                const guess = round.guesses.find((g) => g.playerId === p.playerId);
                return (
                  <tr key={p.playerId} className="border-t dark:border-zinc-700">
                    <td className="py-1">
                      <PlayerName name={nameFor(p.playerId)} color={colorFor(p.playerId)} />
                    </td>
                    <td>{guess ? guessCell(guess, game.scoringMode) : "No guess"}</td>
                    <td className="text-right">{(guess?.score ?? 0).toLocaleString()}</td>
                    <td className="text-right font-semibold">{p.totalScore.toLocaleString()}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {actionError && <p className="text-sm text-red-600">{actionError}</p>}
          {isLastRound ? (
            <button onClick={() => setShowFinal(true)} className={primaryButton}>
              See final results
            </button>
          ) : isHost ? (
            <button
              onClick={() => hostAction(`/api/rooms/${roomCode}/next-round`, { fromRound: round.roundNumber })}
              disabled={busy}
              className={primaryButton}
            >
              Next round
            </button>
          ) : (
            <p className="text-sm text-zinc-500">Waiting for the host to start the next round…</p>
          )}
        </ResultsPanel>
      )}

      {phase === "final" && (
        <ResultsPanel>
          <h2 className="text-xl font-bold">Final results</h2>
          <table className="w-full text-sm">
            <thead className="text-left text-zinc-500">
              <tr>
                <th className="py-1">#</th>
                <th>Player</th>
                {game.rounds.map((r) => (
                  <th key={r.id} className="text-right">
                    R{r.roundNumber}
                  </th>
                ))}
                <th className="text-right">Total</th>
              </tr>
            </thead>
            <tbody>
              {standings.map((p, index) => (
                <tr key={p.playerId} className="border-t dark:border-zinc-700">
                  <td className="py-1">{index + 1}</td>
                  <td>
                    <PlayerName name={nameFor(p.playerId)} color={colorFor(p.playerId)} />
                  </td>
                  {game.rounds.map((r) => (
                    <td key={r.id} className="text-right">
                      {(r.guesses.find((g) => g.playerId === p.playerId)?.score ?? 0).toLocaleString()}
                    </td>
                  ))}
                  <td className="text-right font-semibold">
                    {p.totalScore.toLocaleString()}
                    <span className="text-zinc-500"> / {(MAX_ROUND_SCORE * game.roundCount).toLocaleString()}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {actionError && <p className="text-sm text-red-600">{actionError}</p>}
          {isHost ? (
            <div className="flex gap-2">
              <button onClick={playAgain} disabled={busy} className={`flex-1 ${primaryButton}`}>
                Play again
              </button>
              <button
                onClick={() => hostAction(`/api/rooms/${roomCode}/reset`)}
                disabled={busy}
                className="flex-1 rounded-full border py-2 font-medium disabled:opacity-50 dark:border-zinc-600"
              >
                Back to lobby
              </button>
            </div>
          ) : (
            <p className="text-sm text-zinc-500">Waiting for the host…</p>
          )}
        </ResultsPanel>
      )}
    </div>
  );
}

const ignorePick = () => {};

// The line under "The location was in…" for your own guess.
function guessSummary(guess: Guess, mode: ScoringMode, answerCountry: string | null) {
  if (mode === "country" && answerCountry && guess.countryDistanceM !== null) {
    if (guess.countryDistanceM === 0) return "Right country";
    return `You guessed ${countryName(guess.guessCountry)}, ${formatDistance(guess.countryDistanceM)} from ${countryName(answerCountry)}`;
  }
  return `Your guess was ${formatDistance(guess.distanceM)} away`;
}

// A guess in the round results table.
function guessCell(guess: Guess, mode: ScoringMode) {
  if (mode === "country" && guess.countryDistanceM !== null) {
    if (guess.countryDistanceM === 0) return `✓ ${countryName(guess.guessCountry)}`;
    return `${countryName(guess.guessCountry)} · ${formatDistance(guess.countryDistanceM)} off`;
  }
  return formatDistance(guess.distanceM);
}

const primaryButton =
  "rounded-full bg-black px-6 py-2 font-medium text-white disabled:opacity-50 dark:bg-white dark:text-black";

function useNow(intervalMs: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

function formatClock(ms: number) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function HudBox({ label, value, urgent }: { label: string; value: string; urgent?: boolean }) {
  return (
    <div className={`rounded px-3 py-1 text-center ${urgent ? "bg-red-600" : "bg-black/70"}`}>
      <div className="text-[10px] uppercase tracking-wide opacity-70">{label}</div>
      <div className="font-mono font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function ResultsPanel({ children }: { children: React.ReactNode }) {
  return (
    <div className="absolute inset-x-0 bottom-0 z-20 flex h-[45vh] justify-center overflow-y-auto bg-white p-4 dark:bg-zinc-950">
      <div className="flex w-full max-w-2xl flex-col gap-3">{children}</div>
    </div>
  );
}

function ScoreBar({ score }: { score: number }) {
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
      <div className="h-full bg-green-600" style={{ width: `${(score / MAX_ROUND_SCORE) * 100}%` }} />
    </div>
  );
}

function PlayerName({ name, color }: { name: string; color: string }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span className="h-3 w-3 rounded-full" style={{ backgroundColor: color }} />
      {name}
    </span>
  );
}
