import type { Metadata } from 'next';
import { connection } from 'next/server';
import { EmbedClient } from '@/components/embed/EmbedClient';
import { parseAllowedOrigins } from '@/lib/embed';

export const metadata: Metadata = { title: 'Call · Spaces', robots: { index: false, follow: false } };

export default async function EmbedPage({ searchParams }: PageProps<'/embed'>) {
  await connection(); // read the env at request time, not build time
  const { origin } = await searchParams;
  const allowed = parseAllowedOrigins(process.env.EMBED_ALLOWED_ORIGINS);
  const parentOrigin = typeof origin === 'string' && allowed.includes(origin) ? origin : null;
  return <EmbedClient parentOrigin={parentOrigin} />;
}
