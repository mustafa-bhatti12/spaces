import type { Metadata, Viewport } from 'next';
import { Hanken_Grotesk, JetBrains_Mono } from 'next/font/google';
import '@livekit/components-styles';
import './globals.css';

// Hanken Grotesk: the device's silkscreen voice (labels, headings, body).
// JetBrains Mono: the status screen — room names, timers, identities, file names, sizes.
const sans = Hanken_Grotesk({ subsets: ['latin'], variable: '--font-sans', display: 'swap' });
const mono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-mono', display: 'swap' });

export const metadata: Metadata = {
  title: 'Space',
  description: 'Self-hosted video calls on LiveKit.',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: '#1b1a18',
  colorScheme: 'dark',
};

export default function RootLayout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body data-lk-theme="default">{children}</body>
    </html>
  );
}
