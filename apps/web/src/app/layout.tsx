import type { Metadata, Viewport } from 'next';
import { site } from '@/config/site';
import './globals.css';

export const metadata: Metadata = {
  title: { default: site.name, template: `%s — ${site.name}` },
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#1b2662',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ar-SA" dir="rtl">
      <body className="font-sans antialiased">{children}</body>
    </html>
  );
}
