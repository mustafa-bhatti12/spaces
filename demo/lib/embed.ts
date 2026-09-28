export const EMBED_PROTOCOL = 'spaces-embed/1';
export const APP_TOPIC_PREFIX = 'app.';
export const MAX_PAYLOAD_BYTES = 4096;

export type ShareSurface = 'browser' | 'window' | 'monitor' | 'unknown';
export type EmbedEvent =
  | { type: 'ready' }
  | { type: 'joined'; room: string; identity: string }
  | { type: 'left'; reason: string }
  | { type: 'recording'; active: boolean }
  | { type: 'screenshare'; active: boolean; surface: ShareSurface }
  | { type: 'data'; topic: string; payload: unknown; from: string; fromHost: boolean };
export type ParentCommand = { type: 'send'; topic: string; payload: unknown; to: 'all' | 'hosts' };

/** EMBED_ALLOWED_ORIGINS: comma-separated exact origins (scheme://host[:port]) allowed to frame /embed. */
export function parseAllowedOrigins(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter((o) => {
      try {
        return new URL(o).origin === o;
      } catch {
        return false;
      }
    });
}

export function parseParentCommand(data: unknown): ParentCommand | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  if (d.protocol !== EMBED_PROTOCOL || d.type !== 'send') return null;
  if (typeof d.topic !== 'string' || !d.topic.startsWith(APP_TOPIC_PREFIX) || d.topic.length > 100) return null;
  if (d.to !== 'all' && d.to !== 'hosts') return null;
  const json = JSON.stringify(d.payload ?? null);
  if (new TextEncoder().encode(json).length > MAX_PAYLOAD_BYTES) return null;
  return { type: 'send', topic: d.topic, payload: d.payload ?? null, to: d.to };
}
