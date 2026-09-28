'use client';

import type { LocalUserChoices } from '@livekit/components-react';
import { PreJoin } from './PreJoin';
import type { LucideIcon } from 'lucide-react';
import { ArrowLeft, CircleSlash, DoorClosed, Hourglass, LogOut, RefreshCw, UserX, WifiOff } from 'lucide-react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { getDeviceId } from '@/lib/client/identity';
import type { CallSummary, ConnectionDetails, LeaveReason } from './conference/types';
import type { Signal } from './ui/Device';
import { Led, Readout, ReadoutSegment, Wordmark } from './ui/Device';
import { SwitchRow } from './ui/SwitchRow';
import type { WaitingAnswer } from './WaitingScreen';
import { WaitingScreen } from './WaitingScreen';

// livekit-client + track processors touch browser-only APIs at construction time.
const Conference = dynamic(() => import('./conference/Conference').then((m) => m.Conference), { ssr: false });

type Stage =
  | { kind: 'prejoin'; error?: string }
  | { kind: 'joining' }
  | { kind: 'waiting'; requestId: string; choices: LocalUserChoices; identity: string }
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
  denied: {
    title: "You can't join this call",
    body: 'Someone in the call declined your request to join.',
    icon: UserX,
    signal: 'alert',
  },
  'no-response': {
    title: 'No one let you in',
    body: 'Nobody answered your request to join within 10 minutes. You can ask again.',
    icon: Hourglass,
    signal: 'warn',
  },
};

interface RoomStatus {
  numParticipants: number;
  /** This browser would host the room if it joined now (see /api/connect's rule). */
  youHost: boolean;
  waitingRoom: boolean;
}

/** Who is in this room and whether we'd host it, for the pre-join status screen and host switch. */
function useRoomStatus(roomName: string, enabled: boolean): RoomStatus | null {
  const [status, setStatus] = useState<RoomStatus | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const load = async () => {
      try {
        const q = `room=${encodeURIComponent(roomName)}&identity=${encodeURIComponent(getDeviceId())}`;
        const res = await fetch(`/api/rooms/status?${q}`, { cache: 'no-store' });
        if (!res.ok) return;
        const next: RoomStatus = await res.json();
        if (!cancelled) setStatus(next);
      } catch {
        // status is a nicety; the join works without it
      }
    };
    load();
    const timer = setInterval(load, 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [roomName, enabled]);
  return status;
}

function occupancyText(count: number | null): string {
  if (count === null) return 'Checking the room…';
  if (count === 0) return 'Nobody here yet';
  return `${count} ${count === 1 ? 'person' : 'people'} in the call`;
}

function durationText(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return 'Under a minute';
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

function SummaryReadout({ summary }: { summary: CallSummary }) {
  return (
    <Readout className="end-summary">
      <ReadoutSegment>
        Duration <strong className="mono">{durationText(summary.durationMs)}</strong>
      </ReadoutSegment>
      <ReadoutSegment>
        <strong className="mono">{summary.people}</strong> {summary.people === 1 ? 'person' : 'people'}
      </ReadoutSegment>
    </Readout>
  );
}

export function RoomClient({ roomName }: { roomName: string }) {
  const [stage, setStage] = useState<Stage>({ kind: 'prejoin' });
  const status = useRoomStatus(roomName, stage.kind === 'prejoin' || stage.kind === 'joining' || stage.kind === 'ended');
  // The host's pre-join choice; until they touch the switch it follows the room's current setting.
  const [waitingRoomChoice, setWaitingRoomChoice] = useState<boolean | null>(null);
  const waitingRoom = waitingRoomChoice ?? status?.waitingRoom ?? false;
  // The choices of the last join attempt, to ask again if token-service lost the request.
  const lastChoices = useRef<LocalUserChoices | null>(null);

  const join = useCallback(
    async (choices: LocalUserChoices, waitingRoomSetting?: boolean) => {
      lastChoices.current = choices;
      setStage({ kind: 'joining' });
      const identity = getDeviceId();
      try {
        const res = await fetch('/api/connect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ room: roomName, name: choices.username, identity, waitingRoom: waitingRoomSetting }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `Could not join (HTTP ${res.status}).`);
        if (data.waiting) setStage({ kind: 'waiting', requestId: data.requestId, choices, identity });
        else setStage({ kind: 'in-call', details: data as ConnectionDetails, choices, identity });
      } catch (err) {
        setStage({ kind: 'prejoin', error: (err as Error).message });
      }
    },
    [roomName],
  );
  // Only a would-be host sends the switch; the server ignores it from anyone else anyway.
  const handleSubmit = (choices: LocalUserChoices) => join(choices, status?.youHost ? waitingRoom : undefined);

  // Stable identity: Conference must not see a new onLeave each render (it's an effect dependency).
  const handleLeave = useCallback((reason: LeaveReason) => setStage({ kind: 'ended', reason }), []);
  // Same for PreJoin: onError is a dependency of its preview-track effect, so a new function per
  // render stops the camera and reopens it on every re-render (name load, occupancy polls).
  const handlePreviewError = useCallback((err: Error) => setStage({ kind: 'prejoin', error: err.message }), []);
  // WaitingScreen's poll depends on these, so they're stable too.
  const handleAdmitted = useCallback(
    (details: ConnectionDetails) =>
      setStage((s) => (s.kind === 'waiting' ? { kind: 'in-call', details, choices: s.choices, identity: s.identity } : s)),
    [],
  );
  const handleAnswer = useCallback(
    (answer: WaitingAnswer) => {
      if (answer === 'ask-again') {
        if (lastChoices.current) void join(lastChoices.current);
        return;
      }
      setStage({ kind: 'ended', reason: { kind: answer } });
    },
    [join],
  );
  const cancelWaiting = useCallback(() => setStage({ kind: 'prejoin' }), []);

  if (stage.kind === 'waiting') {
    return (
      <main className="end-screen">
        <header className="page-top">
          <Wordmark />
        </header>
        <WaitingScreen
          roomName={roomName}
          requestId={stage.requestId}
          onAdmitted={handleAdmitted}
          onAnswer={handleAnswer}
          onCancel={cancelWaiting}
        />
      </main>
    );
  }

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
          {stage.reason.summary && <SummaryReadout summary={stage.reason.summary} />}
          <div className="end-actions">
            <button type="button" className="key key-go" onClick={() => setStage({ kind: 'prejoin' })}>
              {stage.reason.kind === 'denied' || stage.reason.kind === 'no-response' ? 'Ask again' : 'Rejoin'}{' '}
              <span className="mono">{roomName}</span>
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
              <Led signal={status?.numParticipants ? 'live' : 'idle'} />
              {occupancyText(status?.numParticipants ?? null)}
            </ReadoutSegment>
          </Readout>
          <p className="lede">Check your camera and mic, then enter the name others will see.</p>
        </div>
        <PreJoin
          defaults={{}}
          joinLabel={stage.kind === 'joining' ? 'Joining…' : 'Join call'}
          userLabel="Enter your name (e.g. Alex)"
          onValidate={(values) => values.username.trim().length > 0 && stage.kind !== 'joining'}
          onSubmit={handleSubmit}
          onError={handlePreviewError}
          beforeJoin={
            status?.youHost && (
              <SwitchRow
                label="Waiting room"
                hint="People ask to join, and you let them in"
                checked={waitingRoom}
                onChange={setWaitingRoomChoice}
              />
            )
          }
        />
        <p className="prejoin-hint">Others in the room will see this name on your video tile.</p>
        <p className="prejoin-error note note-alert" role="alert" hidden={!error}>
          {error}
        </p>
      </div>
    </main>
  );
}
