'use client';

import { useEffect, useState } from 'react';
import type { ActiveRecording } from './useRecording';

// token-service passes LiveKit's EgressInfo.startedAt through: nanoseconds since epoch, 0 until the
// egress is actually running.
function elapsed(startedAtNs: string): string {
  const startedAtMs = Number(startedAtNs) / 1e6;
  if (!startedAtMs) return 'starting…';
  const seconds = Math.max(0, Math.floor((Date.now() - startedAtMs) / 1000));
  const m = Math.floor(seconds / 60);
  const s = String(seconds % 60).padStart(2, '0');
  return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

interface TopBarProps {
  roomName: string;
  participantCount: number;
  recording: ActiveRecording | null;
  onInvite: () => void;
}

export function TopBar({ roomName, participantCount, recording, onInvite }: TopBarProps) {
  const [, tick] = useState(0);
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    if (!recording) return;
    const timer = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [recording]);

  useEffect(() => {
    const sync = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', sync);
    return () => document.removeEventListener('fullscreenchange', sync);
  }, []);

  return (
    <header className="conference-topbar">
      <span className="room-title">{roomName}</span>
      <span className="muted hide-mobile">
        {participantCount} {participantCount === 1 ? 'person' : 'people'}
      </span>
      {recording && (
        <span className="rec-badge" title={recording.startedBy ? `Started by ${recording.startedBy}` : undefined}>
          REC {elapsed(recording.startedAt)}
          <span className="hide-mobile">{recording.startedBy ? ` · ${recording.startedBy}` : ''}</span>
        </span>
      )}
      <span className="spacer" />
      <button type="button" className="lk-button" onClick={onInvite} title="Copy invite link">
        🔗 <span className="hide-mobile">Invite</span>
      </button>
      <button
        type="button"
        className="lk-button"
        onClick={() => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen())}
        title={fullscreen ? 'Exit full screen' : 'Full screen'}
        aria-pressed={fullscreen}
      >
        ⛶
      </button>
    </header>
  );
}
