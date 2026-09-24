import 'dotenv/config';
import Fastify from 'fastify';
import { EgressStatus, WebhookReceiver } from 'livekit-server-sdk';
import {
  containerPathToHostPath,
  getActiveRecordings,
  getParticipantSid,
  listActiveRooms,
  mintToken,
  startRoomAudioRecording,
  stopAllActiveRecordings,
  stopRecording,
} from './livekit';
import { requireSharedSecret } from './auth';
import { adminRoutes } from './admin';

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

fastify.post<{ Body: { room?: string; identity?: string; name?: string } }>(
  '/token',
  { preHandler: requireSharedSecret },
  async (req, reply) => {
    const { room, identity, name } = req.body ?? {};
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
      reply.send(await mintToken({ room, identity, name }));
    } catch (err) {
      console.error('Failed to mint LiveKit token:', err);
      reply.code(500).send({ error: 'Could not mint a token.' });
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
    await stopRecording(egressId);
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

// LiveKit itself calls this -- not the browser, not test-call -- so it's authenticated by
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
  const compressorUrl = process.env.COMPRESSOR_URL ?? 'http://127.0.0.1:8890';

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
    // transient compressor failure shouldn't turn into repeated compression attempts.
    reply.send({ received: true });

    const info = event.egressInfo;
    if (event.event === 'room_finished' && event.room?.name) {
      // Belt-and-braces: LiveKit ties Room Composite Egress to the room's own lifecycle, but if
      // that coupling ever fails to tear an egress down cleanly, this guarantees a recording
      // can't outlive every participant having left.
      stopAllActiveRecordings(event.room.name).catch((err) => {
        console.error(`Failed to auto-stop recording(s) for finished room ${event.room?.name}:`, err);
      });
      return;
    }
    if (event.event !== 'egress_ended' || info?.status !== EgressStatus.EGRESS_COMPLETE) {
      return;
    }
    for (const file of info.fileResults) {
      try {
        const inputPath = containerPathToHostPath(file.filename);
        const res = await fetch(`${compressorUrl}/compress`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ inputPath }),
        });
        if (!res.ok) {
          console.error(`Compressor responded ${res.status} for ${inputPath}`);
        }
      } catch (err) {
        console.error(`Failed to hand ${file.filename} to the compressor:`, err);
      }
    }
  });
});

fastify.register(adminRoutes, { prefix: '/admin' });

const port = Number(process.env.PORT ?? 8880);
fastify
  .listen({ port, host: '0.0.0.0' })
  .then(() => console.log(`token-service listening on :${port}`))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
