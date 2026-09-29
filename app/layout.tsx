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
  title: 'Smart Connect for Sennheiser',
  description:
    'Unofficial web control for Sennheiser headphones over Web Bluetooth: noise control, EQ and profiles. Not affiliated with Sennheiser or Sonova.',
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
