import Link from 'next/link';
import type { ReactNode } from 'react';

export default function LegalLayout({ children }: { children: ReactNode }) {
  return (
    <main className="legal-page">
      <header className="legal-nav">
        <Link href="/" className="legal-brand">
          <span className="legal-brand-mark">W</span>
          <span>WorkGraph</span>
        </Link>
        <nav className="legal-nav-links">
          <Link href="/privacy">Privacy</Link>
          <Link href="/terms">Terms</Link>
          <Link href="/">Home</Link>
        </nav>
      </header>
      <article className="legal-prose">{children}</article>
    </main>
  );
}
