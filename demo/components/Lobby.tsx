'use client';

import { ArrowRight, Dices, Users } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { normalizeRoomName } from '@/lib/room';
import { Led, Readout, ReadoutSegment, Wordmark } from './ui/Device';

interface ActiveRoom {
  name: string;
  numParticipants: number;
}

const ADJECTIVES = ['bright', 'calm', 'swift', 'bold', 'quiet', 'sunny', 'clever', 'brave'];
const NOUNS = ['falcon', 'river', 'maple', 'harbor', 'comet', 'meadow', 'summit', 'lantern'];

function randomRoomName(): string {
  const pick = (list: string[]) => list[Math.floor(Math.random() * list.length)];
  return `${pick(ADJECTIVES)}-${pick(NOUNS)}-${Math.floor(100 + Math.random() * 900)}`;
}

const people = (n: number) => `${n} ${n === 1 ? 'person' : 'people'}`;

export function Lobby() {
  const router = useRouter();
  const [room, setRoom] = useState('');
  const [rooms, setRooms] = useState<ActiveRoom[] | null>(null);
  const [roomsError, setRoomsError] = useState('');

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch('/api/rooms', { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data: ActiveRoom[] = await res.json();
        if (!cancelled) {
          setRooms(data);
          setRoomsError('');
        }
      } catch {
        if (!cancelled) setRoomsError('Could not load active rooms. Retrying every few seconds.');
      }
    };
    load();
    const timer = setInterval(load, 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const join = (name: string) => {
    const normalized = normalizeRoomName(name);
    if (normalized) router.push(`/rooms/${normalized}`);
  };
  const typed = normalizeRoomName(room);
  const liveCount = rooms?.length ?? 0;

  return (
    <main className="lobby">
      <header className="page-top">
        <Wordmark />
      </header>

      <section className="lobby-start" aria-labelledby="lobby-title">
        <h1 id="lobby-title" className="display">
          Start a call, or&nbsp;join&nbsp;one.
        </h1>
        <p className="lede">Pick a room name and share the link. Whoever opens it joins you, with no account needed.</p>

        <form
          className="face lobby-form"
          onSubmit={(event) => {
            event.preventDefault();
            join(room || randomRoomName());
          }}
        >
          <label className="field-label" htmlFor="room-name">
            Room name
          </label>
          <div className="field-row">
            <input
              id="room-name"
              className="field mono"
              placeholder="Leave empty for a new room"
              value={room}
              onChange={(event) => setRoom(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              autoFocus
            />
            <button
              type="button"
              className="key key-square"
              onClick={() => setRoom(randomRoomName())}
              aria-label="Suggest a room name"
              title="Suggest a room name"
            >
              <Dices aria-hidden="true" />
            </button>
          </div>
          <button type="submit" className="key key-go key-wide">
            {typed ? (
              <>
                Join <span className="mono">{typed}</span>
              </>
            ) : (
              'Start a new room'
            )}
            <ArrowRight aria-hidden="true" />
          </button>
        </form>
      </section>

      <section className="lobby-live" aria-labelledby="live-title">
        <Readout className="lobby-live-head" live>
          <ReadoutSegment strong>
            <Led signal={liveCount ? 'live' : 'idle'} pulse={liveCount > 0} />
            <span id="live-title">Live now</span>
          </ReadoutSegment>
          <ReadoutSegment>{rooms === null ? '…' : `${liveCount} ${liveCount === 1 ? 'room' : 'rooms'}`}</ReadoutSegment>
        </Readout>

        {roomsError ? (
          <p className="note note-alert" role="alert">
            {roomsError}
          </p>
        ) : rooms === null ? (
          <p className="note">Checking for live rooms…</p>
        ) : rooms.length === 0 ? (
          <p className="note">Nobody is in a call right now. Rooms show up here as soon as someone joins.</p>
        ) : (
          <ul className="room-list">
            {rooms.map((r) => (
              <li key={r.name}>
                <button type="button" className="room-row" onClick={() => join(r.name)}>
                  <span className="room-row-name mono">{r.name}</span>
                  <span className="room-row-count">
                    <Users aria-hidden="true" />
                    {people(r.numParticipants)}
                  </span>
                  <span className="room-row-go">
                    Join
                    <ArrowRight aria-hidden="true" />
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
