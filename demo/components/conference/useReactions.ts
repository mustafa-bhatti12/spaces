'use client';

import { useDataChannel } from '@livekit/components-react';
import { useCallback, useRef, useState } from 'react';

export const REACTION_EMOJIS = ['👍', '👏', '❤️', '😂', '😮', '🎉'];
const TOPIC = 'reactions';
const FLOAT_MS = 3200;

export interface FloatingReaction {
  id: number;
  emoji: string;
  from: string;
  left: number; // percent across the stage
}

/** Emoji reactions: broadcast on a data topic, shown as floating emoji for everyone (incl. sender). */
export function useReactions() {
  const [reactions, setReactions] = useState<FloatingReaction[]>([]);
  const nextId = useRef(0);

  const show = useCallback((emoji: string, from: string) => {
    if (!REACTION_EMOJIS.includes(emoji)) return; // ignore anything a client didn't pick from the menu
    const reaction = { id: nextId.current++, emoji, from, left: 8 + Math.random() * 84 };
    setReactions((current) => [...current.slice(-30), reaction]);
    setTimeout(() => setReactions((current) => current.filter((r) => r.id !== reaction.id)), FLOAT_MS);
  }, []);

  const { send } = useDataChannel(TOPIC, (msg) => {
    const emoji = new TextDecoder().decode(msg.payload);
    show(emoji, msg.from?.name || msg.from?.identity || 'Someone');
  });

  const react = useCallback(
    async (emoji: string) => {
      show(emoji, 'You');
      await send(new TextEncoder().encode(emoji), { reliable: false });
    },
    [send, show],
  );

  return { reactions, react };
}
