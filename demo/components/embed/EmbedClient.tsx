'use client';

import type { LocalUserChoices } from '@livekit/components-react';
import dynamic from 'next/dynamic';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EMBED_PROTOCOL, type EmbedEvent, type ParentCommand, parseParentCommand } from '@/lib/embed';
import { previewErrorMessage } from '@/lib/client/prejoinGuidance';
import { PreJoin } from '../PreJoin';
import type { CallSettings } from '@/lib/callSettings';
import type { ConnectionDetails, LeaveReason } from '../conference/types';
import { Wordmark } from '../ui/Device';
import { EmbedContext, type EmbedApi } from './EmbedContext';

const Conference = dynamic(() => import('../conference/Conference').then((m) => m.Conference), { ssr: false });
const EmbedBridge = dynamic(() => import('./EmbedBridge').then((m) => m.EmbedBridge), { ssr: false });

interface Session { room: string; identity: string; name: string; serverUrl: string; token: string; callSettings?: CallSettings }
type Stage =
  | { kind: 'checking' }
  | { kind: 'invalid'; message: string }
  | { kind: 'refreshing' }
  | { kind: 'prejoin'; error?: string }
  | { kind: 'in-call'; choices: LocalUserChoices }
  | { kind: 'ended'; reason: LeaveReason };

export function EmbedClient({ parentOrigin }: { parentOrigin: string | null }) {
  const [session, setSession] = useState<Session | null>(null);
  const [stage, setStage] = useState<Stage>({ kind: 'checking' });
  const listeners = useRef(new Set<(c: ParentCommand) => void>());
  const framed = typeof window !== 'undefined' && window.parent !== window;
  const prejoinLink = useMemo(() => {
    if (!session || typeof window === 'undefined') return undefined;
    const url = new URL(window.location.href);
    url.hash = new URLSearchParams({ t: session.token }).toString();
    return url.href;
  }, [session]);

  const api = useMemo<EmbedApi>(() => ({
    post: (event: EmbedEvent) => {
      if (framed && parentOrigin) window.parent.postMessage({ protocol: EMBED_PROTOCOL, ...event }, parentOrigin);
    },
    onCommand: (fn) => {
      listeners.current.add(fn);
      return () => listeners.current.delete(fn);
    },
  }), [framed, parentOrigin]);

  useEffect(() => {
    if (!framed || !parentOrigin) return;
    const onMessage = (e: MessageEvent) => {
      if (e.source !== window.parent || e.origin !== parentOrigin) return;
      const command = parseParentCommand(e.data);
      if (command) listeners.current.forEach((fn) => fn(command));
    };
    window.addEventListener('message', onMessage);
    api.post({ type: 'ready' });
    return () => window.removeEventListener('message', onMessage);
  }, [api, framed, parentOrigin]);

  // The token arrives in the fragment (never sent to a server); drop it from the address bar at once.
  useEffect(() => {
    const token = new URLSearchParams(window.location.hash.slice(1)).get('t') ?? '';
    history.replaceState(null, '', window.location.pathname + window.location.search);
    if (!token) {
      setStage({ kind: 'invalid', message: 'This call link is missing its access token.' });
      return;
    }
    const ctrl = new AbortController();
    fetch('/api/embed/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
      signal: ctrl.signal,
    })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (res.status === 401) api.post({ type: 'expired' });
        if (!res.ok) throw new Error(data.error || `Could not open the call (HTTP ${res.status}).`);
        setSession({ ...data, token });
        setStage({ kind: 'prejoin' });
      })
      .catch((err: Error) => err.name !== 'AbortError' && setStage({ kind: 'invalid', message: err.message }));
    return () => ctrl.abort();
  }, [api]);

  const handleLeave = useCallback((reason: LeaveReason) => {
    setStage({ kind: 'ended', reason });
    api.post({ type: 'left', reason: reason.kind });
  }, [api]);
  // Embedded, Rejoin always asks the page around us for a fresh token (`expired`; it remounts this
  // frame), so the consumer's /token sets up the room again: if the call was ended or closed, the
  // old token would join a new, empty room. Opened on its own there's nobody to ask, so check
  // the old token instead (its room seed still restores the host and a required recording).
  const handleRejoin = useCallback(async () => {
    if (!session) return;
    if (framed && parentOrigin) {
      setStage({ kind: 'refreshing' });
      api.post({ type: 'expired' });
      return;
    }
    const res = await fetch('/api/embed/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: session.token }),
    }).catch(() => null);
    if (res?.status === 401) {
      setStage({ kind: 'invalid', message: 'This call link has expired.' });
      return;
    }
    setStage({ kind: 'prejoin' });
  }, [api, framed, parentOrigin, session]);
  const handlePreviewError = useCallback((err: Error) => setStage({ kind: 'prejoin', error: previewErrorMessage(err, navigator.userAgent, navigator.maxTouchPoints) }), []);
  const details = useMemo<ConnectionDetails | null>(
    () => session && { serverUrl: session.serverUrl, roomName: session.room, participantName: session.name, participantToken: session.token, callSettings: session.callSettings },
    [session],
  );

  let body: ReactNode;
  if (stage.kind === 'in-call' && session && details) {
    body = (
      <Conference roomName={session.room} details={details} choices={stage.choices} identity={session.identity} onLeave={handleLeave}>
        <EmbedBridge />
      </Conference>
    );
  } else if (stage.kind === 'prejoin' && session) {
    body = (
      <main className="prejoin-page">
        <header className="page-top"><Wordmark /></header>
        <div className="prejoin-grid">
          <div className="prejoin-head"><h1 className="title">Ready to join?</h1></div>
          <PreJoin defaults={{}} lockedName={session.name} joinLabel="Join call" userLabel="" busy={false}
            onSubmit={(choices) => setStage({ kind: 'in-call', choices })} onError={handlePreviewError} copyLink={prejoinLink} />
          <p className="prejoin-error note note-alert" role="alert" hidden={!stage.error}>{stage.error}</p>
        </div>
      </main>
    );
  } else {
    const title = stage.kind === 'ended' ? 'You left the call' : stage.kind === 'invalid' ? 'This call link has expired' : stage.kind === 'refreshing' ? 'Rejoining…' : 'Opening the call…';
    const text = stage.kind === 'refreshing' ? 'Getting a fresh link…' : stage.kind === 'invalid' ? (framed && parentOrigin ? 'Getting a fresh link…' : `${stage.message} Reopen the call from the page that sent you here.`) : stage.kind === 'ended' ? (framed ? 'You can rejoin below.' : 'You can close this tab.') : '';
    body = (
      <main className="end-screen">
        <header className="page-top"><Wordmark /></header>
        <section className="face end-face">
          <h1 className="title">{title}</h1>
          {text && <p className="lede">{text}</p>}
          {stage.kind === 'ended' && session && (
            <div className="end-actions"><button type="button" className="key key-go" onClick={handleRejoin}>Rejoin</button></div>
          )}
        </section>
      </main>
    );
  }
  return <EmbedContext.Provider value={api}>{body}</EmbedContext.Provider>;
}
