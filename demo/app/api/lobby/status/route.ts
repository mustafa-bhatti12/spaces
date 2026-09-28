import type { NextRequest } from 'next/server';
import { relayJson } from '@/lib/server/tokenService';

// A waiting guest's poll. Once admitted, the response carries their join details (never as host).
export async function GET(request: NextRequest) {
  const id = String(request.nextUrl.searchParams.get('id') ?? '');
  if (!id) return Response.json({ error: 'id is required.' }, { status: 400 });
  const res = await relayJson(`/lobby/status?id=${encodeURIComponent(id)}`);
  if (!res.ok) return res;
  const data = await res.json();
  return Response.json(data.status === 'admitted' ? { ...data, host: false } : data);
}
