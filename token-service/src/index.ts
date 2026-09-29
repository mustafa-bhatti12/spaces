import 'dotenv/config';
import path from 'node:path';
import Fastify from 'fastify';
import { EgressStatus, WebhookReceiver } from 'livekit-server-sdk';
import {
  containerPathToHostPath,
  endRoomAsHost,
  getActiveRecordings,
  getParticipantSid,
  getRoomSettings,
  listActiveRooms,
  mintToken,
  recordRoomHost,
  setRoomHost,
  hostIdentity,
  startRoomAudioRecording,
  stopAllActiveRecordings,
  stopRecording,
} from './livekit';
import { requireSharedSecret } from './auth';
import { finishRecording, listRecordingFiles } from './recordings';
import { parseRecordingName, readTranscript, transcribeMissing, transcribeRecording, transcriptStates } from './transcripts';
import * as autoRecord from './autoRecord';
import { adminRoutes } from './admin';
import { lobby } from './lobby';
import { lobbyRoutes } from './lobbyRoutes';
import { embedRoutes } from './embedRoutes';

const fastify = Fastify();

fastify.get('/health', async () => ({ ok: true }));

fastify.get('/rooms', { preHandler: requireSharedSecret }, async (_req, reply) => {
  try {
    reply.send(await listActiveRooms());
  } catch (err) {
    console.error('Failed to list LiveKit rooms:', err);
    reply.code(500).send({ error: 'Could not list rooms.' });
  }
});

fastify.get<{ Querystring: { room?: string; identity?: string } }>(
  '/participant',
  { preHandler: requireSharedSecret },
  async (req, reply) => {
    const room = String(req.query.room ?? '');
    const identity = String(req.query.identity ?? '');
    if (!room || !identity) {
      reply.code(400).send({ error: 'room and identity query params are required.' });
      return;
    }
    try {
      reply.send({ sid: await getParticipantSid(room, identity) });
    } catch (err) {
      console.error('Failed to look up LiveKit participant:', err);
      reply.code(500).send({ error: 'Could not look up participant.' });
    }
  },
);

fastify.post<{ Body: { room?: string; identity?: string; name?: string; host?: boolean; waitingRoom?: boolean } }>(
  '/token',
  { preHandler: requireSharedSecret },
  async (req, reply) => {
    const { room, identity, name, host, waitingRoom } = req.body ?? {};
    if (
      typeof room !== 'string' ||
      !room ||
      typeof identity !== 'string' ||
      !identity ||
      typeof name !== 'string' ||
      !name
    ) {
      reply.code(400).send({ error: 'room, identity and name are required strings.' });
      return;
    }

    try {
      if (host === true) {
        // The caller decides who hosts; recording it lets GET /rooms report it on the next join.
        // A host may also set the waiting room as they join.
        await recordRoomHost(room, identity, typeof waitingRoom === 'boolean' ? waitingRoom : undefined);
      } else if ((await getRoomSettings(room))?.waitingRoom && !lobby.isAdmitted(room, identity)) {
        // Enforced here, not left to each consumer: a guest gets in only through /lobby/ask.
        reply.code(409).send({ error: 'This call has a waiting room. Ask to join.', waitingRoom: true });
        return;
      }
      reply.send(await mintToken({ room, identity, name }));
    } catch (err) {
      console.error('Failed to mint LiveKit token:', err);
      reply.code(500).send({ error: 'Could not mint a token.' });
    }
  },
);

// Ends a room for everyone on behalf of a host. The participant's own join token is the proof of who
// they are; the room's hosts list says whether they host.
fastify.post<{ Body: { room?: string; token?: string } }>('/room/end', { preHandler: requireSharedSecret }, async (req, reply) => {
  const { room, token } = req.body ?? {};
  if (typeof room !== 'string' || !room || typeof token !== 'string' || !token) {
    reply.code(400).send({ error: 'room and token are required.' });
    return;
  }
  try {
    if ((await endRoomAsHost(room, token)) === 'forbidden') {
      reply.code(403).send({ error: 'Only the host can end this call for everyone.' });
      return;
    }
    reply.send({ ok: true });
  } catch (err) {
    console.error('Failed to end room:', err);
    reply.code(500).send({ error: 'Could not end the call.' });
  }
});

