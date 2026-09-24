'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { normalizeRoomName } from '@/lib/room';

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
        if (!cancelled) setRoomsError('Could not load active rooms.');
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

  return (
    <main className="lobby">
      <form
        className="lobby-card"
        onSubmit={(event) => {
          event.preventDefault();
          join(room || randomRoomName());
        }}
      >
        <h1>Space Meet</h1>
        <p>Start a new room or join one by name. Anyone with the room link can join.</p>
        <div className="lobby-row">
          <input
            className="lk-form-control"
            placeholder="Room name (leave empty for a new one)"
            value={room}
            onChange={(event) => setRoom(event.target.value)}
            aria-label="Room name"
            autoFocus
          />
          <button type="button" className="lk-button" onClick={() => setRoom(randomRoomName())} title="Random room name">
            🎲
          </button>
        </div>
        <button type="submit" className="lk-button lk-join-button">
          {room ? `Join ${normalizeRoomName(room) || 'room'}` : 'Start a new room'}
        </button>
        <section className="lobby-rooms">
          <h2>Active rooms</h2>
          {roomsError ? (
            <span className="error-text">{roomsError}</span>
          ) : rooms === null ? (
            <span className="muted">Loading…</span>
          ) : rooms.length === 0 ? (
            <span className="muted">No one is in a call right now.</span>
          ) : (
            <div className="lobby-room-list">
              {rooms.map((r) => (
                <button key={r.name} type="button" className="lk-button" onClick={() => join(r.name)}>
                  {r.name} · {r.numParticipants}
                </button>
              ))}
            </div>
          )}
        </section>
      </form>
    </main>
  );
}
