import { NextResponse } from 'next/server';
import { parseAllowedOrigins } from '@/lib/embed';

// Only /embed may be framed, and only by EMBED_ALLOWED_ORIGINS.
export function proxy() {
  const res = NextResponse.next();
  const origins = parseAllowedOrigins(process.env.EMBED_ALLOWED_ORIGINS);
  res.headers.set('Content-Security-Policy', `frame-ancestors 'self' ${origins.join(' ')}`.trim());
  return res;
}

export const config = { matcher: ['/embed'] };
