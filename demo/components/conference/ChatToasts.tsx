'use client';

import { useChat, useLocalParticipant, useRoomContext } from '@livekit/components-react';
import type { RemoteParticipant } from 'livekit-client';
import { RoomEvent } from 'livekit-client';
import { X } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { initials } from '@/components/ui/Device';

const CHAT_VISIBLE_MS = 6000;
const JOIN_VISIBLE_MS = 4000;
/** Time left once the pointer leaves the stack, so a card doesn't vanish the moment you look away. */
const RESUME_MS = 2500;
/** Matches `.chat-toast[data-leaving]`'s transition: how long a card plays its exit before unmounting. */
const EXIT_MS = 180;
const MAX_STACK = 3;
/** Participants already in the room when we connect aren't news; only later arrivals get a toast. */
const JOIN_QUIET_MS = 2000;

type Notice = {
  id: string;
  kind: 'chat' | 'joined';
  sender: string;
  text: string;
  time: string;
  expiresAt: number;
  leaving?: boolean;
};

const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

/**
 * The call's notification stack: new chat messages (while the chat panel is closed) and people
 * joining. Bottom-right of the stage on desktop, a top banner on phones (CSS). Clicking a message
 * opens the chat; clicking a join opens People. `lead` sits in the same stack ahead of them (the
 * host's waiting-room notice), so the two never overlap. Cards leave the way they came in.
 */
export function ChatToasts({
  chatOpen,
  onOpenChat,
  onOpenPeople,
  lead,
}: {
  chatOpen: boolean;
  onOpenChat: () => void;
  onOpenPeople: () => void;
  lead?: ReactNode;
}) {
  const room = useRoomContext();
  const { chatMessages } = useChat();
  const { localParticipant } = useLocalParticipant();
  const [notices, setNotices] = useState<Notice[]>([]);
  const [paused, setPaused] = useState(false);
  const lastSeenId = useRef<string | undefined>(undefined);

  const push = useCallback((notice: Notice) => {
    setNotices((current) => [...current.filter((n) => n.id !== notice.id), notice].slice(-MAX_STACK));
  }, []);

  // Marks cards as leaving (they play their exit), then drops them.
  const remove = useCallback((match: (n: Notice) => boolean) => {
    setNotices((current) => current.map((n) => (match(n) ? { ...n, leaving: true } : n)));
    setTimeout(() => setNotices((current) => current.filter((n) => !(n.leaving && match(n)))), EXIT_MS);
  }, []);

  useEffect(() => {
    const message = chatMessages.at(-1);
    if (!message) return;
    const id = message.id ?? String(message.timestamp);
    if (id === lastSeenId.current) return;
    lastSeenId.current = id;
    if (chatOpen || message.from?.identity === localParticipant.identity) return;

    const text = message.message.trim().replace(/\s+/g, ' ') || 'Sent an attachment';
    push({
      id: `chat-${id}`,
      kind: 'chat',
      sender: message.from?.name || message.from?.identity || 'Someone',
      text: text.length > 280 ? `${text.slice(0, 277)}…` : text,
      time: clock(message.timestamp),
      expiresAt: Date.now() + CHAT_VISIBLE_MS,
    });
  }, [chatMessages, chatOpen, localParticipant.identity, push]);

  useEffect(() => {
    const quietUntil = Date.now() + JOIN_QUIET_MS;
    const onJoined = (p: RemoteParticipant) => {
      if (Date.now() < quietUntil) return;
      push({
        id: `join-${p.identity}-${Date.now()}`,
        kind: 'joined',
        sender: p.name || p.identity,
        text: 'Joined the call',
        time: clock(Date.now()),
        expiresAt: Date.now() + JOIN_VISIBLE_MS,
      });
    };
    room.on(RoomEvent.ParticipantConnected, onJoined);
    return () => {
      room.off(RoomEvent.ParticipantConnected, onJoined);
    };
  }, [room, push]);

  // Opening the chat shows every message, so the message cards have nothing left to say.
  useEffect(() => {
    if (chatOpen) remove((n) => n.kind === 'chat');
  }, [chatOpen, remove]);

  // One timer for the card that expires first; hovering the stack holds all of them.
  useEffect(() => {
    const live = notices.filter((n) => !n.leaving);
    if (paused || live.length === 0) return;
    const next = Math.min(...live.map((n) => n.expiresAt));
    const timer = setTimeout(() => {
      const now = Date.now();
      remove((n) => n.expiresAt <= now);
    }, Math.max(0, next - Date.now()));
    return () => clearTimeout(timer);
  }, [paused, notices, remove]);

  const resume = useCallback(() => {
    setPaused(false);
    const at = Date.now() + RESUME_MS;
    setNotices((current) => current.map((n) => ({ ...n, expiresAt: Math.max(n.expiresAt, at) })));
  }, []);

  return (
    <div
      className="chat-toasts"
      role="region"
      aria-label="Notifications"
      aria-live="polite"
      onPointerEnter={(e) => e.pointerType === 'mouse' && setPaused(true)}
      onPointerLeave={(e) => e.pointerType === 'mouse' && resume()}
    >
      {lead}
      {notices.map((n) => (
        <div className={`chat-toast chat-toast-${n.kind}`} key={n.id} data-leaving={n.leaving || undefined}>
          <button
            type="button"
            className="chat-toast-open"
            onClick={n.kind === 'chat' ? onOpenChat : onOpenPeople}
            aria-label={n.kind === 'chat' ? `Message from ${n.sender}: ${n.text}. Open chat` : `${n.sender} joined the call. Open people`}
          >
            <span className="avatar" aria-hidden="true">
              {initials(n.sender)}
            </span>
            <span className="chat-toast-body">
              <span className="chat-toast-head">
                <span className="chat-toast-name">{n.sender}</span>
                <time className="chat-toast-time">{n.time}</time>
              </span>
              <span className="chat-toast-text">{n.text}</span>
            </span>
          </button>
          <button type="button" className="chat-toast-close" onClick={() => remove((x) => x.id === n.id)} aria-label="Dismiss">
            <X aria-hidden="true" />
          </button>
        </div>
      ))}
    </div>
  );
}
