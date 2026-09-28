'use client';

import { createContext, useContext } from 'react';
import type { EmbedEvent, ParentCommand } from '@/lib/embed';

export interface EmbedApi {
  post(event: EmbedEvent): void;
  onCommand(fn: (command: ParentCommand) => void): () => void;
}

/** Non-null only on /embed. `post`/`onCommand` are no-ops when there's no allowed parent. */
export const EmbedContext = createContext<EmbedApi | null>(null);
export const useEmbed = () => useContext(EmbedContext);
