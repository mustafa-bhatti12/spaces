'use client';

import { useChat, useLocalParticipant } from '@livekit/components-react';
import { X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { initials } from '@/components/ui/Device';

const VISIBLE_MS = 6000;
/** Time left once the pointer leaves the stack, so a card doesn't vanish the moment you look away. */
const RESUME_MS = 2500;
const MAX_STACK = 3;

type ChatToast = { id: string; sender: string; text: string; time: string; expiresAt: number };

/**
 * New-message notifications while the chat panel is closed: a stack of message cards, bottom-right of
 * the stage on desktop and a top banner on phones (CSS). Clicking a card opens the chat.
 */
export function ChatToasts({ chatOpen, onOpenChat }: { chatOpen: boolean; onOpenChat: () => void }) {
  const { chatMessages } = useChat();
  const { localParticipant } = useLocalParticipant();
  const [toasts, setToasts] = useState<ChatToast[]>([]);
  const [paused, setPaused] = useState(false);
  const lastSeenId = useRef<string | undefined>(undefined);

  useEffect(() => {
    const message = chatMessages.at(-1);
    if (!message) return;
    const id = message.id ?? String(message.timestamp);
    if (id === lastSeenId.current) return;
    lastSeenId.current = id;
    if (chatOpen || message.from?.identity === localParticipant.identity) return;

    const text = message.message.trim().replace(/\s+/g, ' ') || 'Sent an attachment';
    const toast: ChatToast = {
      id,
      sender: message.from?.name || message.from?.identity || 'Someone',
      text: text.length > 280 ? `${text.slice(0, 277)}…` : text,
      time: new Date(message.timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
      expiresAt: Date.now() + VISIBLE_MS,
    };
    setToasts((current) => [...current, toast].slice(-MAX_STACK));
  }, [chatMessages, chatOpen, localParticipant.identity]);

  // Opening the chat shows every message, so the notifications have nothing left to say.
  useEffect(() => {
    if (chatOpen) setToasts([]);
  }, [chatOpen]);

  // One timer for the card that expires first; hovering the stack holds all of them.
  useEffect(() => {
    if (paused || toasts.length === 0) return;
    const next = Math.min(...toasts.map((t) => t.expiresAt));
    const timer = setTimeout(() => {
      const now = Date.now();
      setToasts((current) => current.filter((t) => t.expiresAt > now));
    }, Math.max(0, next - Date.now()));
    return () => clearTimeout(timer);
  }, [paused, toasts]);

  const resume = useCallback(() => {
    setPaused(false);
    const at = Date.now() + RESUME_MS;
    setToasts((current) => current.map((t) => ({ ...t, expiresAt: Math.max(t.expiresAt, at) })));
  }, []);

  const dismiss = (id: string) => setToasts((current) => current.filter((t) => t.id !== id));

  return (
    <div
      className="chat-toasts"
      role="region"
      aria-label="New chat messages"
      aria-live="polite"
      onPointerEnter={(e) => e.pointerType === 'mouse' && setPaused(true)}
      onPointerLeave={(e) => e.pointerType === 'mouse' && resume()}
    >
      {toasts.map((t) => (
        <div className="chat-toast" key={t.id}>
          <button type="button" className="chat-toast-open" onClick={onOpenChat} aria-label={`Message from ${t.sender}: ${t.text}. Open chat`}>
            <span className="avatar" aria-hidden="true">
              {initials(t.sender)}
            </span>
            <span className="chat-toast-body">
              <span className="chat-toast-head">
                <span className="chat-toast-name">{t.sender}</span>
                <time className="chat-toast-time">{t.time}</time>
              </span>
              <span className="chat-toast-text">{t.text}</span>
            </span>
          </button>
          <button type="button" className="chat-toast-close" onClick={() => dismiss(t.id)} aria-label="Dismiss">
            <X aria-hidden="true" />
          </button>
        </div>
      ))}
    </div>
  );
}
