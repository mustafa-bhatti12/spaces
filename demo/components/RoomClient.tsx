'use client';

import type { LocalUserChoices } from '@livekit/components-react';
import { PreJoin } from '@livekit/components-react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useCallback, useState } from 'react';
import { getDeviceId } from '@/lib/client/identity';
import type { ConnectionDetails, LeaveReason } from './conference/types';

// livekit-client + track processors touch browser-only APIs at construction time.
const Conference = dynamic(() => import('./conference/Conference').then((m) => m.Conference), { ssr: false });

type Stage =
  | { kind: 'prejoin'; error?: string }
  | { kind: 'joining' }
  | { kind: 'in-call'; details: ConnectionDetails; choices: LocalUserChoices; identity: string }
  | { kind: 'ended'; reason: LeaveReason };

const END_MESSAGES: Record<LeaveReason['kind'], string> = {
  left: 'You left the call.',
  duplicate: 'You joined this room from another tab or window in this browser, so this one was disconnected.',
  removed: 'You were removed from the call by the host.',
  'room-closed': 'The room was closed.',
  error: 'The call was disconnected.',
};

export function RoomClient({ roomName }: { roomName: string }) {
  const [stage, setStage] = useState<Stage>({ kind: 'prejoin' });

  const handleSubmit = useCallback(
    async (choices: LocalUserChoices) => {
      setStage({ kind: 'joining' });
      const identity = getDeviceId();
      try {
        const res = await fetch('/api/connect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ room: roomName, name: choices.username, identity }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `Could not join (HTTP ${res.status}).`);
        setStage({ kind: 'in-call', details: data as ConnectionDetails, choices, identity });
      } catch (err) {
        setStage({ kind: 'prejoin', error: (err as Error).message });
      }
    },
    [roomName],
  );

  // Stable identity: Conference must not see a new onLeave each render (it's an effect dependency).
  const handleLeave = useCallback((reason: LeaveReason) => setStage({ kind: 'ended', reason }), []);

  if (stage.kind === 'in-call') {
    return (
      <Conference
        roomName={roomName}
        details={stage.details}
        choices={stage.choices}
        identity={stage.identity}
        onLeave={handleLeave}
      />
    );
  }

  if (stage.kind === 'ended') {
    return (
      <main className="end-screen">
        <div className="card">
          <h1>{END_MESSAGES[stage.reason.kind]}</h1>
          {stage.reason.message && <p className="muted">{stage.reason.message}</p>}
          <div className="lobby-row">
            <button type="button" className="lk-button lk-join-button" onClick={() => setStage({ kind: 'prejoin' })}>
              Rejoin {roomName}
            </button>
            <Link className="lk-button" href="/">
              Back to lobby
            </Link>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="prejoin-page">
      <div className="prejoin-wrap">
        <h1>Join {roomName}</h1>
        <PreJoin
          persistUserChoices
          joinLabel={stage.kind === 'joining' ? 'Joining…' : 'Join room'}
          userLabel="Your name"
          onValidate={(values) => values.username.trim().length > 0 && stage.kind !== 'joining'}
          onSubmit={handleSubmit}
          onError={(err) => setStage({ kind: 'prejoin', error: err.message })}
        />
        <div className="error-text" role="alert">{stage.kind === 'prejoin' ? stage.error : ''}</div>
        <Link href="/" className="muted" style={{ textAlign: 'center' }}>
          ← Back to lobby
        </Link>
      </div>
    </main>
  );
}
