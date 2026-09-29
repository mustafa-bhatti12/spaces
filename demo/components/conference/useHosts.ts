'use client';

import { useLocalParticipant, useRoomInfo } from '@livekit/components-react';
import { useCallback, useMemo } from 'react';

/** token-service's RoomSettings, kept in the room's metadata; every client hears it change. */
export interface RoomSettings {
  hosts: string[];
  waitingRoom: boolean;
  /** Pinned for everyone by a host; null when nobody is. */
  spotlight: string | null;
}

export function parseRoomSettings(metadata: string | undefined): RoomSettings {
  try {
    const m = JSON.parse(metadata || '{}');
    return {
      hosts: Array.isArray(m.hosts) ? m.hosts.filter((h: unknown): h is string => typeof h === 'string') : [],
      waitingRoom: m.waitingRoom === true,
      spotlight: typeof m.spotlight === 'string' && m.spotlight ? m.spotlight : null,
    };
  } catch {
    return { hosts: [], waitingRoom: false, spotlight: null };
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
  /** Who a host pinned for everyone, or null. */
  spotlight: string | null;
  /** Host only: make someone in the call a host, or stop them hosting. Throws with the server's message. */
  setHost: (identity: string, host: boolean) => Promise<void>;
  /** Host only: pin someone for everyone (null unpins). Throws with the server's message. */
  setSpotlight: (identity: string | null) => Promise<void>;
  /** Host only: mute someone's mic (they can unmute themselves). Throws with the server's message. */
  mute: (identity: string) => Promise<void>;
  /** Host only: remove someone; they can't rejoin until the call ends. Throws with the server's message. */
  remove: (identity: string) => Promise<void>;
}

/**
 * Who hosts, from the room's metadata. The join token proves who we are to token-service, which
 * checks the same hosts list, so a participant made host mid-call gets host powers with no new token.
 */
export function useHosts(roomName: string, joinToken: string): Hosting {
  const { hosts, spotlight } = useRoomSettings();
  const { localParticipant } = useLocalParticipant();
  const post = useCallback(
    async (path: string, body: object, failure: string) => {
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ room: roomName, token: joinToken, ...body }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `${failure} (HTTP ${res.status}).`);
      }
    },
    [roomName, joinToken],
  );
  return useMemo(
    () => ({
      hosts,
      isHost: hosts.includes(localParticipant.identity),
      spotlight,
      setHost: (identity, host) => post('/api/rooms/host', { identity, host }, 'Could not change who hosts'),
      setSpotlight: (identity) => post('/api/moderate/spotlight', { identity }, 'Could not pin'),
      mute: (identity) => post('/api/moderate/mute', { identity }, 'Could not mute'),
      remove: (identity) => post('/api/moderate/remove', { identity }, 'Could not remove'),
    }),
    [hosts, spotlight, localParticipant.identity, post],
  );
}
