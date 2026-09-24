import type { NextRequest } from 'next/server';
import { hasValidSession } from '@/lib/server/adminSession';
import { tokenServiceFetch } from '@/lib/server/tokenService';

// /admin/api/<path> -> token-service /admin/<path> with ADMIN_SHARED_SECRET, for a logged-in
// operator only. Bodies stream both ways, and Range passes through, so recordings can be played and
// seeked in the page without buffering them in this process.
const FORWARDED_RESPONSE_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'content-disposition'];

async function forward(request: NextRequest, ctx: RouteContext<'/admin/api/[...path]'>) {
  if (!hasValidSession(request)) return Response.json({ error: 'Not logged in.' }, { status: 401 });
  const { path } = await ctx.params;
  const headers = new Headers();
  const range = request.headers.get('range');
  if (range) headers.set('Range', range);
  let body: string | undefined;
  if (request.method === 'POST') {
    headers.set('Content-Type', 'application/json');
    body = JSON.stringify(await request.json().catch(() => ({})));
  }
  let upstream: Response;
  try {
    upstream = await tokenServiceFetch(
      `/admin/${path.map(encodeURIComponent).join('/')}${request.nextUrl.search}`,
      { method: request.method, headers, body },
      'admin',
    );
  } catch (err) {
    console.error('token-service admin route unreachable:', err);
    return Response.json({ error: 'Could not reach token-service. Is the droplet up?' }, { status: 502 });
  }
  const responseHeaders = new Headers();
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) responseHeaders.set(name, value);
  }
  return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
}

export const GET = forward;
export const POST = forward;
export const DELETE = forward;
