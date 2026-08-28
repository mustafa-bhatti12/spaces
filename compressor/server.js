require('dotenv/config');
const Fastify = require('fastify');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

// Internal-only: token-service calls this after a room recording finishes, handing it the raw
// egress output so it can be shrunk before it's kept long-term. Never exposed to the LAN -- bound
// to 127.0.0.1 below, no shared-secret auth needed because nothing outside this host can reach it.
const RAW_DIR = process.env.RAW_DIR ?? path.join(__dirname, '..', 'egress', 'raw');
const COMPRESSED_DIR = process.env.COMPRESSED_DIR ?? path.join(__dirname, '..', 'egress', 'compressed');
const PORT = Number(process.env.PORT ?? 8890);

// Speech doesn't need music-grade fidelity, and this audio is headed for transcription, not
// playback -- 24kbps mono Opus is a fraction of what LiveKit's own recording produces (typically
// 64-128kbps) while remaining perfectly intelligible to both humans and speech-to-text.
const OPUS_BITRATE = process.env.COMPRESS_BITRATE ?? '24k';

fs.mkdirSync(RAW_DIR, { recursive: true });
fs.mkdirSync(COMPRESSED_DIR, { recursive: true });

const fastify = Fastify();

fastify.get('/health', async () => ({ ok: true }));

fastify.post('/compress', async (request, reply) => {
  const inputPath = String(request.body?.inputPath ?? '');
  if (!inputPath) {
    reply.code(400).send({ error: 'inputPath is required.' });
    return;
  }

  // inputPath must resolve inside RAW_DIR -- this endpoint isn't LAN-reachable, but a bug
  // upstream that hands us an absolute path outside our own tree shouldn't get to touch it.
  const resolved = path.resolve(inputPath);
  if (!resolved.startsWith(path.resolve(RAW_DIR) + path.sep)) {
    reply.code(400).send({ error: 'inputPath must be inside the raw recordings directory.' });
    return;
  }
  if (!fs.existsSync(resolved)) {
    reply.code(404).send({ error: `No such file: ${resolved}` });
    return;
  }

  const base = path.basename(resolved, path.extname(resolved));
  const outputPath = path.join(COMPRESSED_DIR, `${base}.ogg`);

  try {
    await new Promise((resolve, reject) => {
      execFile(
        'ffmpeg',
        ['-y', '-i', resolved, '-vn', '-ac', '1', '-c:a', 'libopus', '-b:a', OPUS_BITRATE, outputPath],
        (err, _stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve()),
      );
    });
  } catch (err) {
    console.error('ffmpeg compression failed:', err.message);
    reply.code(500).send({ error: 'Compression failed.' });
    return;
  }

  const originalBytes = fs.statSync(resolved).size;
  const compressedBytes = fs.statSync(outputPath).size;
  fs.unlinkSync(resolved); // raw file's job is done once the compressed copy exists

  reply.send({ compressedPath: outputPath, originalBytes, compressedBytes });
});

fastify
  .listen({ port: PORT, host: '127.0.0.1' })
  .then(() => console.log(`compressor listening on 127.0.0.1:${PORT} (raw: ${RAW_DIR}, compressed: ${COMPRESSED_DIR})`))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
