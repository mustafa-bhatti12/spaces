import fs from 'node:fs/promises';
import path from 'node:path';
import { SonioxNodeClient, translateFromTranscript } from '@soniox/node';
import { RECORDING_DIRS, resolveRecordingFile } from './recordings';

// Every finished recording is transcribed with Soniox's async API (stt-async-v5): the whole file at
// once gives the best speaker separation, and it's the cheapest mode. The mixed recording carries no
// participant names, so speakers come back as "1", "2", ... Transcripts live next to the recordings,
// one JSON file per recording, named after it.
export const TRANSCRIPTS_DIR =
  process.env.EGRESS_TRANSCRIPTS_DIR ?? path.join(RECORDING_DIRS.compressed, '..', 'transcripts');

const MODEL = 'stt-async-v5';
// Long calls take a while to transcribe; the SDK's own default gives up after 5 minutes.
const WAIT_TIMEOUT_MS = 60 * 60_000;
const POLL_MS = 5000;

export interface TranscriptSegment {
  /** Soniox's diarization label ("1", "2", ...), or null when it couldn't tell. */
  speaker: string | null;
  /** ISO code of the spoken language, e.g. "en", "ur". */
  language: string | null;
  startMs: number | null;
  endMs: number | null;
  text: string;
  /**
   * The segment in TRANSCRIPTION_TRANSLATE_TO's language, when that's set and the segment was spoken
   * in another language. Absent otherwise.
   */
  translation?: string;
}

export interface Transcript {
  file: string;
  room: string | null;
  recordedAt: string | null;
  model: string;
  transcribedAt: string;
  durationMs: number | null;
  languages: string[];
  text: string;
  segments: TranscriptSegment[];
}

/** `ready`: transcript saved. `off`: no SONIOX_API_KEY, so nothing is transcribed. */
export type TranscriptStatus = 'ready' | 'transcribing' | 'failed' | 'none' | 'off';

export interface TranscriptState {
  status: TranscriptStatus;
  /** Why the last attempt failed (status `failed`). */
  error?: string;
}

// Egress names recordings `<room>-<epoch ms>.ogg` (see startRoomAudioRecording).
const RECORDING_NAME = /^(.+)-(\d{13})\.ogg$/;

export function parseRecordingName(file: string): { room: string; recordedAt: string } | null {
  const m = RECORDING_NAME.exec(file);
  return m ? { room: m[1], recordedAt: new Date(Number(m[2])).toISOString() } : null;
}

const transcriptPath = (file: string) => path.join(TRANSCRIPTS_DIR, `${file}.json`);
const errorPath = (file: string) => path.join(TRANSCRIPTS_DIR, `${file}.error.json`);

const inProgress = new Set<string>();
let client: SonioxNodeClient | null = null;

function soniox(): SonioxNodeClient | null {
  if (!process.env.SONIOX_API_KEY) return null;
  client ??= new SonioxNodeClient();
  return client;
}

