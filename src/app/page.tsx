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
          <a href="#how" className="landing-nav-anchor">How it works</a>
          <a href="#features" className="landing-nav-anchor">Features</a>
          <a href="https://github.com/pyalwin/workgraph" target="_blank" rel="noopener noreferrer">
            GitHub
          </a>
          <Link href={ctaHref} className="landing-nav-cta">
            {ctaLabel}
          </Link>
        </nav>
      </header>

      {/* ─── Hero ───────────────────────────── */}
      <section className="landing-hero">
        <div className="landing-hero-text">
          <p className="landing-eyebrow">
            <span className="landing-pill-dot" /> Open source · v0.1
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
          <GraphArt density="rich" />
        </div>
      </section>

      {/* ─── Trust strip ────────────────────── */}
      <section className="landing-strip">
        <span className="landing-strip-label">Stitches across</span>
        <ul className="landing-strip-list">
          <li>Jira</li>
          <li>Slack</li>
          <li>Notion</li>
          <li>GitHub</li>
          <li>Granola</li>
          <li>Linear</li>
          <li>Confluence</li>
          <li>GitLab</li>
          <li>Google Drive</li>
          <li>Calendar</li>
          <li>Teams</li>
        </ul>
      </section>

      {/* ─── How it works ───────────────────── */}
      <section className="landing-how" id="how">
        <header className="landing-section-head">
          <p className="landing-section-eyebrow">How it works</p>
          <h2 className="landing-section-title">From chaos to clarity, in three moves.</h2>
        </header>

        <ol className="landing-steps">
          <li className="landing-step">
            <div className="landing-step-art" aria-hidden="true">
              <ScatterArt />
            </div>
            <div className="landing-step-body">
              <span className="landing-step-num">01 · Connect</span>
              <h3>Sources, not silos.</h3>
              <p>
                OAuth in seconds. Tokens encrypted at rest with a key only your machine
                holds. Adding a new source is one adapter file — already merged for the
                eleven biggest.
              </p>
              <ul className="landing-step-chips">
                <li>jira</li>
                <li>notion</li>
                <li>slack</li>
                <li>github</li>
                <li>granola</li>
                <li>+6 more</li>
              </ul>
            </div>
          </li>

          <li className="landing-step landing-step-reverse">
            <div className="landing-step-art" aria-hidden="true">
              <StitchArt />
            </div>
            <div className="landing-step-body">
              <span className="landing-step-num">02 · Stitch</span>
              <h3>Items find their context.</h3>
              <p>
                Issue keys, URL matches, title similarity, vector neighbors. A meeting
                transcript automatically links to the ticket it was about. Decisions
                surface from threads instead of dying in them.
              </p>
              <ul className="landing-step-chips">
                <li>cross-ref</li>
                <li>embed</li>
                <li>classify</li>
                <li>extract</li>
              </ul>
            </div>
          </li>

          <li className="landing-step">
            <div className="landing-step-art" aria-hidden="true">
              <SurfaceArt />
            </div>
            <div className="landing-step-body">
              <span className="landing-step-num">03 · Surface</span>
              <h3>The work, narrated.</h3>
              <p>
                Workstreams, decisions, project pages, metrics — written by your AI of
                choice. Pan a knowledge graph of everything connected. Ask anything, and
                the answer is grounded in your own data.
              </p>
              <ul className="landing-step-chips">
                <li>workstreams</li>
                <li>decisions</li>
                <li>graph</li>
                <li>metrics</li>
              </ul>
            </div>
          </li>
        </ol>
      </section>

      {/* ─── Bento features ─────────────────── */}
      <section className="landing-features" id="features">
        <header className="landing-section-head">
          <p className="landing-section-eyebrow">Built different</p>
          <h2 className="landing-section-title">No cloud. No lock-in. No surprises.</h2>
        </header>

        <div className="landing-bento">
          <article className="landing-card landing-card-feature">
            <div className="landing-card-art" aria-hidden="true">
              <GraphArt density="dense" />
            </div>
            <div className="landing-card-body">
              <span className="landing-card-tag">Graph</span>
              <h3>A force-directed map of your work.</h3>
              <p>
                Every item a node, every reference an edge. Filter by source, type, goal,
                or workstream. Click any node to see the full thread that ended there.
              </p>
            </div>
          </article>

          <article className="landing-card landing-card-stack">
            <span className="landing-card-tag">Local</span>
            <h3>SQLite + sqlite-vec.</h3>
            <p>
              Your database is one file. Pick it up and move it. No analytics, no telemetry,
              no cloud reach-back. Encrypted OAuth tokens at rest.
            </p>
            <code className="landing-card-code">~/.workgraph/workgraph.db</code>
          </article>

          <article className="landing-card landing-card-stack">
            <span className="landing-card-tag">BYOAI</span>
            <h3>Bring your own model.</h3>
            <p>
              Vercel AI SDK under the hood. OpenRouter by default. Anthropic, OpenAI,
              Google, or local Ollama with a single setting change.
            </p>
            <ul className="landing-card-pills">
              <li>OpenRouter</li>
              <li>Anthropic</li>
              <li>OpenAI</li>
              <li>Ollama</li>
            </ul>
          </article>

          <article className="landing-card landing-card-wide">
            <div className="landing-card-wide-text">
              <span className="landing-card-tag">Decisions</span>
              <h3>What was decided. What's still open.</h3>
              <p>
                Decisions are first-class — extracted from threads and meetings, traced
                back to the items that produced them, and surfaced as a single feed of
                what shipped versus what's still up for grabs.
              </p>
            </div>
            <div className="landing-card-wide-art" aria-hidden="true">
              <DecisionArt />
            </div>
          </article>
        </div>
      </section>

      {/* ─── Final CTA ──────────────────────── */}
      <section className="landing-final">
        <div className="landing-final-art" aria-hidden="true">
          <GraphArt density="sparse" />
        </div>
        <div className="landing-final-text">
          <p className="landing-section-eyebrow">Ready when you are</p>
          <h2>Ship the truth, not the chase.</h2>
          <p>
            Stop reconstructing context across a dozen tabs. Run WorkGraph on your machine
            and see the work as it actually moves.
          </p>
          <Link href={ctaHref} className="landing-cta-primary landing-cta-final">
            {ctaLabel}
            <span aria-hidden="true">→</span>
          </Link>
        </div>
      </section>

      <footer className="landing-foot">
        <span className="landing-foot-brand">
          <span className="landing-brand-mark landing-brand-mark-sm">W</span>
          WorkGraph
        </span>
        <span className="landing-foot-meta">
          Built by{' '}
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

