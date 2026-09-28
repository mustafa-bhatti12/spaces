'use client';

import type { LocalUserChoices } from '@livekit/components-react';
import dynamic from 'next/dynamic';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EMBED_PROTOCOL, type EmbedEvent, type ParentCommand, parseParentCommand } from '@/lib/embed';
import { PreJoin } from '../PreJoin';
import type { ConnectionDetails, LeaveReason } from '../conference/types';
import { Wordmark } from '../ui/Device';
import { EmbedContext, type EmbedApi } from './EmbedContext';

const Conference = dynamic(() => import('../conference/Conference').then((m) => m.Conference), { ssr: false });
const EmbedBridge = dynamic(() => import('./EmbedBridge').then((m) => m.EmbedBridge), { ssr: false });

interface Session { room: string; identity: string; name: string; serverUrl: string; token: string }
type Stage =
  | { kind: 'checking' }
  | { kind: 'invalid'; message: string }
  | { kind: 'prejoin'; error?: string }
  | { kind: 'in-call'; choices: LocalUserChoices }
  | { kind: 'ended'; reason: LeaveReason };

export function EmbedClient({ parentOrigin }: { parentOrigin: string | null }) {
  const [session, setSession] = useState<Session | null>(null);
  const [stage, setStage] = useState<Stage>({ kind: 'checking' });
  const listeners = useRef(new Set<(c: ParentCommand) => void>());
  const framed = typeof window !== 'undefined' && window.parent !== window;

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
        if (!res.ok) throw new Error(data.error || `Could not open the call (HTTP ${res.status}).`);
        setSession({ ...data, token });
        setStage({ kind: 'prejoin' });
      })
      .catch((err: Error) => err.name !== 'AbortError' && setStage({ kind: 'invalid', message: err.message }));
    return () => ctrl.abort();
  }, []);

  const handleLeave = useCallback((reason: LeaveReason) => {
    setStage({ kind: 'ended', reason });
    api.post({ type: 'left', reason: reason.kind });
  }, [api]);
  const handlePreviewError = useCallback((err: Error) => setStage({ kind: 'prejoin', error: err.message }), []);
  const details = useMemo<ConnectionDetails | null>(
    () => session && { serverUrl: session.serverUrl, roomName: session.room, participantName: session.name, participantToken: session.token },
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
            onSubmit={(choices) => setStage({ kind: 'in-call', choices })} onError={handlePreviewError} />
          <p className="prejoin-error note note-alert" role="alert" hidden={!stage.error}>{stage.error}</p>
        </div>
      </main>
    );
  } else {
    const title = stage.kind === 'ended' ? 'You left the call' : stage.kind === 'invalid' ? 'This call link has expired' : 'Opening the call…';
    const text = stage.kind === 'invalid' ? `${stage.message} Reopen the call from the page that sent you here.` : stage.kind === 'ended' ? (framed ? 'You can rejoin below.' : 'You can close this tab.') : '';
    body = (
      <main className="end-screen">
        <header className="page-top"><Wordmark /></header>
        <section className="face end-face">
          <h1 className="title">{title}</h1>
          {text && <p className="lede">{text}</p>}
          {stage.kind === 'ended' && session && (
            <div className="end-actions"><button type="button" className="key key-go" onClick={() => setStage({ kind: 'prejoin' })}>Rejoin</button></div>
          )}
        </section>
      </main>
    );
  }
  return <EmbedContext.Provider value={api}>{body}</EmbedContext.Provider>;
}