function envList(name: string): string[] | undefined {
  const items = (process.env[name] ?? '')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean);
  return items.length ? items : undefined;
}
async function writeJson(target: string, value: unknown): Promise<void> {
  await fs.mkdir(TRANSCRIPTS_DIR, { recursive: true });
  const tmp = `${target}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2));
  await fs.rename(tmp, target);
}

/**
 * Transcribes a finished recording (a file name in compressed/) and saves the transcript. Runs in
 * the background: resolves once saved, never rejects (a failure is saved as the file's error and
 * logged). A second call for a file already in progress does nothing.
 */
export async function transcribeRecording(file: string): Promise<void> {
  const api = soniox();
  const audioPath = resolveRecordingFile('compressed', file);
  if (!api || !audioPath || inProgress.has(file)) return;
  inProgress.add(file);
  try {
    const audio = await fs.readFile(audioPath);
    const parsed = parseRecordingName(file);
    const translateTo = process.env.TRANSCRIPTION_TRANSLATE_TO?.trim() || undefined;
    const result = await api.stt.transcribe({
      model: MODEL,
      file: audio,
      filename: file,
      // Languages the calls are likely in, and words Soniox should expect (names, acronyms like
      // "USCIS" that it otherwise hears as ordinary words). Both are optional deployment settings.
      language_hints: envList('TRANSCRIPTION_LANGUAGE_HINTS'),
      context: envList('TRANSCRIPTION_TERMS') ? { terms: envList('TRANSCRIPTION_TERMS') } : undefined,
      enable_language_identification: true,
      enable_speaker_diarization: true,
      // Also translate speech in other languages into this one (one Soniox job; its extra output
      // text is billed like the transcript's).
      translation: translateTo ? { type: 'one_way', target_language: translateTo } : undefined,
      // Shows up in Soniox's usage logs, so cost can be traced back to a call.
      client_reference_id: (parsed?.room ?? file).slice(0, 256),
      wait: true,
      wait_options: { interval_ms: POLL_MS, timeout_ms: WAIT_TIMEOUT_MS },
      // Nothing stays on Soniox once we have the transcript (or the attempt failed).
      cleanup: ['file', 'transcription'],
    });
    if (result.status !== 'completed' || !result.transcript) {
      throw new Error(result.error_message || `Transcription ended with status ${result.status}.`);
    }
    const { segments, text } = translateTo
      ? translatedSegments(result.transcript, translateTo)
      : {
          segments: result.transcript.segments().map((s) => ({
            speaker: s.speaker ?? null,
            language: s.language ?? null,
            startMs: s.start_ms ?? null,
            endMs: s.end_ms ?? null,
            text: s.text.trim(),
          })),
          text: result.transcript.text.trim(),
        };
    const transcript: Transcript = {
      file,
      room: parsed?.room ?? null,
      recordedAt: parsed?.recordedAt ?? null,
      model: MODEL,
      transcribedAt: new Date().toISOString(),
      durationMs: result.audio_duration_ms ?? null,
      languages: [...new Set(segments.map((s) => s.language).filter((l): l is string => !!l))],
      text,
      segments: segments.filter((s) => s.text),
    };
    await writeJson(transcriptPath(file), transcript);
    await fs.rm(errorPath(file), { force: true });
    console.log(`Transcribed ${file} (${transcript.segments.length} segments).`);
  } catch (err) {
    const message = (err as Error).message || String(err);
    console.error(`Transcription of ${file} failed:`, err);
    await writeJson(errorPath(file), { error: message, failedAt: new Date().toISOString() }).catch(() => {});
  } finally {
    inProgress.delete(file);
  }
}

/** Transcript status for each of `files` (recording names in compressed/), from one directory read. */
export async function transcriptStates(files: string[]): Promise<Map<string, TranscriptState>> {
  const states = new Map<string, TranscriptState>();
  const off = !process.env.SONIOX_API_KEY;
  let names: Set<string>;
  try {
    names = new Set(await fs.readdir(TRANSCRIPTS_DIR));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    names = new Set();
  }
  for (const file of files) {
    if (names.has(`${file}.json`)) states.set(file, { status: 'ready' });
    else if (inProgress.has(file)) states.set(file, { status: 'transcribing' });
    else if (names.has(`${file}.error.json`)) {
      const saved = await fs.readFile(errorPath(file), 'utf8').then(JSON.parse).catch(() => ({}));
      states.set(file, { status: 'failed', error: typeof saved.error === 'string' ? saved.error : undefined });
    } else states.set(file, { status: off ? 'off' : 'none' });
  }
  return states;
}

/** The saved transcript for a recording, or null when there isn't one (or the name isn't a recording). */
export async function readTranscript(file: string): Promise<Transcript | null> {
  if (!resolveRecordingFile('compressed', file)) return null;
  try {
    return JSON.parse(await fs.readFile(transcriptPath(file), 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** Removes a recording's transcript and any saved failure (the recording itself was deleted). */
export async function deleteTranscript(file: string): Promise<void> {
  if (!resolveRecordingFile('compressed', file)) return;
  await Promise.all([fs.rm(transcriptPath(file), { force: true }), fs.rm(errorPath(file), { force: true })]);
}

function clock(ms: number | null): string {
  const total = Math.floor((ms ?? 0) / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return [h, m, s].map((n) => String(n).padStart(2, '0')).join(':');
}

/** Plain-text transcript: one `[hh:mm:ss] Speaker N: text` line per segment. */
export function transcriptToText(t: Transcript): string {
  const head = `${t.room ?? t.file}${t.recordedAt ? `, recorded ${t.recordedAt}` : ''}\n\n`;
  return (
    head +
    t.segments
      .map((s) => {
        const line = `[${clock(s.startMs)}] ${s.speaker ? `Speaker ${s.speaker}` : 'Speaker'}: ${s.text}`;
        return s.translation ? `${line}\n           (${s.translation})` : line;
      })
      .join('\n') +
    '\n'
  );
}

/**
 * Segments of a transcript that also carries a one-way translation: Soniox mixes translation tokens
 * in after their spoken ones, so pair them per utterance and keep the spoken text as `text`.
 * Speech already in the target language has no translation.
 */
function translatedSegments(
  transcript: Parameters<typeof translateFromTranscript>[0],
  to: string,
): { segments: TranscriptSegment[]; text: string } {
  const result = translateFromTranscript(transcript, { type: 'one_way', to });
  const segments = result.segments.map((s): TranscriptSegment => {
    const translation = s.translation_text?.trim();
    return {
      speaker: s.speaker ?? null,
      language: s.from || null,
      startMs: s.start_ms ?? null,
      endMs: s.end_ms ?? null,
      text: s.original_text.trim(),
      ...(translation && s.from !== to ? { translation } : {}),
    };
  });
  return { segments, text: result.mode === 'one_way' ? result.original_text.trim() : '' };
}

/**
 * Transcribes every finished recording that has no transcript and no saved failure: recordings made
 * before transcription was switched on, and any whose transcription a restart interrupted.
 * One at a time, so a backlog doesn't upload everything at once.
 */
export async function transcribeMissing(): Promise<void> {
  if (!soniox()) return;
  let files: string[];
  try {
    files = (await fs.readdir(RECORDING_DIRS.compressed)).filter((f) => RECORDING_NAME.test(f));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  const states = await transcriptStates(files);
  for (const file of files) {
    if (states.get(file)?.status === 'none') await transcribeRecording(file);
  }
}