/* ───────────────────────────────────────────────────────────────
 * Decorative SVGs — same hand-drawn graph language across sections
 * Monochrome ink + a single amber accent. No emoji, no clipart.
 * ──────────────────────────────────────────────────────────── */

interface GraphProps {
  density?: 'sparse' | 'rich' | 'dense';
}

function GraphArt({ density = 'rich' }: GraphProps) {
  const presets = {
    sparse: {
      nodes: [
        { x: 60, y: 80, r: 4 },
        { x: 180, y: 50, r: 5, accent: true },
        { x: 130, y: 150, r: 5 },
        { x: 250, y: 130, r: 4 },
        { x: 320, y: 200, r: 5 },
      ],
      edges: [[0, 2], [1, 2], [1, 3], [3, 4], [2, 4]],
    },
    rich: {
      nodes: [
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
      ],
      edges: [
        [0, 1], [0, 2], [1, 2], [1, 7], [2, 3], [2, 5],
        [3, 4], [4, 5], [5, 6], [6, 7], [6, 8], [6, 9],
        [7, 8], [9, 5], [1, 6], [3, 0],
      ],
    },
    dense: {
      nodes: [
        { x: 100, y: 60, r: 4 },
        { x: 200, y: 50, r: 5, accent: true },
        { x: 280, y: 90, r: 4 },
        { x: 60, y: 130, r: 5 },
        { x: 160, y: 130, r: 4 },
        { x: 220, y: 160, r: 6 },
        { x: 320, y: 160, r: 4 },
        { x: 110, y: 210, r: 5 },
        { x: 200, y: 230, r: 4 },
        { x: 280, y: 240, r: 5 },
        { x: 60, y: 280, r: 4 },
        { x: 170, y: 300, r: 5 },
        { x: 250, y: 310, r: 4 },
        { x: 330, y: 290, r: 4 },
      ],
      edges: [
        [0, 1], [1, 2], [0, 3], [0, 4], [1, 4], [1, 5], [2, 5], [2, 6],
        [3, 4], [4, 5], [5, 6], [3, 7], [4, 7], [5, 8], [6, 9], [7, 8],
        [8, 9], [7, 10], [8, 11], [9, 12], [9, 13], [10, 11], [11, 12],
        [12, 13], [5, 11],
      ],
    },
  };

  const { nodes, edges } = presets[density];
  const view = density === 'dense' ? '0 0 400 360' : '0 0 420 380';

  return (
    <svg viewBox={view} className="landing-graph-svg" role="img" aria-hidden="true">
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
            className={'accent' in n && n.accent ? 'accent' : ''}
            style={{ animationDelay: `${i * 0.12}s` }}
          />
        ))}
      </g>
    </svg>
  );
}

