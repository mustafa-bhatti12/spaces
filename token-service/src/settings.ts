import fs from 'node:fs';
import path from 'node:path';

/**
 * Recording and transcription settings an operator can change in /admin (Settings) without a
 * restart. token-service/.env holds the defaults; values saved from /admin go to a gitignored JSON
 * file next to it and win over .env until reset. Readers call getSettings() each time, so a change
 * applies to the next recording or transcript.
 */
export interface RuntimeSettings {
  transcription: {
    /** Off: finished recordings aren't sent to Soniox. Needs SONIOX_API_KEY either way. */
    enabled: boolean;
    /** Languages the calls are likely in (ISO codes, e.g. "en", "ur"). */
    languageHints: string[];
    /** Words Soniox should expect: names, acronyms. */
    terms: string[];
    /** Translate speech in other languages into this one; "" = no translation. */
    translateTo: string;
  };
  recording: {
    /** Opus bitrate of new recordings. */
    audioKbps: number;
    /** Record every call from its first join, not only rooms marked on /token. */
    recordAllCalls: boolean;
  };
}

// Read when first needed (not at import), after dotenv has loaded .env.
const settingsFile = () => process.env.SPACES_SETTINGS_FILE ?? path.join(__dirname, '..', 'settings.json');

export const LIMITS = { kbpsMin: 12, kbpsMax: 128, maxHints: 10, maxTerms: 100, maxTermLength: 100 } as const;
const LANGUAGE = /^[a-z]{2,3}$/;

function envList(name: string): string[] {
  return (process.env[name] ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

/** The .env values (what "Reset" goes back to). */
export function defaultSettings(): RuntimeSettings {
  const kbps = Number(process.env.RECORDING_AUDIO_KBPS);
  return {
    transcription: {
      enabled: true,
      languageHints: envList('TRANSCRIPTION_LANGUAGE_HINTS'),
      terms: envList('TRANSCRIPTION_TERMS'),
      translateTo: process.env.TRANSCRIPTION_TRANSLATE_TO?.trim() ?? '',
    },
    recording: {
      audioKbps: Number.isInteger(kbps) && kbps > 0 ? kbps : 24,
      recordAllCalls: process.env.RECORD_ALL_CALLS === '1',
    },
  };
}

function cleanList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) throw new Error(`${field} must be a list of text.`);
  return [...new Set(value.map((v: string) => v.trim()).filter(Boolean))];
}

/** Checks a full settings object from /admin; throws an Error whose message is shown to the operator. */
export function validateSettings(input: unknown): RuntimeSettings {
  const body = (input ?? {}) as { transcription?: Record<string, unknown>; recording?: Record<string, unknown> };
  const t = body.transcription ?? {};
  const r = body.recording ?? {};
  if (typeof t.enabled !== 'boolean') throw new Error('transcription.enabled must be true or false.');
  if (typeof r.recordAllCalls !== 'boolean') throw new Error('recording.recordAllCalls must be true or false.');

  const languageHints = [...new Set(cleanList(t.languageHints, 'Language hints').map((l) => l.toLowerCase()))];
  const badLanguage = languageHints.find((l) => !LANGUAGE.test(l));
  if (badLanguage) throw new Error(`"${badLanguage}" isn't a language code. Use codes like en, ur, ar.`);
  if (languageHints.length > LIMITS.maxHints) throw new Error(`At most ${LIMITS.maxHints} language hints.`);

  const terms = cleanList(t.terms, 'Terms');
  if (terms.length > LIMITS.maxTerms) throw new Error(`At most ${LIMITS.maxTerms} terms.`);
  const longTerm = terms.find((term) => term.length > LIMITS.maxTermLength);
  if (longTerm) throw new Error(`Terms can be at most ${LIMITS.maxTermLength} characters ("${longTerm.slice(0, 24)}…").`);

  if (typeof t.translateTo !== 'string') throw new Error('Translate to must be text.');
  const translateTo = t.translateTo.trim().toLowerCase();
  if (translateTo && !LANGUAGE.test(translateTo)) throw new Error(`"${translateTo}" isn't a language code. Use a code like en, or leave it empty.`);

  const audioKbps = r.audioKbps;
  if (typeof audioKbps !== 'number' || !Number.isInteger(audioKbps) || audioKbps < LIMITS.kbpsMin || audioKbps > LIMITS.kbpsMax) {
    throw new Error(`Audio bitrate must be a whole number from ${LIMITS.kbpsMin} to ${LIMITS.kbpsMax} kbps.`);
  }

  return {
    transcription: { enabled: t.enabled, languageHints, terms, translateTo },
    recording: { audioKbps, recordAllCalls: r.recordAllCalls },
  };
}

function load(): RuntimeSettings | null {
  let raw: string;
  try {
    raw = fs.readFileSync(settingsFile(), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  try {
    return validateSettings(JSON.parse(raw));
  } catch (err) {
    // A broken file must not take recording down: fall back to .env and say so.
    console.error(`Ignoring ${settingsFile()}: ${(err as Error).message}`);
    return null;
  }
}

// undefined = not read yet; null = nothing saved (use .env).
let saved: RuntimeSettings | null | undefined;
const savedSettings = () => (saved === undefined ? (saved = load()) : saved);

/** The settings in force: the ones saved from /admin, else .env. */
export function getSettings(): RuntimeSettings {
  return savedSettings() ?? defaultSettings();
}

/** True when /admin saved settings that override .env. */
export function hasSavedSettings(): boolean {
  return savedSettings() !== null;
}

export function saveSettings(input: unknown): RuntimeSettings {
  const next = validateSettings(input);
  const file = settingsFile();
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file);
  saved = next;
  return next;
}

/** Back to the .env values. */
export function resetSettings(): RuntimeSettings {
  fs.rmSync(settingsFile(), { force: true });
  saved = null;
  return defaultSettings();
}
