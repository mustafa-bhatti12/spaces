'use client';

import { Download, FileText, RotateCw, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Led } from '../ui/Device';

/** token-service's TranscriptState (see token-service/src/transcripts.ts). */
export interface TranscriptState {
  status: 'ready' | 'transcribing' | 'failed' | 'none' | 'off';
  error?: string;
}

interface Segment {
  speaker: string | null;
  language: string | null;
  startMs: number | null;
  endMs: number | null;
  text: string;
}
interface Transcript {
  file: string;
  durationMs: number | null;
  languages: string[];
  segments: Segment[];
}

const transcriptUrl = (name: string, txt = false) =>
  `/admin/api/transcripts/${encodeURIComponent(name)}${txt ? '?format=txt&download=1' : ''}`;

function clock(ms: number | null): string {
  const total = Math.floor((ms ?? 0) / 1000);
  const h = Math.floor(total / 3600);
  const mm = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  const ss = String(total % 60).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

const LANGUAGE_NAMES = typeof Intl !== 'undefined' ? new Intl.DisplayNames(['en'], { type: 'language' }) : null;
const languageName = (code: string) => LANGUAGE_NAMES?.of(code) ?? code;

/** The Transcript column of the recordings table: status, and the action that fits it. */
export function TranscriptCell({
  name,
  state,
  open,
  busy,
  onToggle,
  onRetry,
}: {
  name: string;
  state: TranscriptState | undefined;
  open: boolean;
  busy: boolean;
  onToggle: () => void;
  onRetry: () => void;
}) {
  if (!state) return <span className="transcript-state">Not yet saved</span>;
  switch (state.status) {
    case 'ready':
      return (
        <button type="button" className="key" aria-expanded={open} aria-controls={`transcript-${name}`} onClick={onToggle}>
          <FileText aria-hidden="true" />
          {open ? 'Hide' : 'Transcript'}
        </button>
      );
    case 'transcribing':
      return (
        <span className="transcript-state">
          <Led signal="warn" pulse />
          Transcribing…
        </span>
      );
    case 'failed':
      return (
        <span className="transcript-state transcript-failed" title={state.error}>
          Failed
          <button type="button" className="key" disabled={busy} onClick={onRetry}>
            <RotateCw aria-hidden="true" />
            Retry
          </button>
        </span>
      );
    case 'none':
      return (
        <span className="transcript-state">
          Not transcribed
          <button type="button" className="key" disabled={busy} onClick={onRetry}>
            Transcribe now
          </button>
        </span>
      );
    case 'off':
      return (
        <span className="transcript-state" title="Set SONIOX_API_KEY in token-service/.env to transcribe recordings">
          Off
        </span>
      );
  }
}

/** A recording's transcript, opened under its row: one line per speaker turn, with times. */
export function TranscriptPanel({ name, onClose }: { name: string; onClose: () => void }) {
  const [transcript, setTranscript] = useState<Transcript | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    fetch(transcriptUrl(name), { cache: 'no-store' })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `Could not load the transcript (HTTP ${res.status}).`);
        if (!cancelled) setTranscript(data);
      })
      .catch((err: Error) => !cancelled && setError(err.message));
    return () => {
      cancelled = true;
    };
  }, [name]);

  const speakers = transcript ? new Set(transcript.segments.map((s) => s.speaker).filter(Boolean)).size : 0;
  return (
    <section className="transcript" id={`transcript-${name}`} aria-label={`Transcript of ${name}`}>
      <header className="transcript-head">
        <span className="transcript-meta">
          {transcript
            ? [
                transcript.durationMs !== null && clock(transcript.durationMs),
                speakers && `${speakers} ${speakers === 1 ? 'speaker' : 'speakers'}`,
                transcript.languages.map(languageName).join(', '),
              ]
                .filter(Boolean)
                .join(' · ')
            : error || 'Loading…'}
        </span>
        <a className="key" href={transcriptUrl(name, true)}>
          <Download aria-hidden="true" />
          .txt
        </a>
        <button type="button" className="key key-square" onClick={onClose} aria-label="Close transcript" title="Close">
          <X aria-hidden="true" />
        </button>
      </header>
      {transcript &&
        (transcript.segments.length === 0 ? (
          <p className="empty">No speech in this recording.</p>
        ) : (
          <ol className="transcript-lines">
            {transcript.segments.map((s, i) => (
              <li key={i}>
                <span className="transcript-time mono">{clock(s.startMs)}</span>
                <span className="transcript-speaker">{s.speaker ? `Speaker ${s.speaker}` : 'Speaker'}</span>
                <p lang={s.language ?? undefined}>{s.text}</p>
              </li>
            ))}
          </ol>
        ))}
    </section>
  );
}
