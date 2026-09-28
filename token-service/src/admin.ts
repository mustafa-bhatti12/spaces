import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { requireAdminSecret } from './auth';
import {
  closeRoom,
  listActiveRooms,
  listAllActiveRecordings,
  listRoomsWithParticipants,
  removeParticipant,
  setTrackMuted,
  startRoomAudioRecording,
  stopRecording,
} from './livekit';
import { listRecordingFiles, RECORDING_DIRS, resolveRecordingFile } from './recordings';
import { collectSystemSnapshot, egressContainer } from './system';
import { lobby } from './lobby';
import * as autoRecord from './autoRecord';
import { deleteTranscript, readTranscript, transcribeRecording, transcriptStates, transcriptToText } from './transcripts';

type Check = { ok: boolean; detail: string };

/**
 * Operator control center API: live rooms, moderation, recording control, recording files and
 * service health. Gated by ADMIN_SHARED_SECRET, not the consumer secret — the /admin control center (which holds
 * the operator login) is the only caller; this service still has no concept of a logged-in person.
 */
export async function adminRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAdminSecret);

  // Each part fails independently: with the recording worker down, listEgress errors ("egress not
  // connected"), but live rooms and saved files should still show. `errors` names what's missing.
  app.get('/overview', async () => {
    const [rooms, activeRecordings, files] = await Promise.allSettled([
      listRoomsWithParticipants(),
      listAllActiveRecordings(),
      listRecordingFiles(),
    ]);
    const errors: Record<string, string> = {};
    for (const [name, result] of Object.entries({ rooms, activeRecordings, files })) {
      if (result.status === 'rejected') errors[name] = (result.reason as Error).message;
    }
    const fileList = files.status === 'fulfilled' ? files.value : [];
    const transcripts = await transcriptStates(fileList.filter((f) => f.kind === 'compressed').map((f) => f.name)).catch((err: Error) => {
      errors.transcripts = err.message;
      return new Map();
    });
    return {
      rooms: rooms.status === 'fulfilled' ? rooms.value : [],
      activeRecordings: activeRecordings.status === 'fulfilled' ? activeRecordings.value : [],
      // Finished recordings carry their transcript status; raw ones are still being written.
      files: fileList.map((f) => (f.kind === 'compressed' ? { ...f, transcript: transcripts.get(f.name) } : f)),
      errors,
    };
  });

  app.get('/health', async () => {
    const [livekit, egressWorker] = await Promise.all([
      listActiveRooms().then(
        (rooms): Check => ({ ok: true, detail: `${rooms.length} active room(s)` }),
        (err: Error): Check => ({ ok: false, detail: err.message }),
      ),
      // The egress worker is a Docker container started by start-all.sh; LiveKit's API only shows
      // egress *jobs*, not whether a worker exists to pick them up. Cached, see egressContainer().
      egressContainer().then(
        (c): Check => (c ? { ok: c.status === 'running', detail: c.status } : { ok: false, detail: 'container not found or Docker unavailable' }),
      ),
    ]);
    const disk = await fs.promises.statfs(path.dirname(RECORDING_DIRS.compressed)).then(
      (s) => ({ freeBytes: s.bavail * s.bsize, totalBytes: s.blocks * s.bsize }),
      () => null,
    );
    return { livekit, egressWorker, disk };
  });

  // Host + per-service metrics (CPU, memory, network, versions, TLS expiry, deployed commit).
  app.get('/system', async () => collectSystemSnapshot());

  app.post<{ Body: { room?: string } }>('/rooms/close', async (req, reply) => {
    const room = req.body?.room;
    if (typeof room !== 'string' || !room) return reply.code(400).send({ error: 'room is required.' });
    await closeRoom(room);
    return { ok: true };
  });

  app.post<{ Body: { room?: string; identity?: string } }>('/participants/remove', async (req, reply) => {
    const { room, identity } = req.body ?? {};
    if (typeof room !== 'string' || !room || typeof identity !== 'string' || !identity) {
      return reply.code(400).send({ error: 'room and identity are required.' });
    }
    await removeParticipant(room, identity);
    lobby.revoke(room, identity); // with the waiting room on, they have to ask again
    return { ok: true };
  });

  app.post<{ Body: { room?: string; identity?: string; trackSid?: string; muted?: boolean } }>(
    '/tracks/mute',
    async (req, reply) => {
      const { room, identity, trackSid, muted } = req.body ?? {};
      if (
        typeof room !== 'string' || !room ||
        typeof identity !== 'string' || !identity ||
        typeof trackSid !== 'string' || !trackSid ||
        typeof muted !== 'boolean'
      ) {
        return reply.code(400).send({ error: 'room, identity, trackSid and muted (boolean) are required.' });
      }
      await setTrackMuted(room, identity, trackSid, muted);
      return { ok: true };
    },
  );

  app.post<{ Body: { room?: string } }>('/recordings/start', async (req, reply) => {
    const room = req.body?.room;
    if (typeof room !== 'string' || !room) return reply.code(400).send({ error: 'room is required.' });
    return startRoomAudioRecording(room, 'Admin');
  });

  app.post<{ Body: { egressId?: string } }>('/recordings/stop', async (req, reply) => {
    const egressId = req.body?.egressId;
    if (typeof egressId !== 'string' || !egressId) return reply.code(400).send({ error: 'egressId is required.' });
    autoRecord.onRecordingStoppedByHand(await stopRecording(egressId));
    return { ok: true };
  });

  app.get<{ Params: { kind: string; name: string }; Querystring: { download?: string } }>(
    '/files/:kind/:name',
    async (req, reply) => {
      const file = resolveRecordingFile(req.params.kind, req.params.name);
      if (!file) return reply.code(400).send({ error: 'Unknown recording.' });
      let size: number;
      try {
        size = (await fs.promises.stat(file)).size;
      } catch {
        return reply.code(404).send({ error: 'Recording not found.' });
      }
      if (req.query.download === '1') {
        reply.header('Content-Disposition', `attachment; filename="${req.params.name}"`);
      }
      return sendFileWithRange(reply, file, size, req.headers.range);
    },
  );

  app.delete<{ Params: { kind: string; name: string } }>('/files/:kind/:name', async (req, reply) => {
    const file = resolveRecordingFile(req.params.kind, req.params.name);
    if (!file) return reply.code(400).send({ error: 'Unknown recording.' });
    try {
      await fs.promises.unlink(file);
      if (req.params.kind === 'compressed') await deleteTranscript(req.params.name);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return reply.code(404).send({ error: 'Recording not found.' });
      throw err;
    }
    return { ok: true };
  });

  // A finished recording's transcript: JSON, or ?format=txt for plain text (&download=1 to save it).
  app.get<{ Params: { name: string }; Querystring: { format?: string; download?: string } }>('/transcripts/:name', async (req, reply) => {
    const transcript = await readTranscript(req.params.name);
    if (!transcript) return reply.code(404).send({ error: 'No transcript for this recording.' });
    if (req.query.format !== 'txt') return transcript;
    if (req.query.download === '1') {
      reply.header('Content-Disposition', `attachment; filename="${req.params.name.replace(/\.ogg$/, '')}.txt"`);
    }
    return reply.type('text/plain; charset=utf-8').send(transcriptToText(transcript));
  });

  // Transcribe (again): for a failed attempt, or one a restart cut short. Runs in the background.
  app.post<{ Params: { name: string } }>('/transcripts/:name', async (req, reply) => {
    if (!process.env.SONIOX_API_KEY) return reply.code(409).send({ error: 'Transcription is off: SONIOX_API_KEY is not set.' });
    const file = resolveRecordingFile('compressed', req.params.name);
    if (!file || !fs.existsSync(file)) return reply.code(404).send({ error: 'Recording not found.' });
    void transcribeRecording(req.params.name);
    return { status: 'transcribing' };
  });
}

// <audio> seeks with Range requests; without 206 support the browser can only play from the start.
function sendFileWithRange(reply: FastifyReply, file: string, size: number, range: string | undefined) {
  reply.type('audio/ogg').header('Accept-Ranges', 'bytes');
  const match = range ? /^bytes=(\d*)-(\d*)$/.exec(range) : null;
  if (!match || (!match[1] && !match[2])) {
    reply.header('Content-Length', size);
    return reply.send(fs.createReadStream(file));
  }
  // bytes=-N is "the last N bytes"; bytes=N- is "from N to the end".
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  if (start > end || start >= size) {
    return reply.code(416).header('Content-Range', `bytes */${size}`).send();
  }
  reply.code(206).header('Content-Range', `bytes ${start}-${end}/${size}`).header('Content-Length', end - start + 1);
  return reply.send(fs.createReadStream(file, { start, end }));
}
