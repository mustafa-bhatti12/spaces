import type { Metadata } from 'next';
import { RoomClient } from '@/components/RoomClient';
import { normalizeRoomName } from '@/lib/room';

export async function generateMetadata({ params }: PageProps<'/rooms/[room]'>): Promise<Metadata> {
  const { room } = await params;
  return { title: `${normalizeRoomName(room)} · Space` };
}

export default async function RoomPage({ params }: PageProps<'/rooms/[room]'>) {
  const { room } = await params;
  return <RoomClient roomName={normalizeRoomName(decodeURIComponent(room))} />;
}