// A host makes someone in the call a host too (host: true), or stops them hosting (host: false).
// Proof is the caller's own join token, as for /room/end. Nobody changes their own role, so a room
// never loses its last host this way. Someone who stops hosting can still rejoin past the waiting room.
fastify.post<{ Body: { room?: string; token?: string; identity?: string; host?: boolean } }>(
  '/room/host',
  { preHandler: requireSharedSecret },
  async (req, reply) => {
    const { room, token, identity, host } = req.body ?? {};
    if (typeof room !== 'string' || !room || typeof token !== 'string' || !token || typeof identity !== 'string' || !identity || typeof host !== 'boolean') {
      reply.code(400).send({ error: 'room, token, identity (strings) and host (boolean) are required.' });
      return;
    }
    try {
      const caller = await hostIdentity(room, token);
      if (!caller) {
        reply.code(403).send({ error: 'Only a host can change who hosts.' });
        return;
      }
      if (caller === identity) {
        reply.code(400).send({ error: "You can't change your own host role." });
        return;
      }
      if (host && !(await getParticipantSid(room, identity))) {
        reply.code(404).send({ error: "That person isn't in the call." });
        return;
      }
      await setRoomHost(room, identity, host);
      if (!host) lobby.admit(room, identity);
      reply.send({ identity, host });
    } catch (err) {
      console.error('Failed to change a room host:', err);
      reply.code(500).send({ error: 'Could not change who hosts.' });
    }
  },
);

fastify.post<{ Body: { room?: string; startedBy?: string } }>(
  '/recording/start',
  { preHandler: requireSharedSecret },
  async (req, reply) => {
    const { room, startedBy } = req.body ?? {};
    if (typeof room !== 'string' || !room) {
      reply.code(400).send({ error: 'room is required.' });
      return;
    }
    try {
      reply.send(await startRoomAudioRecording(room, typeof startedBy === 'string' ? startedBy : undefined));
    } catch (err) {
      console.error('Failed to start recording:', err);
      reply.code(500).send({ error: 'Could not start recording.' });
    }
  },
);

fastify.post<{ Body: { egressId?: string } }>('/recording/stop', { preHandler: requireSharedSecret }, async (req, reply) => {
  const egressId = req.body?.egressId;
  if (typeof egressId !== 'string' || !egressId) {
    reply.code(400).send({ error: 'egressId is required.' });
    return;
  }
  try {
    autoRecord.onRecordingStoppedByHand(await stopRecording(egressId));
    reply.send({ ok: true });
  } catch (err) {
    console.error('Failed to stop recording:', err);
    reply.code(500).send({ error: 'Could not stop recording.' });
  }
});

fastify.get<{ Querystring: { room?: string } }>('/recording/status', { preHandler: requireSharedSecret }, async (req, reply) => {
  const room = String(req.query.room ?? '');
  if (!room) {
    reply.code(400).send({ error: 'room query param is required.' });
    return;
  }
  try {
    reply.send(await getActiveRecordings(room));
  } catch (err) {
    console.error('Failed to look up recording status:', err);
    reply.code(500).send({ error: 'Could not look up recording status.' });
  }
});

