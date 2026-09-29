import type { NextRequest } from 'next/server';
import { hasValidSession } from '@/lib/server/adminSession';
import { TOKEN_SERVICE_URL } from '@/lib/server/tokenService';
import { parseAllowedOrigins } from '@/lib/embed';

// The call app's own deployment settings (Railway variables) for the Settings tab: read-only, and
// secrets only as set / not set. Changing any of them is a Railway variable change plus redeploy.
export async function GET(request: NextRequest) {
  if (!hasValidSession(request)) return Response.json({ error: 'Not logged in.' }, { status: 401 });
  return Response.json({
    tokenServiceUrl: TOKEN_SERVICE_URL,
    embedAllowedOrigins: parseAllowedOrigins(process.env.EMBED_ALLOWED_ORIGINS),
    trustProxy: process.env.TRUST_PROXY === '1',
    secrets: {
      consumerSecret: !!process.env.TOKEN_SERVICE_SHARED_SECRET,
      adminSecret: !!process.env.ADMIN_SHARED_SECRET,
      adminPassword: !!process.env.ADMIN_PASSWORD,
    },
    commit: process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7) ?? null,
  });
}
