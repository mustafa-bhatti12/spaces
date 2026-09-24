import type { NextRequest } from 'next/server';
import { jsonBody, relayJson } from '@/lib/server/tokenService';

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const egressId = String(body.egressId ?? '').trim();
  if (!egressId) return Response.json({ error: 'egressId is required.' }, { status: 400 });
  return relayJson('/recording/stop', jsonBody({ egressId }));
}
