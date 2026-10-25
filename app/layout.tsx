import './globals.css';
import type { Metadata, Viewport } from 'next';
import { Inter, JetBrains_Mono } from 'next/font/google';
import { RegisterSW } from '@/components/pwa/register-sw';
import { PWAIdentity } from '@/components/pwa/pwa-identity';
import { PwaPrompts } from '@/components/pwa/pwa-prompts';
import { AppProviders } from '@/components/layout/app-providers';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter' });
const mono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-mono-jb' });

export const metadata: Metadata = {
  title: 'KAUSTUBH Trading Platform',
  description: 'Production-grade Kotak Neo trading platform and live data collector',
  manifest: '/manifest.json',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'default',
    title: 'KAUSTUBH',
  },
  icons: {
    icon: [
      { url: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { url: '/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
    apple: [{ url: '/icon-192.png', sizes: '192x192', type: 'image/png' }],
  },
};

export const viewport: Viewport = {
  themeColor: '#F28C28',
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  // Required for edge-to-edge PWA + working safe-area insets on iOS standalone.
  viewportFit: 'cover',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning className={`${inter.variable} ${mono.variable}`}>
      <body className={`${inter.className} font-sans antialiased`}>
        <AppProviders>
          {children}
          <RegisterSW />
          <PwaPrompts />
          <PWAIdentity />
        </AppProviders>
      </body>
    </html>
  );
}
