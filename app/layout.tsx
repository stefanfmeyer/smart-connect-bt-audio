import type { Metadata, Viewport } from 'next';
import { Figtree, Outfit } from 'next/font/google';
import './globals.css';
import './fonts.css';

const figtree = Figtree({
  subsets: ['latin'],
  variable: '--font-figtree',
  display: 'swap',
});

const outfit = Outfit({
  subsets: ['latin'],
  variable: '--font-outfit',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Smart Connect',
  description:
    'Free desktop app for Windows and Linux to control Bluetooth headphones: noise cancelling, equalizer, sound modes and battery. Sennheiser MOMENTUM verified. Not affiliated with Sennheiser or Sonova.',
};

export const viewport: Viewport = {
  themeColor: '#0a0a0a',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${figtree.variable} ${outfit.variable}`}>
      <body>{children}</body>
    </html>
  );
}
