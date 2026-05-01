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
              <SourceCardsArt />
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
              <LinkArt />
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
              <NarrativeArt />
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

/* Step 1 — Connect.
 * Loose stack of source "cards" — each has a tag and a few text lines.
 * Conveys "individual feeds", not yet connected. */
function SourceCardsArt() {
  const cards = [
    { x: 12, y: 18, rot: -4, tag: 'JIRA', accent: true },
    { x: 96, y: 6, rot: 3, tag: 'NOTION' },
    { x: 156, y: 60, rot: -2, tag: 'SLACK' },
    { x: 28, y: 94, rot: 2, tag: 'GITHUB' },
    { x: 110, y: 122, rot: -3, tag: 'GRANOLA' },
  ];
  return (
    <svg viewBox="0 0 240 200" className="landing-step-svg" aria-hidden="true">
      {cards.map((c, i) => (
        <g key={i} transform={`translate(${c.x} ${c.y}) rotate(${c.rot})`}>
          <rect
            width="72"
            height="56"
            rx="5"
            className={`source-card ${c.accent ? 'accent' : ''}`}
          />
          <text x="8" y="14" className="source-card-tag">
            {c.tag}
          </text>
          <line x1="8" y1="26" x2="60" y2="26" className="source-card-line" />
          <line x1="8" y1="34" x2="48" y2="34" className="source-card-line" />
          <line x1="8" y1="42" x2="56" y2="42" className="source-card-line" />
        </g>
      ))}
    </svg>
  );
}

/* Step 2 — Stitch.
 * A meeting note and a ticket linked because they share a topic
 * ("v2 schema"). Shows the actual matching mechanism without faking
 * a project-specific issue key. */
function LinkArt() {
  return (
    <svg viewBox="0 0 240 200" className="landing-step-svg" aria-hidden="true">
      {/* Top card — meeting */}
      <g transform="translate(8 12)">
        <rect width="106" height="62" rx="5" className="source-card" />
        <text x="8" y="14" className="source-card-tag">
          MEETING · APR 12
        </text>
        <line x1="8" y1="26" x2="92" y2="26" className="source-card-line" />
        <text x="8" y="38" className="source-card-key">
          v2 schema
        </text>
        <line x1="46" y1="34" x2="92" y2="34" className="source-card-line" />
        <line x1="8" y1="48" x2="86" y2="48" className="source-card-line" />
      </g>

      {/* Bottom card — ticket */}
      <g transform="translate(126 124)">
        <rect width="106" height="62" rx="5" className="source-card" />
        <text x="8" y="14" className="source-card-tag accent">
          TICKET
        </text>
        <text x="8" y="30" className="source-card-key">
          v2 schema
        </text>
        <line x1="46" y1="26" x2="80" y2="26" className="source-card-line" />
        <line x1="8" y1="40" x2="92" y2="40" className="source-card-line" />
        <line x1="8" y1="50" x2="64" y2="50" className="source-card-line" />
      </g>

      {/* Connecting curve — meeting → ticket */}
      <path
        d="M 96 80 C 130 90, 130 130, 152 138"
        className="link-curve"
        fill="none"
      />
      <circle cx="96" cy="80" r="3" className="link-endpoint" />
      <circle cx="152" cy="138" r="3" className="link-endpoint accent" />

      {/* Floating signal label */}
      <g transform="translate(96 102)">
        <rect width="68" height="18" rx="9" className="link-pill" />
        <text x="34" y="12" className="link-pill-text">
          topic match · 0.92
        </text>
      </g>
    </svg>
  );
}

/* Step 3 — Surface.
 * A single rendered "workstream summary" card — the AI-narrated output.
 * Shows: source chips, heading, paragraph lines, decision badge. */
function NarrativeArt() {
  return (
    <svg viewBox="0 0 260 200" className="landing-step-svg" aria-hidden="true">
      <rect x="10" y="10" width="240" height="180" rx="8" className="narrative-card" />

      {/* Top meta row: chips + decision badge */}
      <g transform="translate(22 26)">
        <rect width="44" height="14" rx="3" className="narrative-chip" />
        <text x="22" y="10" className="narrative-chip-text">
          jira
        </text>
        <rect x="50" width="48" height="14" rx="3" className="narrative-chip" />
        <text x="74" y="10" className="narrative-chip-text">
          slack
        </text>
        <rect x="104" width="56" height="14" rx="3" className="narrative-chip" />
        <text x="132" y="10" className="narrative-chip-text">
          notion
        </text>

        <rect x="190" width="38" height="14" rx="7" className="narrative-badge accent" />
        <text x="209" y="10" className="narrative-badge-text">
          shipped
        </text>
      </g>

      {/* Heading */}
      <line x1="22" y1="64" x2="178" y2="64" className="narrative-h" />
      <line x1="22" y1="74" x2="138" y2="74" className="narrative-h" />

      {/* Body paragraph lines */}
      <line x1="22" y1="98" x2="226" y2="98" className="narrative-p" />
      <line x1="22" y1="110" x2="218" y2="110" className="narrative-p" />
      <line x1="22" y1="122" x2="200" y2="122" className="narrative-p" />
      <line x1="22" y1="134" x2="170" y2="134" className="narrative-p" />

      {/* Footer: timeline dots */}
      <g transform="translate(22 160)">
        <circle cx="0" cy="6" r="3" className="narrative-tick" />
        <line x1="6" y1="6" x2="46" y2="6" className="narrative-tick-line" />
        <circle cx="52" cy="6" r="3" className="narrative-tick" />
        <line x1="58" y1="6" x2="98" y2="6" className="narrative-tick-line" />
        <circle cx="104" cy="6" r="3" className="narrative-tick accent" />
        <line x1="110" y1="6" x2="150" y2="6" className="narrative-tick-line" />
        <circle cx="156" cy="6" r="3" className="narrative-tick" />
      </g>
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
