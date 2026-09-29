import type { FastifyInstance, FastifyReply } from 'fastify';
import { requireSharedSecret } from './auth';
import { getParticipantSid, getRoomSettings, hostIdentity, muteMicrophone, notifyRoom, removeParticipant, setSpotlight } from './livekit';
import { lobby } from './lobby';

/** Data-message topic telling one participant a host muted their mic (their client says so). */
const MUTED_TOPIC = 'space.muted';

/**
 * Host moderation, under /room: pin someone for everyone, mute someone's mic, remove someone.
 * Proof is the caller's own join token, checked against the room's hosts list right now, as for
 * /room/end and /room/host. Nobody moderates themselves, and a host can't remove another host
 * (stop them hosting first), so hosts can't throw each other out.
 */
export async function moderationRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireSharedSecret);

  /** The caller when `token` belongs to a host of `room` acting on someone else; otherwise replies and returns null. */
  const hostActingOn = async (
    body: { room?: unknown; token?: unknown; identity?: unknown } | undefined,
    reply: FastifyReply,
  ): Promise<{ room: string; identity: string } | null> => {
    const { room, token, identity } = body ?? {};
    if (typeof room !== 'string' || !room || typeof token !== 'string' || !token || typeof identity !== 'string' || !identity) {
      reply.code(400).send({ error: 'room, token and identity are required strings.' });
      return null;
    }
    const caller = await hostIdentity(room, token);
    if (!caller) {
      reply.code(403).send({ error: 'Only a host can do this.' });
      return null;
    }
    if (caller === identity) {
      reply.code(400).send({ error: "You can't do this to yourself." });
      return null;
    }
    return { room, identity };
  };

  app.post<{ Body: { room?: string; token?: string; identity?: string } }>('/mute', async (req, reply) => {
    const target = await hostActingOn(req.body, reply);
    if (!target) return reply;
    if (!(await muteMicrophone(target.room, target.identity))) {
      return reply.code(404).send({ error: "Their mic is already off, or they've left." });
    }
    await notifyRoom(target.room, MUTED_TOPIC, [target.identity]).catch(() => {});
    return { ok: true };
  });

  app.post<{ Body: { room?: string; token?: string; identity?: string } }>('/remove', async (req, reply) => {
    const target = await hostActingOn(req.body, reply);
    if (!target) return reply;
    const settings = await getRoomSettings(target.room);
    if (settings?.hosts.includes(target.identity)) {
      return reply.code(409).send({ error: 'Stop them hosting first.' });
    }
    // Blocked first, so a quick rejoin can't slip in between the removal and the block.
    lobby.remove(target.room, target.identity);
    await removeParticipant(target.room, target.identity).catch(() => {});
    if (settings?.spotlight === target.identity) await setSpotlight(target.room, null);
    return { ok: true };
  });

  // identity: null unpins. Everyone's layout follows the room's `spotlight` setting.
  app.post<{ Body: { room?: string; token?: string; identity?: string | null } }>('/spotlight', async (req, reply) => {
    const { room, token, identity } = req.body ?? {};
    if (typeof room !== 'string' || !room || typeof token !== 'string' || !token || (identity !== null && (typeof identity !== 'string' || !identity))) {
      return reply.code(400).send({ error: 'room and token (strings) and identity (string or null) are required.' });
    }
    if (!(await hostIdentity(room, token))) return reply.code(403).send({ error: 'Only a host can do this.' });
    if (identity && !(await getParticipantSid(room, identity))) {
      return reply.code(404).send({ error: "That person isn't in the call." });
    }
    await setSpotlight(room, identity);
    return { spotlight: identity };
  });
}
