import type { Metadata, Viewport } from 'next';
import Script from 'next/script';
import { Hanken_Grotesk, JetBrains_Mono } from 'next/font/google';
import '@livekit/components-styles';
import './globals.css';

// Hanken Grotesk: the device's silkscreen voice (labels, headings, body).
// JetBrains Mono: the status screen — room names, timers, identities, file names, sizes.
const sans = Hanken_Grotesk({ subsets: ['latin'], variable: '--font-sans', display: 'swap' });
const mono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-mono', display: 'swap' });

export const metadata: Metadata = {
  title: 'Spaces',
  description: 'Self-hosted video calls on LiveKit.',
  icons: {
    icon: [
      { url: '/icon.svg', type: 'image/svg+xml' },
      { url: '/favicon.ico', sizes: 'any' },
    ],
    apple: [
      { url: '/apple-touch-icon.png', sizes: '180x180' },
    ],
  },
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  interactiveWidget: 'resizes-visual',
  themeColor: '#1b1a18',
  colorScheme: 'dark',
};

// Production browsers get a silent console: livekit-client, LiveKit components and MediaPipe's wasm
// all log to it (connection states, per-call WebRTC stats, GL info). Logging belongs on the server.
// It runs before any Next.js module, so libraries that bind console methods at load get the no-ops.
// `localStorage.setItem('spaces-debug', '1')` + reload brings the console back for debugging.
const MUTE_CONSOLE = `(function(){try{if(localStorage.getItem('spaces-debug')==='1')return}catch(e){}var n=function(){};['log','info','debug','warn','error','trace','table','dir','dirxml','group','groupCollapsed','groupEnd','time','timeEnd','timeLog','count','countReset','assert'].forEach(function(k){console[k]=n})})()`;

export default function RootLayout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body data-lk-theme="default">
        {process.env.NODE_ENV === 'production' && (
          <Script id="mute-console" strategy="beforeInteractive">
            {MUTE_CONSOLE}
          </Script>
        )}
        {children}
      </body>
    </html>
  );
}
