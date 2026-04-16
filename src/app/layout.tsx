import '@/styles/globals.css';
import { Topbar } from '@/components/topbar';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'WorkGraph',
  description: 'Your second brain for work',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;450;500;550;600;650;700&display=swap" rel="stylesheet" />
      </head>
      <body>
        <Topbar />
        <main>{children}</main>
      </body>
    </html>
  );
}
