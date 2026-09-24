'use client';

import { useDataChannel } from '@livekit/components-react';
import { useCallback, useEffect, useState } from 'react';

export interface ActiveRecording {
  egressId: string;
  roomName: string;
  startedAt: string;
  startedBy?: string;
}

const POLL_EVERY_MS = 5000;
const TOPIC = 'recording-changed';

/**
 * Recording state for the room. token-service is the source of truth (polled), and whoever starts or
 * stops a recording also broadcasts on a data topic so everyone else refreshes immediately instead
 * of waiting for the next poll.
 */
export function useRecording(roomName: string, localName: string) {
  const [recording, setRecording] = useState<ActiveRecording | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/recording/status?room=${encodeURIComponent(roomName)}`, { cache: 'no-store' });
      if (!res.ok) return;
      const active: ActiveRecording[] = await res.json();
      setRecording(active[0] ?? null);
    } catch {
      // transient: next poll retries
    }
  }, [roomName]);

  const { send } = useDataChannel(TOPIC, () => void refresh());

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, POLL_EVERY_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const run = useCallback(
    async (path: string, body: Record<string, string>) => {
      setBusy(true);
      setError('');
      try {
        const res = await fetch(path, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || data.message || `HTTP ${res.status}`);
        await send(new TextEncoder().encode('1'), { reliable: true });
        await refresh();
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [refresh, send],
  );

  const start = useCallback(() => run('/api/recording/start', { room: roomName, startedBy: localName }), [run, roomName, localName]);
  const stop = useCallback(() => (recording ? run('/api/recording/stop', { egressId: recording.egressId }) : Promise.resolve()), [run, recording]);

  const clearError = useCallback(() => setError(''), []);

  return { recording, busy, error, clearError, start, stop };
}
