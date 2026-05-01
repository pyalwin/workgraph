import Link from 'next/link';
import { withAuth } from '@workos-inc/authkit-nextjs';

export const dynamic = 'force-dynamic';

export default async function LandingPage() {
  const { user } = await withAuth();
  const ctaHref = user ? '/dashboard' : '/sign-in';
  const ctaLabel = user ? 'Open dashboard' : 'Sign in';

  return (
    <main className="landing">
      <header className="landing-nav">
        <Link href="/" className="landing-brand">
          <span className="landing-brand-mark">W</span>
          <span className="landing-brand-name">WorkGraph</span>
        </Link>
        <nav className="landing-nav-links">
          <a href="https://github.com/pyalwin/workgraph" target="_blank" rel="noopener noreferrer">
            GitHub
          </a>
          <Link href={ctaHref} className="landing-nav-cta">
            {ctaLabel}
          </Link>
        </nav>
      </header>

      <section className="landing-hero">
        <p className="landing-eyebrow">Local-first work intelligence</p>
        <h1 className="landing-title">
          Your tickets, docs, meetings, and chat — <span className="landing-title-em">unified</span>.
        </h1>
        <p className="landing-lede">
          WorkGraph stitches scattered work artifacts back into the thing they actually were:
          one piece of work. Every connector runs against your account. Every byte lives on
          your laptop. The only outbound traffic is to the source APIs you choose and to the
          AI provider you configure.
        </p>
        <div className="landing-cta-row">
          <Link href={ctaHref} className="landing-cta-primary">
            {ctaLabel}
          </Link>
          <a
            href="https://github.com/pyalwin/workgraph#quickstart"
            className="landing-cta-secondary"
            target="_blank"
            rel="noopener noreferrer"
          >
            Quickstart →
          </a>
        </div>
      </section>

      <section className="landing-grid">
        <article className="landing-card">
          <h3>Multi-source ingest</h3>
          <p>
            Eleven connectors out of the box: Jira, Confluence, Notion, Slack, GitHub, GitLab,
            Linear, Granola, Google Calendar/Drive, Microsoft Teams.
          </p>
        </article>
        <article className="landing-card">
          <h3>Cross-referencing</h3>
          <p>
            Items linked by issue keys, URL matches, title similarity, and vector neighbors.
            A meeting transcript automatically connects to the ticket it was about.
          </p>
        </article>
        <article className="landing-card">
          <h3>Knowledge graph</h3>
          <p>
            Pan, zoom, and click through a force-directed network of items and links — filtered
            by source, type, goal, or workstream.
          </p>
        </article>
        <article className="landing-card">
          <h3>BYOAI</h3>
          <p>
            Vercel AI SDK under the hood. Default routes through OpenRouter; switch to Anthropic,
            OpenAI, Google, or Ollama with one settings change.
          </p>
        </article>
        <article className="landing-card">
          <h3>Local-first</h3>
          <p>
            SQLite + sqlite-vec. OAuth tokens encrypted at rest. No analytics, no telemetry,
            no cloud — your database is a single file you can pick up and move.
          </p>
        </article>
        <article className="landing-card">
          <h3>Open source</h3>
          <p>
            MIT licensed, built to be forked. Every line of code is in the repo — audit it,
            extend it, ship your own.
          </p>
        </article>
      </section>

      <footer className="landing-foot">
        <span>
          Built by{' '}
          <a href="https://github.com/pyalwin" target="_blank" rel="noopener noreferrer">
            Arun Venkataramanan
          </a>{' '}
          · MIT licensed
        </span>
        <span>
          <a href="https://github.com/pyalwin/workgraph" target="_blank" rel="noopener noreferrer">
            github.com/pyalwin/workgraph
          </a>
        </span>
      </footer>
    </main>
  );
}
