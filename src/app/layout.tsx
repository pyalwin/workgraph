import '@/styles/globals.css';
import { AuthKitProvider } from '@workos-inc/authkit-nextjs/components';
import { withAuth } from '@workos-inc/authkit-nextjs';
import { AxiomWebVitals } from 'next-axiom';
import { Analytics } from '@vercel/analytics/next';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'WorkGraph',
  description: 'Local-first work intelligence — your tickets, docs, meetings, and chat, unified.',
  icons: {
    icon: [
      { url: '/icon.svg', type: 'image/svg+xml' },
      { url: '/favicon.ico', type: 'image/svg+xml' },
    ],
    shortcut: '/icon.svg',
  },
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const auth = await withAuth();
  const { accessToken, ...initialAuth } = auth;

  return (
    <html lang="en" suppressHydrationWarning>
      <body suppressHydrationWarning>
        <AxiomWebVitals />
        <AuthKitProvider initialAuth={initialAuth}>{children}</AuthKitProvider>
        <Analytics />
      </body>
    </html>
  );
}
