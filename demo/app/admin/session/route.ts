import type { NextRequest } from 'next/server';
import { adminEnabled, hasValidSession } from '@/lib/server/adminSession';

export async function GET(request: NextRequest) {
  return Response.json({ enabled: adminEnabled(), authenticated: hasValidSession(request) });
}
