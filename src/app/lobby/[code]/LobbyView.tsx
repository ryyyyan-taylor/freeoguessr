"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { getSavedName, saveName, setIdentity, useIdentity, type Identity } from "@/lib/identity";
import { subscribeRoomRow, subscribePlayersTable, upsertPlayer } from "@/lib/realtime/tables";
import { useHostFailover } from "@/lib/realtime/presence";
import { formatSeconds, MAX_ROUNDS, ROUND_TIME_OPTIONS, SCORING_MODE_LABELS, type ScoringMode } from "@/lib/rules";
import { CONTINENTS, countriesByContinent, filterLabel, parseFilter } from "@/lib/regions";
import { roomFromRow, type Player, type Room, type RoomRow } from "@/lib/types";


interface Props {
  roomCode: string;
}

const COUNTRY_GROUPS = countriesByContinent();

const HEARTBEAT_INTERVAL_MS = 15_000;

export function LobbyView({ roomCode }: Props) {
  const router = useRouter();
  const identity = useIdentity(roomCode);
  const [room, setRoom] = useState<Room | null>(null);
  const [players, setPlayers] = useState<Player[]>([]);
  const [error, setError] = useState<string | null>(null);
  // Guards the redirect on the lobby->playing transition rather than the
  // value, so a later, unrelated `rooms` update while still playing (e.g.
  // the host revisits this tab) doesn't re-push every time.
  const lastStatus = useRef<Room["status"] | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/rooms/${roomCode}`).then(async (res) => {
      if (!res.ok) {
        if (!cancelled) setError("Room not found");
        return;
      }
      const data = await res.json();
      if (cancelled) return;
      lastStatus.current = data.room.status;
      if (data.room.status === "playing") {
        router.replace(`/game/${roomCode}`);
        return;
      }
      setRoom(data.room);
      setPlayers(data.players);
    });
    return () => {
      cancelled = true;
    };
  }, [roomCode, router]);

  useEffect(() => {
    const channel = subscribeRoomRow(roomCode, (row: RoomRow) => {
      setRoom(roomFromRow(row));
      if (row.status === "playing" && lastStatus.current !== "playing") {
        router.push(`/game/${roomCode}`);
      }
      lastStatus.current = row.status;
    });
    return () => {
      channel.unsubscribe();
    };
  }, [roomCode, router]);

  useEffect(() => {
    const channel = subscribePlayersTable(roomCode, (player) => {
      setPlayers((prev) => upsertPlayer(prev, player));
    });
    return () => {
      channel.unsubscribe();
    };
  }, [roomCode]);

  useHostFailover(roomCode, players, identity);

  // Keeps this player's `last_seen_at` fresh so the home page's open-room
  // list (see GET /api/rooms) knows someone is actually still here — well
  // under ROOM_STALE_MS there, so a missed beat or two doesn't drop the
  // room from the list.
  useEffect(() => {
    if (!identity) return;
    const beat = () => {
      fetch(`/api/rooms/${roomCode}/heartbeat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ playerId: identity.playerId, token: identity.token }),
      });
    };
    beat();
    const interval = setInterval(beat, HEARTBEAT_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [roomCode, identity]);

  if (error) {
    return <div className="flex flex-1 items-center justify-center">{error}</div>;
  }

  if (!identity) {
    return <JoinForm roomCode={roomCode} />;
  }

  if (!room) {
    return <div className="flex flex-1 items-center justify-center">Loading…</div>;
  }

  const isHost = players.find((p) => p.id === identity.playerId)?.isHost ?? false;

  return (
    <div className="flex flex-1 flex-col items-center p-6 gap-8">
      <div className="text-center">
        <p className="text-sm text-zinc-500">Room code</p>
        <p className="text-5xl font-mono font-bold tracking-widest">{roomCode}</p>
        {room.isPrivate && (
          <p className="text-sm text-zinc-500 mt-2">Private room. Share the code to invite friends.</p>
        )}
      </div>

      <div className="w-full max-w-md">
        <h2 className="font-semibold mb-2">Players</h2>
        <ul className="divide-y rounded-lg border dark:border-zinc-700 dark:divide-zinc-700">
          {players.map((p) => (
            <li key={p.id} className="px-4 py-2 flex justify-between">
              <span>{p.name}</span>
              {p.isHost && <span className="text-xs text-zinc-500">Host</span>}
            </li>
          ))}
        </ul>
      </div>

      <RulesPanel roomCode={roomCode} identity={identity} room={room} isHost={isHost} />

      {isHost ? (
        <StartGameButton roomCode={roomCode} identity={identity} />
      ) : (
        <p className="text-zinc-500 text-sm">Waiting for the host to start the game…</p>
      )}
    </div>
  );
}

function JoinForm({ roomCode }: { roomCode: string }) {
  const [name, setName] = useState(getSavedName);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleJoin() {
    if (!name.trim()) {
      setError("Enter your name first");
      return;
    }
    setBusy(true);
    setError(null);
    saveName(name.trim());
    const res = await fetch(`/api/rooms/${roomCode}/join`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const data = await res.json();
    setBusy(false);
    if (!res.ok) {
      setError(data.error ?? "Could not join room");
      return;
    }
    setIdentity(roomCode, { playerId: data.playerId, token: data.token, name: name.trim() });
  }

  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <div className="w-full max-w-sm flex flex-col gap-4">
        <h1 className="text-2xl font-bold text-center">Join room {roomCode}</h1>
        <input
          className="rounded-lg border px-4 py-3 text-lg dark:bg-zinc-900 dark:border-zinc-700"
          placeholder="Your name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={30}
        />
        {error && <p className="text-red-600 text-sm">{error}</p>}
        <button
          onClick={handleJoin}
          disabled={busy}
          className="rounded-full bg-black text-white py-3 font-medium disabled:opacity-50 dark:bg-white dark:text-black"
        >
          Join Room
        </button>
      </div>
    </div>
  );
}

