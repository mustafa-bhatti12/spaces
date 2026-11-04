// Imported first by tests that touch recording files: recordings.ts and transcripts.ts read their
// directories when first loaded, and ES imports are evaluated before the importing file's own code.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spaces-rec-'));
process.env.EGRESS_COMPRESSED_DIR = path.join(root, 'compressed');
process.env.EGRESS_TRANSCRIPTS_DIR = path.join(root, 'transcripts');
delete process.env.SONIOX_API_KEY;
