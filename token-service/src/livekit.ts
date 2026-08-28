import { AccessToken } from 'livekit-server-sdk';

export interface CallConnectionDetails {
  serverUrl: string;
  roomName: string;
  participantName: string;
  participantToken: string;
}

/**
 * Mints a LiveKit join token. Deliberately knows nothing about any consuming app's users, cases,
 * or authorization rules — the caller (e.g. Petition Studio's calls module) decides who is allowed
 * to join which room and what their identity/display name is; this only turns that decision into a
 * signed token. Keeping this generic is what lets a second consumer reuse the same service later.
 */
export async function mintToken(params: {
  room: string;
  identity: string;
  name: string;
}): Promise<CallConnectionDetails> {
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  const serverUrl = process.env.LIVEKIT_URL;
  if (!apiKey || !apiSecret || !serverUrl) {
    throw new Error('LIVEKIT_API_KEY, LIVEKIT_API_SECRET and LIVEKIT_URL must be set.');
  }

  const at = new AccessToken(apiKey, apiSecret, {
    identity: params.identity,
    name: params.name,
  });
  at.ttl = '2h';
  at.addGrant({
    room: params.room,
    roomJoin: true,
    canPublish: true,
    canPublishData: true,
    canSubscribe: true,
  });

  return {
    serverUrl,
    roomName: params.room,
    participantName: params.name,
    participantToken: await at.toJwt(),
  };
}
