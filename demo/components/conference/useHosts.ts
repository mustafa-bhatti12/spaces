'use client';

import { useLocalParticipant, useRoomInfo } from '@livekit/components-react';
import { useCallback, useMemo } from 'react';

/** token-service's RoomSettings, kept in the room's metadata; every client hears it change. */
export interface RoomSettings {
  hosts: string[];
  waitingRoom: boolean;
}

export function parseRoomSettings(metadata: string | undefined): RoomSettings {
  try {
    const m = JSON.parse(metadata || '{}');
    return {
      hosts: Array.isArray(m.hosts) ? m.hosts.filter((h: unknown): h is string => typeof h === 'string') : [],
      waitingRoom: m.waitingRoom === true,
    };
  } catch {
    return { hosts: [], waitingRoom: false };
  }
}

export function useRoomSettings(): RoomSettings {
  const { metadata } = useRoomInfo();
  return useMemo(() => parseRoomSettings(metadata), [metadata]);
}

export interface Hosting {
  hosts: string[];
  /** This participant hosts the room right now (it can change mid-call). */
  isHost: boolean;
  /** Host only: make someone in the call a host, or stop them hosting. Throws with the server's message. */
  setHost: (identity: string, host: boolean) => Promise<void>;
}

/**
 * Who hosts, from the room's metadata. The join token proves who we are to token-service, which
 * checks the same hosts list, so a participant made host mid-call gets host powers with no new token.
 */
export function useHosts(roomName: string, joinToken: string): Hosting {
  const { hosts } = useRoomSettings();
  const { localParticipant } = useLocalParticipant();
  const setHost = useCallback(
    async (identity: string, host: boolean) => {
      const res = await fetch('/api/rooms/host', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ room: roomName, token: joinToken, identity, host }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Could not change who hosts (HTTP ${res.status}).`);
      }
    },
    [roomName, joinToken],
  );
  return { hosts, isHost: hosts.includes(localParticipant.identity), setHost };
}
