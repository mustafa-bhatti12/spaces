'use client';

import type { LocalUserChoices } from '@livekit/components-react';
import { PreJoin } from './PreJoin';
import type { LucideIcon } from 'lucide-react';
import { ArrowLeft, CircleSlash, DoorClosed, LogOut, RefreshCw, UserX, WifiOff } from 'lucide-react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { getDeviceId, getSavedDisplayName, saveDisplayName } from '@/lib/client/identity';
import type { ConnectionDetails, LeaveReason } from './conference/types';
import type { Signal } from './ui/Device';
import { Led, Readout, ReadoutSegment, Wordmark } from './ui/Device';

// livekit-client + track processors touch browser-only APIs at construction time.
const Conference = dynamic(() => import('./conference/Conference').then((m) => m.Conference), { ssr: false });

type Stage =
  | { kind: 'prejoin'; error?: string }
  | { kind: 'joining' }
  | { kind: 'in-call'; details: ConnectionDetails; choices: LocalUserChoices; identity: string }
  | { kind: 'ended'; reason: LeaveReason };

const END_SCREENS: Record<LeaveReason['kind'], { title: string; body: string; icon: LucideIcon; signal: Signal }> = {
  left: { title: 'You left the call', body: 'Rejoin any time with the same link.', icon: LogOut, signal: 'idle' },
  ended: {
    title: 'You ended the call',
    body: 'Everyone was disconnected. Starting the room again makes a new call.',
    icon: CircleSlash,
    signal: 'idle',
  },
  duplicate: {
    title: 'Continued in another tab',
    body: 'You joined this room from another tab or window in this browser, so this one was disconnected.',
    icon: RefreshCw,
    signal: 'warn',
  },
  removed: {
    title: 'You were removed from the call',
    body: 'The host removed you. You can rejoin with the room link.',
    icon: UserX,
    signal: 'alert',
  },
  'room-closed': {
    title: 'The call has ended',
    body: 'The call was ended for everyone in the room.',
    icon: DoorClosed,
    signal: 'idle',
  },
  error: { title: 'The call was disconnected', body: 'Check your connection, then rejoin.', icon: WifiOff, signal: 'alert' },
};

/** How many people are already in this room, for the pre-join status screen. */
function useRoomOccupancy(roomName: string, enabled: boolean): number | null {
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch('/api/rooms', { cache: 'no-store' });
        if (!res.ok) return;
        const rooms: { name: string; numParticipants: number }[] = await res.json();
        if (!cancelled) setCount(rooms.find((r) => r.name === roomName)?.numParticipants ?? 0);
      } catch {
        // occupancy is a nicety; the join works without it
      }
    };
    load();
    const timer = setInterval(load, 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [roomName, enabled]);
  return count;
}

function occupancyText(count: number | null): string {
  if (count === null) return 'Checking the room…';
  if (count === 0) return 'Nobody here yet';
  return `${count} ${count === 1 ? 'person' : 'people'} in the call`;
}

export function RoomClient({ roomName }: { roomName: string }) {
  const [stage, setStage] = useState<Stage>({ kind: 'prejoin' });
  const [defaultName, setDefaultName] = useState('');
  const occupancy = useRoomOccupancy(roomName, stage.kind !== 'in-call');

  useEffect(() => {
    setDefaultName(getSavedDisplayName());
  }, []);

  const handleSubmit = useCallback(
    async (choices: LocalUserChoices) => {
      saveDisplayName(choices.username);
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
  // Same for PreJoin: onError is a dependency of its preview-track effect, so a new function per
  // render stops the camera and reopens it on every re-render (name load, occupancy polls).
  const handlePreviewError = useCallback((err: Error) => setStage({ kind: 'prejoin', error: err.message }), []);

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
    const screen = END_SCREENS[stage.reason.kind];
    const Icon = screen.icon;
    return (
      <main className="end-screen">
        <header className="page-top">
          <Wordmark />
        </header>
        <section className="face end-face" aria-labelledby="end-title">
          <span className={`end-icon end-icon-${screen.signal}`} aria-hidden="true">
            <Icon />
          </span>
          <h1 id="end-title" className="title">
            {screen.title}
          </h1>
          <p className="lede">{screen.body}</p>
          {stage.reason.message && <p className="note mono">{stage.reason.message}</p>}
          <div className="end-actions">
            <button type="button" className="key key-go" onClick={() => setStage({ kind: 'prejoin' })}>
              Rejoin <span className="mono">{roomName}</span>
            </button>
            <Link className="key" href="/">
              Back to lobby
            </Link>
          </div>
        </section>
      </main>
    );
  }

  const error = stage.kind === 'prejoin' ? stage.error : '';
  return (
    <main className="prejoin-page">
      <header className="page-top">
        <Link href="/" className="back-link">
          <ArrowLeft aria-hidden="true" />
          Lobby
        </Link>
        <Wordmark />
      </header>
      <div className="prejoin-grid">
        <div className="prejoin-head">
          <h1 className="title">Ready to join?</h1>
          <Readout live>
            <ReadoutSegment strong>
              <span className="mono">{roomName}</span>
            </ReadoutSegment>
            <ReadoutSegment>
              <Led signal={occupancy ? 'live' : 'idle'} />
              {occupancyText(occupancy)}
            </ReadoutSegment>
          </Readout>
          <p className="lede">Check your camera and mic, then enter the name others will see.</p>
        </div>
        <PreJoin
          defaults={{ username: defaultName }}
          joinLabel={stage.kind === 'joining' ? 'Joining…' : 'Join call'}
          userLabel="Enter your name (e.g. Alex)"
          onValidate={(values) => values.username.trim().length > 0 && stage.kind !== 'joining'}
          onSubmit={handleSubmit}
          onError={handlePreviewError}
        />
        <p className="prejoin-hint">Others in the room will see this name on your video tile.</p>
        <p className="prejoin-error note note-alert" role="alert" hidden={!error}>
          {error}
        </p>
      </div>
    </main>
  );
}
