'use client';

import { useDataChannel } from '@livekit/components-react';
import { useCallback, useEffect, useState } from 'react';
import { useRoomSettings } from './useHosts';

/** token-service's lobbyRoutes LOBBY_TOPIC: someone asked, gave up, or was answered. */
const LOBBY_TOPIC = 'space.lobby';
/** Backstop in case a notification is missed; the data message is what normally triggers a refresh. */
const REFRESH_MS = 15_000;

export interface WaitingPerson {
  id: string;
  identity: string;
  name: string;
  askedAt: string;
}

export interface WaitingRoomControls {
  enabled: boolean;
  pending: WaitingPerson[];
  setEnabled: (enabled: boolean) => Promise<void>;
  answer: (ids: string[] | 'all', admit: boolean) => Promise<void>;
}

async function post(action: string, body: object): Promise<Response> {
  const res = await fetch(`/api/lobby/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Waiting room: HTTP ${res.status}`);
  }
  return res;
}

/**
 * The waiting room as the host sees it. On/off is room metadata (every client hears changes); the
 * list of people asking comes from token-service, refetched when it signals a change. Null for
 * anyone who isn't a host: only a host's token can list or answer.
 */
export function useWaitingRoom(roomName: string, hostToken: string | undefined): WaitingRoomControls | null {
  const enabled = useRoomSettings().waitingRoom;
  const [pending, setPending] = useState<WaitingPerson[]>([]);

  const refresh = useCallback(async () => {
    if (!hostToken) return;
    try {
      const res = await post('pending', { room: roomName, token: hostToken });
      setPending(await res.json());
    } catch {
      // keep the last list; the next signal or refresh retries
    }
  }, [roomName, hostToken]);

  useDataChannel(LOBBY_TOPIC, () => void refresh());

  useEffect(() => {
    if (!hostToken) return;
    void refresh();
    const timer = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(timer);
  }, [hostToken, refresh]);

  const setEnabled = useCallback(
    async (next: boolean) => {
      await post('settings', { room: roomName, token: hostToken, waitingRoom: next });
      await refresh();
    },
    [roomName, hostToken, refresh],
  );

  const answer = useCallback(
    async (ids: string[] | 'all', admit: boolean) => {
      // Drop them from the list right away; the refresh confirms.
      setPending((list) => (ids === 'all' ? [] : list.filter((p) => !ids.includes(p.id))));
      await post('answer', { room: roomName, token: hostToken, ids, admit });
      await refresh();
    },
    [roomName, hostToken, refresh],
  );

  if (!hostToken) return null;
  return { enabled, pending, setEnabled, answer };
}