// A room's finished recordings with their transcripts (Soniox, see transcripts.ts), oldest first.
// `transcript` is present once status is `ready`.
fastify.get<{ Querystring: { room?: string } }>('/recording/transcripts', { preHandler: requireSharedSecret }, async (req, reply) => {
  const room = String(req.query.room ?? '');
  if (!room) {
    reply.code(400).send({ error: 'room query param is required.' });
    return;
  }
  try {
    const files = (await listRecordingFiles())
      .filter((f) => f.kind === 'compressed' && parseRecordingName(f.name)?.room === room)
      .reverse();
    const states = await transcriptStates(files.map((f) => f.name));
    reply.send(
      await Promise.all(
        files.map(async (f) => {
          const state = states.get(f.name)!;
          return {
            file: f.name,
            recordedAt: parseRecordingName(f.name)?.recordedAt ?? null,
            bytes: f.bytes,
            ...state,
            ...(state.status === 'ready' ? { transcript: await readTranscript(f.name) } : {}),
          };
        }),
      ),
    );
  } catch (err) {
    console.error('Failed to list transcripts:', err);
    reply.code(500).send({ error: 'Could not list transcripts.' });
  }
});

// LiveKit itself calls this -- not the browser, not the demo -- so it's authenticated by
// LiveKit's own webhook signature (a standard `Authorization` header, JWT-signed with the same
// devkey/secret livekit-server signs with -- see livekit/config.yaml's `webhook.api_key`) rather
// than TOKEN_SERVICE_SHARED_SECRET. Registered in its own encapsulated context because the
// signature check needs the exact raw request body, and LiveKit posts it as the non-standard
// `application/webhook+json` content type; every other route in this file wants normal
// pre-parsed JSON.
fastify.register(async (scoped) => {
  scoped.addContentTypeParser('application/webhook+json', { parseAs: 'string' }, (_req, body, done) => done(null, body));

  const webhooks = new WebhookReceiver(
    process.env.LIVEKIT_API_KEY ?? '',
    process.env.LIVEKIT_API_SECRET ?? '',
  );

  scoped.post<{ Body: string }>('/recording/webhook', async (req, reply) => {
    let event;
    try {
      event = await webhooks.receive(req.body, req.headers.authorization);
    } catch (err) {
      console.error('Rejected LiveKit webhook (bad signature):', err);
      reply.code(401).send();
      return;
    }

    // Always ack once the signature checks out -- LiveKit retries a non-2xx response, and a
    // transient file-move failure shouldn't turn into repeated attempts.
    reply.send({ received: true });

    const info = event.egressInfo;
    if (event.event === 'participant_joined' && event.room?.name) {
      // Records the call when RECORD_ALL_CALLS=1 (autoRecord.ts); off by default.
      autoRecord.onParticipantJoined(event.room.name, event.participant?.kind);
      return;
    }
    if (event.event === 'room_finished' && event.room?.name) {
      // Belt-and-braces: LiveKit ties Room Composite Egress to the room's own lifecycle, but if
      // that coupling ever fails to tear an egress down cleanly, this guarantees a recording
      // can't outlive every participant having left.
      stopAllActiveRecordings(event.room.name).catch((err) => {
        console.error(`Failed to auto-stop recording(s) for finished room ${event.room?.name}:`, err);
      });
      lobby.forgetRoom(event.room.name);
      autoRecord.forgetRoom(event.room.name);
      return;
    }
    if (event.event !== 'egress_ended' || info?.status !== EgressStatus.EGRESS_COMPLETE) {
      return;
    }
    for (const file of info.fileResults) {
      let finished: string;
      try {
        finished = await finishRecording(containerPathToHostPath(file.filename));
      } catch (err) {
        console.error(`Failed to move finished recording ${file.filename}:`, err);
        continue;
      }
      // Every finished recording gets a transcript; this runs in the background (minutes for a long call).
      void transcribeRecording(path.basename(finished));
    }
  });
});

fastify.register(adminRoutes, { prefix: '/admin' });
fastify.register(lobbyRoutes, { prefix: '/lobby' });
fastify.register(embedRoutes, { prefix: '/embed' });

const port = Number(process.env.PORT ?? 8880);
fastify
  .listen({ port, host: '0.0.0.0' })
  .then(() => {
    console.log(`token-service listening on :${port}`);
    // Recordings saved while transcription was off, or cut short by a restart.
    setTimeout(() => transcribeMissing().catch((err) => console.error('Could not transcribe missing recordings:', err)), 10_000).unref();
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
