import type { Metadata, Viewport } from 'next';
import '@livekit/components-styles';
import './globals.css';

export const metadata: Metadata = {
  title: 'Space Meet',
  description: 'Self-hosted video calls on LiveKit.',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: '#111111',
};

export default function RootLayout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en">
      <body data-lk-theme="default">{children}</body>
    </html>
  );
}
