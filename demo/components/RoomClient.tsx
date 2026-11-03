'use client';

import type { LocalUserChoices } from '@livekit/components-react';
import { PreJoin } from './PreJoin';
import type { LucideIcon } from 'lucide-react';
import { ArrowLeft, CalendarClock, CircleSlash, DoorClosed, Hourglass, LinkIcon, LogOut, RefreshCw, UserX, WifiOff } from 'lucide-react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { takeFragmentToken } from '@/lib/client/fragmentToken';
import { getDeviceId } from '@/lib/client/identity';
import { previewErrorMessage } from '@/lib/client/prejoinGuidance';
import type { CallSummary, ConnectionDetails, LeaveReason } from './conference/types';
import type { Signal } from './ui/Device';
import { Led, Readout, ReadoutSegment, Wordmark } from './ui/Device';
import { SwitchRow } from './ui/SwitchRow';
import type { WaitingAnswer } from './WaitingScreen';
import { WaitingScreen } from './WaitingScreen';

// livekit-client + track processors touch browser-only APIs at construction time.
const Conference = dynamic(() => import('./conference/Conference').then((m) => m.Conference), { ssr: false });

type Stage =
  | { kind: 'checking' }
  /** Reserved room, before guests may join (15 min before it starts). */
  | { kind: 'early'; startsAt: string }
  /** The room can't be joined: its link is inactive, or the host link is invalid. */
  | { kind: 'blocked'; title: string; body: string }
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
    body: "A host removed you. You can't rejoin this call.",
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

const INACTIVE = {
  title: 'This meeting link is no longer active',
  body: 'Ask the person who invited you for a new link.',
};
const BAD_HOST_LINK = { title: 'This host link has expired', body: 'Open the meeting again from where you started it to get a fresh link.' };

/** A host's pre-minted token, checked by token-service (the same verification /embed uses). */
interface HostSession {
  room: string;
  identity: string;
  name: string;
  serverUrl: string;
  token: string;
  callSettings?: ConnectionDetails['callSettings'];
}

const EARLY_RECHECK_MS = 30_000;

/** The reservation window for this room, or null when it's unreserved/open (or the check failed: the join itself re-checks). */
async function checkWindow(roomName: string, signal?: AbortSignal): Promise<Stage | null> {
  try {
    const res = await fetch(`/api/rooms/reservation?room=${encodeURIComponent(roomName)}`, { cache: 'no-store', signal });
    if (!res.ok) return null;
    const r = await res.json();
    if (!r.reserved || r.state === 'open') return null;
    if (r.state === 'early') return { kind: 'early', startsAt: r.startsAt };
    return { kind: 'blocked', ...INACTIVE };
  } catch {
    return null;
  }
}

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

function formatStart(iso: string): string {
  return new Date(iso).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
}

