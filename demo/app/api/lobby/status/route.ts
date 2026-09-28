import type { NextRequest } from 'next/server';
import { relayJson } from '@/lib/server/tokenService';

// A waiting guest's poll. Once admitted, the response carries their join details.
export async function GET(request: NextRequest) {
  const id = String(request.nextUrl.searchParams.get('id') ?? '');
  if (!id) return Response.json({ error: 'id is required.' }, { status: 400 });
  return relayJson(`/lobby/status?id=${encodeURIComponent(id)}`);
}