/* Step 1 — scattered nodes, no connections yet. */
function ScatterArt() {
  const dots = [
    { x: 30, y: 40, r: 6 },
    { x: 110, y: 25, r: 5 },
    { x: 170, y: 70, r: 4 },
    { x: 60, y: 100, r: 5 },
    { x: 130, y: 140, r: 6 },
    { x: 30, y: 160, r: 4 },
    { x: 200, y: 130, r: 5 },
    { x: 100, y: 180, r: 5 },
    { x: 175, y: 175, r: 4 },
    { x: 50, y: 60, r: 4 },
  ];
  return (
    <svg viewBox="0 0 230 200" className="landing-step-svg" aria-hidden="true">
      {dots.map((d, i) => (
        <circle key={i} cx={d.x} cy={d.y} r={d.r} className="step-dot" />
      ))}
    </svg>
  );
}

/* Step 2 — clusters being linked. */
function StitchArt() {
  const nodes = [
    { x: 40, y: 50, r: 5 },
    { x: 90, y: 30, r: 4 },
    { x: 80, y: 90, r: 5 },
    { x: 160, y: 60, r: 5, accent: true },
    { x: 200, y: 110, r: 4 },
    { x: 150, y: 140, r: 5 },
    { x: 60, y: 160, r: 5 },
    { x: 110, y: 180, r: 4 },
    { x: 190, y: 175, r: 5 },
  ];
  const edges: Array<[number, number]> = [
    [0, 1], [0, 2], [1, 2],
    [3, 4], [3, 5], [4, 5],
    [6, 7], [7, 8],
    [2, 3], [5, 7], [4, 8],
  ];
  return (
    <svg viewBox="0 0 230 220" className="landing-step-svg" aria-hidden="true">
      {edges.map(([a, b], i) => (
        <line
          key={i}
          x1={nodes[a].x}
          y1={nodes[a].y}
          x2={nodes[b].x}
          y2={nodes[b].y}
          className="step-edge"
        />
      ))}
      {nodes.map((n, i) => (
        <circle
          key={i}
          cx={n.x}
          cy={n.y}
          r={n.r}
          className={`step-dot ${n.accent ? 'accent' : ''}`}
        />
      ))}
    </svg>
  );
}

/* Step 3 — full graph with one node highlighted, surfacing context. */
function SurfaceArt() {
  return (
    <svg viewBox="0 0 230 220" className="landing-step-svg" aria-hidden="true">
      <defs>
        <radialGradient id="surfaceHalo" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#d97757" stopOpacity="0.25" />
          <stop offset="100%" stopColor="#d97757" stopOpacity="0" />
        </radialGradient>
      </defs>
      <g className="step-edge-group">
        <line x1="40" y1="50" x2="90" y2="30" />
        <line x1="40" y1="50" x2="80" y2="90" />
        <line x1="80" y1="90" x2="120" y2="105" />
        <line x1="120" y1="105" x2="160" y2="60" />
        <line x1="120" y1="105" x2="200" y2="110" />
        <line x1="120" y1="105" x2="150" y2="140" />
        <line x1="60" y1="160" x2="80" y2="90" />
        <line x1="60" y1="160" x2="110" y2="180" />
        <line x1="190" y1="175" x2="150" y2="140" />
      </g>
      <circle cx="120" cy="105" r="32" fill="url(#surfaceHalo)" />
      {[
        { x: 40, y: 50, r: 5 },
        { x: 90, y: 30, r: 4 },
        { x: 80, y: 90, r: 5 },
        { x: 160, y: 60, r: 5 },
        { x: 200, y: 110, r: 4 },
        { x: 150, y: 140, r: 4 },
        { x: 60, y: 160, r: 5 },
        { x: 110, y: 180, r: 4 },
        { x: 190, y: 175, r: 4 },
      ].map((n, i) => (
        <circle key={i} cx={n.x} cy={n.y} r={n.r} className="step-dot" />
      ))}
      <circle cx="120" cy="105" r="9" className="step-dot accent" />
    </svg>
  );
}

/* Decision card art — two stacked rows of bars with one highlighted. */
function DecisionArt() {
  const rows = [
    { y: 16, w: 110, label: 'shipped', accent: true },
    { y: 38, w: 78, label: 'shipped' },
    { y: 60, w: 96, label: 'shipped' },
    { y: 82, w: 64, label: 'open' },
    { y: 104, w: 88, label: 'open' },
    { y: 126, w: 52, label: 'open' },
  ];
  return (
    <svg viewBox="0 0 180 150" className="landing-decision-svg" aria-hidden="true">
      {rows.map((r, i) => (
        <g key={i}>
          <rect
            x="14"
            y={r.y}
            width={r.w}
            height="10"
            rx="3"
            className={r.accent ? 'decision-bar accent' : 'decision-bar'}
          />
          <circle cx="6" cy={r.y + 5} r="2.5" className="decision-tick" />
        </g>
      ))}
    </svg>
  );
}
