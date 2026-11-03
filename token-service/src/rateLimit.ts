/**
 * Fixed-window per-app rate limiter, in memory (token-service is one process; a restart resets it).
 * One counter per (app, scope), so a flood of token mints can't starve room creation.
 */
export const WINDOW_MS = 60_000;

export class RateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();

  /** Counts one request. `retryAfterSec` is set when over `limit` for this minute. */
  hit(key: string, limit: number, now = Date.now()): { allowed: true } | { allowed: false; retryAfterSec: number } {
    let w = this.windows.get(key);
    if (!w || now - w.start >= WINDOW_MS) {
      // Drop expired windows as we go so the map can't grow without bound.
      if (this.windows.size > 1000) for (const [k, v] of this.windows) if (now - v.start >= WINDOW_MS) this.windows.delete(k);
      w = { start: now, count: 0 };
      this.windows.set(key, w);
    }
    if (w.count >= limit) return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((w.start + WINDOW_MS - now) / 1000)) };
    w.count++;
    return { allowed: true };
  }
}
