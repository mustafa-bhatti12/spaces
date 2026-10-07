'use client';

import { ArrowRight, Dices } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { normalizeRoomName } from '@/lib/room';
import { Wordmark } from './ui/Device';

const ADJECTIVES = ['bright', 'calm', 'swift', 'bold', 'quiet', 'sunny', 'clever', 'brave'];
const NOUNS = ['falcon', 'river', 'maple', 'harbor', 'comet', 'meadow', 'summit', 'lantern'];

function randomRoomName(): string {
  const pick = (list: string[]) => list[Math.floor(Math.random() * list.length)];
  return `${pick(ADJECTIVES)}-${pick(NOUNS)}-${Math.floor(100 + Math.random() * 900)}`;
}

export function Lobby() {
  const router = useRouter();
  const [room, setRoom] = useState('');
  const join = (name: string) => {
    const normalized = normalizeRoomName(name);
    if (normalized) router.push(`/rooms/${normalized}`);
  };
  const typed = normalizeRoomName(room);

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
    </main>
  );
}