function RulesPanel({
  roomCode,
  identity,
  room,
  isHost,
}: {
  roomCode: string;
  identity: Identity;
  room: Room;
  isHost: boolean;
}) {
  const [error, setError] = useState<string | null>(null);
  // Country-first scoring is meaningless on a one-country map (every guess
  // would score 5000), so those games always use distance scoring.
  const singleCountry = parseFilter(room.locationFilter)?.kind === "country";

  // Each control saves on change; the `rooms` row subscription then brings
  // every client (including this one) up to date.
  async function save(
    update: Partial<Pick<Room, "roundCount" | "roundTimeSeconds" | "isPrivate" | "locationFilter" | "scoringMode">>
  ) {
    setError(null);
    const res = await fetch(`/api/rooms/${roomCode}/rules`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ playerId: identity.playerId, token: identity.token, ...update }),
    });
    if (!res.ok) {
      const data = await res.json();
      setError(data.error ?? "Could not save rules");
    }
  }

  if (!isHost) {
    return (
      <div className="w-full max-w-md rounded-lg border p-4 flex flex-col gap-2 dark:border-zinc-700">
        <h2 className="font-semibold">Rules</h2>
        <p className="text-sm">
          Rounds: <strong>{room.roundCount}</strong>
        </p>
        <p className="text-sm">
          Time per round: <strong>{formatSeconds(room.roundTimeSeconds)}</strong>
        </p>
        <p className="text-sm">
          Locations: <strong>{filterLabel(room.locationFilter)}</strong>
        </p>
        <p className="text-sm">
          Scoring: <strong>{SCORING_MODE_LABELS[singleCountry ? "distance" : room.scoringMode]}</strong>
        </p>
      </div>
    );
  }

  const selectClass = "rounded border px-2 py-2 dark:bg-zinc-900 dark:border-zinc-700 disabled:opacity-50";
  return (
    <div className="w-full max-w-md rounded-lg border p-4 flex flex-col gap-3 dark:border-zinc-700">
      <h2 className="font-semibold">Rules (host only)</h2>
      <label className="text-sm flex flex-col gap-1">
        Locations
        <select
          value={room.locationFilter ?? ""}
          onChange={(e) => save({ locationFilter: e.target.value || null })}
          className={selectClass}
        >
          <option value="">World</option>
          <optgroup label="Continents">
            {Object.entries(CONTINENTS).map(([name, region]) => (
              <option key={name} value={`continent:${name}`}>
                {name} ({region.count.toLocaleString()})
              </option>
            ))}
          </optgroup>
          {COUNTRY_GROUPS.map(([continent, countries]) => (
            <optgroup key={continent} label={continent}>
              {countries.map(([code, country]) => (
                <option key={code} value={`country:${code}`}>
                  {country.name} ({country.count})
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>
      <label className="text-sm flex flex-col gap-1">
        Scoring
        <select
          value={singleCountry ? "distance" : room.scoringMode}
          onChange={(e) => save({ scoringMode: e.target.value as ScoringMode })}
          disabled={singleCountry}
          className={selectClass}
        >
          {(Object.keys(SCORING_MODE_LABELS) as ScoringMode[]).map((mode) => (
            <option key={mode} value={mode}>
              {SCORING_MODE_LABELS[mode]}
            </option>
          ))}
        </select>
        <span className="text-xs text-zinc-500">
          {singleCountry
            ? "Single-country maps always use distance scoring."
            : room.scoringMode === "country"
              ? "Any guess in the right country scores 5,000. Otherwise, scored by distance to that country."
              : "Scored by distance to the exact spot."}
        </span>
      </label>
      <label className="text-sm flex flex-col gap-1">
        Rounds
        <select
          value={room.roundCount}
          onChange={(e) => save({ roundCount: Number(e.target.value) })}
          className={selectClass}
        >
          {Array.from({ length: MAX_ROUNDS }, (_, i) => i + 1).map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </label>
      <label className="text-sm flex flex-col gap-1">
        Time per round
        <select
          value={room.roundTimeSeconds}
          onChange={(e) => save({ roundTimeSeconds: Number(e.target.value) })}
          className={selectClass}
        >
          {ROUND_TIME_OPTIONS.map((seconds) => (
            <option key={seconds} value={seconds}>
              {formatSeconds(seconds)}
            </option>
          ))}
        </select>
      </label>
      <label className="text-sm flex items-center gap-2">
        <input type="checkbox" checked={room.isPrivate} onChange={(e) => save({ isPrivate: e.target.checked })} />
        Private (hide from the open-room list)
      </label>
      {error && <p className="text-red-600 text-sm">{error}</p>}
    </div>
  );
}

function StartGameButton({ roomCode, identity }: { roomCode: string; identity: Identity }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleStart() {
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/rooms/${roomCode}/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ playerId: identity.playerId, token: identity.token }),
    });
    const data = await res.json();
    setBusy(false);
    if (!res.ok) setError(data.error ?? "Could not start game");
  }

  return (
    <div className="flex flex-col items-center gap-2">
      {error && <p className="text-red-600 text-sm">{error}</p>}
      <button
        onClick={handleStart}
        disabled={busy}
        className="rounded-full bg-black text-white px-8 py-3 font-medium disabled:opacity-50 dark:bg-white dark:text-black"
      >
        Start Game
      </button>
    </div>
  );
}
