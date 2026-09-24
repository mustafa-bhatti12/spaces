import { execFile } from 'node:child_process';
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
    return {
      rooms: rooms.status === 'fulfilled' ? rooms.value : [],
      activeRecordings: activeRecordings.status === 'fulfilled' ? activeRecordings.value : [],
      files: files.status === 'fulfilled' ? files.value : [],
      errors,
    };
  });

  app.get('/health', async () => {
    const compressorUrl = process.env.COMPRESSOR_URL ?? 'http://127.0.0.1:8890';
    const [livekit, compressor, egressWorker] = await Promise.all([
      listActiveRooms().then(
        (rooms): Check => ({ ok: true, detail: `${rooms.length} active room(s)` }),
        (err: Error): Check => ({ ok: false, detail: err.message }),
      ),
      fetch(`${compressorUrl}/health`, { signal: AbortSignal.timeout(2000) }).then(
        (res): Check => ({ ok: res.ok, detail: res.ok ? 'reachable' : `responded ${res.status}` }),
        (err: Error): Check => ({ ok: false, detail: err.message }),
      ),
      new Promise<Check>((resolve) => {
        // The egress worker is a Docker container started by start-all.sh; LiveKit's API only
        // shows egress *jobs*, not whether a worker exists to pick them up.
        execFile('docker', ['inspect', '-f', '{{.State.Status}}', 'space-egress'], { timeout: 3000 }, (err, stdout) => {
          const status = stdout.trim();
          resolve(err ? { ok: false, detail: 'container not found or Docker unavailable' } : { ok: status === 'running', detail: status });
        });
      }),
    ]);
    const disk = await fs.promises.statfs(path.dirname(RECORDING_DIRS.compressed)).then(
      (s) => ({ freeBytes: s.bavail * s.bsize, totalBytes: s.blocks * s.bsize }),
      () => null,
    );
    return { livekit, compressor, egressWorker, disk };
  });

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
    await stopRecording(egressId);
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
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return reply.code(404).send({ error: 'Recording not found.' });
      throw err;
    }
    return { ok: true };
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
