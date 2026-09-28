import fs from 'node:fs/promises';
import path from 'node:path';
import { EGRESS_HOST_RAW_DIR } from './livekit';

// Where recordings live on this host. raw/ is where egress writes a recording as it finalizes;
// compressed/ holds finished ones (egress already encodes them at the final bitrate, so "compressed"
// is just the name the admin console and existing files use).
export const RECORDING_DIRS = {
  raw: EGRESS_HOST_RAW_DIR,
  compressed: process.env.EGRESS_COMPRESSED_DIR ?? path.join(__dirname, '..', '..', 'egress', 'compressed'),
} as const;

export type RecordingKind = keyof typeof RECORDING_DIRS;

export interface RecordingFile {
  kind: RecordingKind;
  name: string;
  bytes: number;
  modifiedAt: string; // ISO timestamp
}

// Egress names files `<room>-<epoch ms>.ogg`, and room names are normalized to lowercase + dashes
// by the demo; anything outside this set (separators, `..`, a leading dot) is never one of ours.
const SAFE_FILE_NAME = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

/**
 * Maps a (kind, file name) pair from an admin request to an absolute path inside that kind's
 * directory, or null when the kind is unknown or the name could escape the directory. The only
 * gate between an operator-supplied string and fs.unlink / a file read.
 */
export function resolveRecordingFile(kind: string, name: string): string | null {
  if (!Object.hasOwn(RECORDING_DIRS, kind) || !SAFE_FILE_NAME.test(name)) {
    return null;
  }
  const dir = path.resolve(RECORDING_DIRS[kind as RecordingKind]);
  const resolved = path.resolve(dir, name);
  return path.dirname(resolved) === dir ? resolved : null;
}

/**
 * Moves a finalized egress file (host path inside raw/) into compressed/, keeping its name. Egress
 * only reports a file once it's fully written, so compressed/ never holds a partial recording.
 */
export async function finishRecording(rawPath: string): Promise<string> {
  const target = path.join(RECORDING_DIRS.compressed, path.basename(rawPath));
  await fs.mkdir(RECORDING_DIRS.compressed, { recursive: true });
  try {
    await fs.rename(rawPath, target);
  } catch (err) {
    // The two directories can be pointed at different filesystems (EGRESS_*_DIR), where rename fails.
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    await fs.copyFile(rawPath, target);
    await fs.unlink(rawPath);
  }
  return target;
}

/** Every recording file on disk, newest first. A missing directory just contributes nothing. */
export async function listRecordingFiles(): Promise<RecordingFile[]> {
  const files: RecordingFile[] = [];
  for (const kind of Object.keys(RECORDING_DIRS) as RecordingKind[]) {
    let entries;
    try {
      entries = await fs.readdir(RECORDING_DIRS[kind], { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !SAFE_FILE_NAME.test(entry.name)) continue;
      const stat = await fs.stat(path.join(RECORDING_DIRS[kind], entry.name));
      files.push({ kind, name: entry.name, bytes: stat.size, modifiedAt: stat.mtime.toISOString() });
    }
  }
  return files.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
}
