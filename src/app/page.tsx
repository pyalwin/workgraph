import Link from 'next/link';
import { withAuth } from '@workos-inc/authkit-nextjs';

export const dynamic = 'force-dynamic';

export default async function LandingPage() {
  const { user } = await withAuth();
  const ctaHref = user ? '/dashboard' : '/sign-in';
  const ctaLabel = user ? 'Open dashboard' : 'Sign in';

  return (
    <main className="landing">
      <div className="landing-grain" aria-hidden="true" />

      <header className="landing-nav">
        <Link href="/" className="landing-brand">
          <span className="landing-brand-mark">W</span>
          <span className="landing-brand-name">WorkGraph</span>
        </Link>
        <nav className="landing-nav-links">
          <a href="https://github.com/pyalwin/workgraph" target="_blank" rel="noopener noreferrer">
            GitHub
          </a>
          <a href="#how" className="landing-nav-anchor">
            How it works
          </a>
          <Link href={ctaHref} className="landing-nav-cta">
            {ctaLabel}
          </Link>
        </nav>
      </header>

      <section className="landing-hero">
        <div className="landing-hero-text">
          <p className="landing-eyebrow">
            <span className="landing-pill-dot" /> Open source · MIT licensed · v0.1
          </p>
          <h1 className="landing-title">
            Your work, finally
            <br />
            <em className="landing-title-em">connected.</em>
          </h1>
          <p className="landing-lede">
            WorkGraph stitches scattered tickets, docs, meetings, and chat back into the
            thing they actually were — one piece of work. Local-first. Bring your own AI.
            Yours to fork.
          </p>
          <div className="landing-cta-row">
            <Link href={ctaHref} className="landing-cta-primary">
              {ctaLabel}
              <span aria-hidden="true">→</span>
            </Link>
            <a
              href="https://github.com/pyalwin/workgraph#quickstart"
              className="landing-cta-secondary"
              target="_blank"
              rel="noopener noreferrer"
            >
              Read the quickstart
            </a>
          </div>
        </div>

        <div className="landing-hero-art" aria-hidden="true">
          <GraphArt />
        </div>
      </section>

      <section className="landing-how" id="how">
        <p className="landing-section-eyebrow">How it works</p>
        <h2 className="landing-section-title">Three steps from chaos to clarity.</h2>

        <ol className="landing-steps">
          <li>
            <span className="landing-step-num">01</span>
            <h3>Connect</h3>
            <p>
              OAuth into Jira, Notion, Slack, GitHub, Granola, and seven more. Tokens
              encrypted at rest, never leave your laptop.
            </p>
          </li>
          <li>
            <span className="landing-step-num">02</span>
            <h3>Stitch</h3>
            <p>
              Items are linked by issue keys, URL matches, title similarity, and vector
              neighbors. A meeting transcript finds the ticket it was about.
            </p>
          </li>
          <li>
            <span className="landing-step-num">03</span>
            <h3>Surface</h3>
            <p>
              Workstreams, decisions, projects, and metrics — narrated by your AI provider
              of choice. Pan the knowledge graph. Ask anything.
            </p>
          </li>
        </ol>
      </section>

      <section className="landing-features">
        <p className="landing-section-eyebrow">Built different</p>
        <h2 className="landing-section-title">No cloud. No lock-in. No surprises.</h2>

        <div className="landing-feature-grid">
          <article className="landing-card">
            <span className="landing-card-tag">11</span>
            <h3>Multi-source ingest</h3>
            <p>
              Jira, Confluence, Notion, Slack, GitHub, GitLab, Linear, Granola, Google
              Calendar/Drive, Microsoft Teams. Adding a new source is one adapter file.
            </p>
          </article>
          <article className="landing-card">
            <span className="landing-card-tag">∞</span>
            <h3>Knowledge graph</h3>
            <p>
              A force-directed network of items and links. Filter by source, type, goal,
              or workstream. Click any node to see its full thread.
            </p>
          </article>
          <article className="landing-card">
            <span className="landing-card-tag">AI</span>
            <h3>Bring your own model</h3>
            <p>
              Vercel AI SDK under the hood. Default routes through OpenRouter; switch to
              Anthropic, OpenAI, Google, or local Ollama with one settings change.
            </p>
          </article>
          <article className="landing-card">
            <span className="landing-card-tag">.db</span>
            <h3>Local-first by design</h3>
            <p>
              SQLite + sqlite-vec. OAuth tokens encrypted with your secret. No analytics,
              no telemetry. Your database is a single file you can pick up and move.
            </p>
          </article>
        </div>
      </section>

      <section className="landing-final">
        <h2>Ship the truth, not the chase.</h2>
        <p>
          Stop reconstructing context across a dozen tabs. Stop pretending the Jira board
          tells the whole story. Run WorkGraph on your machine and see the work as it
          actually moves.
        </p>
        <Link href={ctaHref} className="landing-cta-primary landing-cta-final">
          {ctaLabel}
          <span aria-hidden="true">→</span>
        </Link>
      </section>

      <footer className="landing-foot">
        <span className="landing-foot-brand">
          <span className="landing-brand-mark landing-brand-mark-sm">W</span>
          WorkGraph
        </span>
        <span className="landing-foot-meta">
          MIT licensed ·{' '}
          <a href="https://github.com/pyalwin" target="_blank" rel="noopener noreferrer">
            Arun Venkataramanan
          </a>{' '}
          ·{' '}
          <a href="https://github.com/pyalwin/workgraph" target="_blank" rel="noopener noreferrer">
            github.com/pyalwin/workgraph
          </a>
        </span>
      </footer>
    </main>
  );
}

/* Decorative SVG — small knowledge graph for the hero. */
function GraphArt() {
  // Hand-placed nodes for a balanced, deliberate composition.
  const nodes: Array<{ x: number; y: number; r: number; accent?: boolean }> = [
    { x: 240, y: 60, r: 5 },
    { x: 320, y: 130, r: 7, accent: true },
    { x: 180, y: 170, r: 4 },
    { x: 90, y: 110, r: 4 },
    { x: 50, y: 220, r: 5 },
    { x: 150, y: 270, r: 4 },
    { x: 270, y: 240, r: 6 },
    { x: 360, y: 200, r: 5 },
    { x: 380, y: 300, r: 4 },
    { x: 210, y: 340, r: 5 },
  ];
  const edges: Array<[number, number]> = [
    [0, 1], [0, 2], [1, 2], [1, 7], [2, 3], [2, 5],
    [3, 4], [4, 5], [5, 6], [6, 7], [6, 8], [6, 9],
    [7, 8], [9, 5], [1, 6], [3, 0],
  ];

  return (
    <svg viewBox="0 0 420 380" className="landing-graph-svg" role="img" aria-hidden="true">
      <g className="landing-graph-edges">
        {edges.map(([a, b], i) => (
          <line
            key={i}
            x1={nodes[a].x}
            y1={nodes[a].y}
            x2={nodes[b].x}
            y2={nodes[b].y}
          />
        ))}
      </g>
      <g className="landing-graph-nodes">
        {nodes.map((n, i) => (
          <circle
            key={i}
            cx={n.x}
            cy={n.y}
            r={n.r}
            className={n.accent ? 'accent' : ''}
            style={{ animationDelay: `${i * 0.12}s` }}
          />
        ))}
      </g>
    </svg>
  );
}