/** The session behind a host token (room, who it's for), or why it can't be used. */
async function verifyHostToken(token: string, roomName: string, signal?: AbortSignal): Promise<HostSession | 'invalid' | 'inactive'> {
  const res = await fetch('/api/embed/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
    signal,
  });
  if (res.status === 410) return 'inactive';
  const data = await res.json().catch(() => ({}));
  if (res.status === 404 && data.code === 'room_not_reserved') return 'inactive';
  if (!res.ok || data.room !== roomName) return 'invalid';
  return { ...data, token };
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
  const [stage, setStage] = useState<Stage>({ kind: 'checking' });
  // Set when the page was opened with a host's pre-minted token (`#t=...`).
  const [hostSession, setHostSession] = useState<HostSession | null>(null);
  const status = useRoomStatus(roomName, stage.kind === 'prejoin' || stage.kind === 'joining' || stage.kind === 'ended');
  // The host's pre-join choice; until they touch the switch it follows the room's current setting.
  const [waitingRoomChoice, setWaitingRoomChoice] = useState<boolean | null>(null);
  const waitingRoom = waitingRoomChoice ?? status?.waitingRoom ?? false;
  // The choices of the last join attempt, to ask again if token-service lost the request.
  const lastChoices = useRef<LocalUserChoices | null>(null);

  // First look at the page: a host token in the fragment (stripped from the URL at once), else the
  // reservation's guest window. Unreserved rooms go straight to the pre-join as they always did.
  useEffect(() => {
    const ctrl = new AbortController();
    const token = takeFragmentToken();
    (async () => {
      if (token) {
        const session = await verifyHostToken(token, roomName, ctrl.signal);
        if (ctrl.signal.aborted) return;
        if (session === 'invalid') return setStage({ kind: 'blocked', ...BAD_HOST_LINK });
        if (session === 'inactive') return setStage({ kind: 'blocked', ...INACTIVE });
        setHostSession(session);
        return setStage({ kind: 'prejoin' });
      }
      const blocked = await checkWindow(roomName, ctrl.signal);
      if (!ctrl.signal.aborted) setStage(blocked ?? { kind: 'prejoin' });
    })().catch(() => {
      if (ctrl.signal.aborted) return;
      // A host link that can't be checked must not fall back to joining as a guest.
      setStage(token ? { kind: 'blocked', title: "Couldn't open the meeting", body: 'Check your connection, then open the meeting again from where you started it.' } : { kind: 'prejoin' });
    });
    return () => ctrl.abort();
  }, [roomName]);

  // Waiting for the window to open: look again until it does.
  useEffect(() => {
    if (stage.kind !== 'early') return;
    const timer = setInterval(async () => {
      const next = await checkWindow(roomName);
      if (next?.kind !== 'early') setStage(next ?? { kind: 'prejoin' });
    }, EARLY_RECHECK_MS);
    return () => clearInterval(timer);
  }, [stage.kind, roomName]);

  const join = useCallback(
    async (choices: LocalUserChoices, waitingRoomSetting?: boolean) => {
      lastChoices.current = choices;
      setStage({ kind: 'joining' });
      const identity = getDeviceId();
      try {
        if (hostSession) {
          // Check the token again: a room ended since, or a token that timed out, must not rejoin.
          const session = await verifyHostToken(hostSession.token, roomName);
          if (session === 'invalid') return setStage({ kind: 'blocked', ...BAD_HOST_LINK });
          if (session === 'inactive') return setStage({ kind: 'blocked', ...INACTIVE });
          const details: ConnectionDetails = { serverUrl: session.serverUrl, roomName: session.room, participantName: session.name, participantToken: session.token, callSettings: session.callSettings };
          return setStage({ kind: 'in-call', details, choices, identity: session.identity });
        }
        const res = await fetch('/api/connect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ room: roomName, name: choices.username, identity, waitingRoom: waitingRoomSetting }),
        });
        const data = await res.json().catch(() => ({}));
        if (data.reservation === 'early') return setStage({ kind: 'early', startsAt: data.startsAt });
        if (data.reservation === 'expired' || (res.status === 404 && data.code === 'room_not_reserved')) return setStage({ kind: 'blocked', ...INACTIVE });
        if (!res.ok) throw new Error(data.error || `Could not join (HTTP ${res.status}).`);
        if (data.waiting) setStage({ kind: 'waiting', requestId: data.requestId, choices, identity });
        else setStage({ kind: 'in-call', details: data as ConnectionDetails, choices, identity });
      } catch (err) {
        setStage({ kind: 'prejoin', error: (err as Error).message });
      }
    },
    [roomName, hostSession],
  );
  // Only a would-be host sends the switch; the server ignores it from anyone else anyway.
  const handleSubmit = (choices: LocalUserChoices) => join(choices, status?.youHost ? waitingRoom : undefined);

  // Stable identity: Conference must not see a new onLeave each render (it's an effect dependency).
  const handleLeave = useCallback((reason: LeaveReason) => setStage({ kind: 'ended', reason }), []);
  // Same for PreJoin: onError is a dependency of its preview-track effect, so a new function per
  // render stops the camera and reopens it on every re-render (name load, occupancy polls).
  const handlePreviewError = useCallback((err: Error) => setStage({ kind: 'prejoin', error: previewErrorMessage(err, navigator.userAgent, navigator.maxTouchPoints) }), []);
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

  if (stage.kind === 'checking' || stage.kind === 'early' || stage.kind === 'blocked') {
    const early = stage.kind === 'early';
    const Icon = early ? CalendarClock : LinkIcon;
    return (
      <main className="end-screen">
        <header className="page-top">
          <Wordmark />
        </header>
        <section className="face end-face" aria-labelledby="end-title">
          {stage.kind !== 'checking' && (
            <span className={`end-icon end-icon-${early ? 'idle' : 'warn'}`} aria-hidden="true">
              <Icon />
            </span>
          )}
          <h1 id="end-title" className="title">
            {early ? `This meeting starts at ${formatStart(stage.startsAt)}` : stage.kind === 'blocked' ? stage.title : 'Opening the room…'}
          </h1>
          {early && <p className="lede">You can join 15 minutes before it starts. This page checks again by itself.</p>}
          {stage.kind === 'blocked' && <p className="lede">{stage.body}</p>}
        </section>
      </main>
    );
  }

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
          <p className="lede">
            {hostSession ? `You're joining as host, as ${hostSession.name}. Check your camera and mic.` : 'Check your camera and mic, then enter the name others will see.'}
          </p>
        </div>
        <PreJoin
          defaults={{}}
          joinLabel={stage.kind === 'joining' ? 'Joining…' : hostSession ? 'Join as host' : 'Join call'}
          lockedName={hostSession?.name}
          userLabel="Enter your name (e.g. Alex)"
          busy={stage.kind === 'joining'}
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
