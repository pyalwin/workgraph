'use client';

import { useState } from 'react';
import { useWorkgraphState } from '@/components/workgraph-state';
import { ROLES } from '@/components/topbar';
import { Drawer, type DrawerPayload } from '@/components/drawer';
import { Markdown } from '@/components/prompt-kit/markdown';

export interface Narrative {
  id: string;
  tone: 'moved' | 'stalled' | 'risk';
  when: string;
  text: string;
  source: string;
  author: string;
  pillar: string;
  quote: string;
}

export interface PillarSummary {
  name: string;
  note: string;
  items: number;
  health: 'good' | 'drifting' | 'at-risk' | 'neutral';
}

export interface DigestSnapshot {
  range: string;
  shipped: number;
  merged: number;
  decisions: number;
  meetings: number;
  topThread: string;
  quietest: string;
  newSignal: string;
}

export interface FocusCard {
  kicker: string;
  kickerRight: string;
  title: string;
  subtitle: string;
  reason: string;
  actions: Array<{ label: string; kind: 'primary' | 'ghost' }>;
}

interface Props {
  totalItems: number;
  totalDecisions: number;
  lastSeenLabel: string;
  narratives: Narrative[];
  pillars: PillarSummary[];
  digest: DigestSnapshot;
  focus: FocusCard;
}

export function OverviewClient({
  totalItems,
  totalDecisions,
  lastSeenLabel,
  narratives,
  pillars,
  digest,
  focus,
}: Props) {
  const { state, setState } = useWorkgraphState();
  const [drawer, setDrawer] = useState<DrawerPayload | null>(null);
  const role = ROLES[state.role] ?? Object.values(ROLES)[0];
  const roleLabel = role?.label ?? 'Workspace User';

  return (
    <>
      <div className="page">
        <Greeting role={roleLabel} meta={`${totalItems} items · ${totalDecisions} decisions · last sync ${lastSeenLabel}`} />
        <VariationBar
          value={state.variation}
          onChange={(v) => setState({ variation: v })}
        />

        {state.variation === 'briefing' && (
          <Briefing
            focus={focus}
            narratives={narratives}
            digest={digest}
            pillars={pillars}
            showDigest={state.showDigest}
            showPillars={state.showPillars}
            onOpenSignal={(n) =>
              setDrawer({
                kind: 'signal',
                kicker: `Signal · ${n.pillar} · ${n.when}`,
                content: <SignalDrawerContent n={n} />,
              })
            }
          />
        )}

        {state.variation === 'agenda' && (
          <Agenda narratives={narratives} digest={digest} />
        )}

        {state.variation === 'canvas' && (
          <Canvas focus={focus} narratives={narratives} pillars={pillars} />
        )}
      </div>
      <Drawer payload={drawer} onClose={() => setDrawer(null)} />
    </>
  );
}

function Greeting({ role, meta }: { role: string; meta: string }) {
  const hour = new Date().getHours();
  const greet = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  return (
    <div className="greeting">
      <h1>
        {greet}. <span className="soft">Here&rsquo;s what needs you.</span>
      </h1>
      <div className="meta">
        <span className="meta-role">{role.toLowerCase()}</span>
        <span className="meta-dot">·</span>
        <span>{meta}</span>
      </div>
    </div>
  );
}

function VariationBar({
  value,
  onChange,
}: {
  value: 'briefing' | 'agenda' | 'canvas';
  onChange: (v: 'briefing' | 'agenda' | 'canvas') => void;
}) {
  const options = [
    { id: 'briefing', label: 'Briefing' },
    { id: 'agenda', label: 'Agenda' },
    { id: 'canvas', label: 'Canvas' },
  ] as const;
  return (
    <div className="variation-bar" role="tablist">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          className={value === o.id ? 'active' : ''}
          onClick={() => onChange(o.id)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Focus({ focus }: { focus: FocusCard }) {
  return (
    <div className="focus">
      <div className="focus-head">
        <span className="eyebrow">{focus.kicker}</span>
        <span className="eyebrow" style={{ color: 'var(--ink-4)' }}>
          {focus.kickerRight}
        </span>
      </div>
      <h2>{focus.title}</h2>
      <p className="focus-sub">{focus.subtitle}</p>
      <div className="focus-why">
        <b>Why this first?</b>&nbsp;&nbsp;{focus.reason}
      </div>
      <div className="focus-actions">
        {focus.actions.map((a, i) => (
          <button key={i} className={`btn ${a.kind === 'primary' ? 'btn-primary' : 'btn-ghost'}`}>
            {a.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function Memo({ narratives, onOpen }: { narratives: Narrative[]; onOpen: (n: Narrative) => void }) {
  return (
    <section>
      <div className="memo-head">
        <h3>Since you last looked</h3>
        <span className="since" style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-4)' }}>
          {narratives.length} SIGNALS
        </span>
      </div>
      <div className="memo">
        {narratives.length === 0 && (
          <div style={{ padding: '24px 0', color: 'var(--ink-4)', fontSize: 13 }}>
            No recent signals. Sync a source to populate the memo.
          </div>
        )}
        {narratives.map((n) => (
          <div className="memo-item" key={n.id} onClick={() => onOpen(n)}>
            <div className="memo-when">{n.when}</div>
            <div className="memo-body">
              <span className={`dot dot-${n.tone}`} />
              {n.text}
            </div>
            <div className="memo-source">
              <b>{n.author}</b>
              <br />
              {n.source} <span className="chevron">→</span>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function Digest({ digest }: { digest: DigestSnapshot }) {
  return (
    <section className="digest-section">
      <div className="digest-section-head">
        <div>
          <h3>This week in WorkGraph</h3>
          <p className="digest-lede">
            A rolling 5-day read across all connected sources — scoped to your view.
          </p>
        </div>
        <span className="since">{digest.range.toUpperCase()}</span>
      </div>
      <div className="digest">
        {[
          ['Shipped', digest.shipped, 'features & fixes'],
          ['PRs merged', digest.merged, 'across repos'],
          ['Decisions', digest.decisions, 'in threads'],
          ['Meetings', digest.meetings, 'transcribed'],
        ].map(([label, n, note]) => (
          <div className="digest-cell" key={label as string}>
            <span className="eyebrow">{label}</span>
            <div className="digest-n">{n as number}</div>
            <div className="digest-note">{note as string}</div>
          </div>
        ))}
      </div>
      <div className="digest-foot">
        <div>
          <span className="lbl">Loudest thread</span>
          {digest.topThread}
        </div>
        <div>
          <span className="lbl">Quietest pillar</span>
          {digest.quietest}
        </div>
        <div>
          <span className="lbl">New signal</span>
          {digest.newSignal}
        </div>
      </div>
    </section>
  );
}

function PillarsRail({ pillars }: { pillars: PillarSummary[] }) {
  return (
    <section className="pillars-rail">
      <div className="pillars-rail-head">
        <h3>Pillars at a glance</h3>
        <span className="eyebrow" style={{ fontSize: 10 }}>
          Tap to drill in
        </span>
      </div>
      <div className="pillars-grid">
        {pillars.map((p) => (
          <div className="pillar-chip" key={p.name}>
            <div className="name">
              <span className={`pill-dot pd-${p.health}`} />
              {p.name}
            </div>
            <div className="note">{p.note}</div>
            <div className="items">{p.items} items</div>
          </div>
        ))}
      </div>
    </section>
  );
}

function Briefing({
  focus,
  narratives,
  digest,
  pillars,
  showDigest,
  showPillars,
  onOpenSignal,
}: {
  focus: FocusCard;
  narratives: Narrative[];
  digest: DigestSnapshot;
  pillars: PillarSummary[];
  showDigest: boolean;
  showPillars: boolean;
  onOpenSignal: (n: Narrative) => void;
}) {
  return (
    <div className="briefing">
      <Focus focus={focus} />
      <Memo narratives={narratives} onOpen={onOpenSignal} />
      {showDigest && (
        <>
          <div style={{ height: 8 }} />
          <Digest digest={digest} />
        </>
      )}
      {showPillars && <PillarsRail pillars={pillars} />}
    </div>
  );
}

function Agenda({
  narratives,
  digest,
}: {
  narratives: Narrative[];
  digest: DigestSnapshot;
}) {
  return (
    <div className="agenda-layout" style={{ display: 'grid', gridTemplateColumns: '1fr 360px', gap: 40 }}>
      <div>
        <div className="memo-head">
          <h3>Recent queue</h3>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-4)' }}>
            {narratives.length} signals · most recent first
          </span>
        </div>
        <div className="memo">
          {narratives.map((n) => (
            <div className="memo-item" key={n.id}>
              <div className="memo-when">{n.when}</div>
              <div className="memo-body">
                <span className={`dot dot-${n.tone}`} />
                {n.text}
              </div>
              <div className="memo-source">
                <b>{n.author}</b>
                <br />
                {n.source}
              </div>
            </div>
          ))}
        </div>
      </div>
      <aside style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
        <div className="side-card">
          <span className="side-card-label">This week</span>
          <span className="side-card-val">{digest.shipped + digest.merged}</span>
          <span className="side-card-sub">
            {digest.shipped} shipped · {digest.merged} merged
          </span>
        </div>
        <div className="side-card">
          <span className="side-card-label">Decisions</span>
          <span className="side-card-val">{digest.decisions}</span>
          <span className="side-card-sub">in threads & meetings</span>
        </div>
        <div className="side-card">
          <span className="side-card-label">Meetings</span>
          <span className="side-card-val">{digest.meetings}</span>
          <span className="side-card-sub">transcribed</span>
        </div>
      </aside>
    </div>
  );
}

function Canvas({
  focus,
  narratives,
  pillars,
}: {
  focus: FocusCard;
  narratives: Narrative[];
  pillars: PillarSummary[];
}) {
  return (
    <div className="canvas-layout" style={{ display: 'grid', gridTemplateColumns: '1fr 360px', gap: 40 }}>
      <div
        className="canvas-map"
        style={{
          position: 'relative',
          aspectRatio: '1 / 1',
          background: 'var(--paper)',
          border: '1px solid var(--rule)',
          borderRadius: 16,
          overflow: 'hidden',
          padding: 24,
        }}
      >
        <div style={{ position: 'absolute', inset: 0, padding: 24 }}>
          <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%,-50%)' }}>
            <div
              style={{
                width: 64,
                height: 64,
                borderRadius: '50%',
                background: 'var(--ink)',
                color: 'var(--bone)',
                display: 'grid',
                placeItems: 'center',
                fontFamily: 'var(--mono)',
                fontSize: 22,
                fontWeight: 600,
              }}
            >
              W
            </div>
          </div>
          {pillars.map((p, i) => {
            const angle = (i / Math.max(pillars.length, 1)) * Math.PI * 2 - Math.PI / 2;
            const r = 38;
            const x = 50 + r * Math.cos(angle);
            const y = 50 + r * Math.sin(angle);
            const dotBg =
              p.health === 'at-risk'
                ? 'var(--red)'
                : p.health === 'drifting'
                ? 'var(--amber)'
                : p.health === 'good'
                ? 'var(--green)'
                : 'var(--ink-5)';
            return (
              <div
                key={p.name}
                style={{
                  position: 'absolute',
                  left: `${x}%`,
                  top: `${y}%`,
                  transform: 'translate(-50%,-50%)',
                  textAlign: 'center',
                }}
              >
                <div
                  style={{
                    width: 14,
                    height: 14,
                    borderRadius: '50%',
                    background: dotBg,
                    border: '2px solid var(--paper)',
                    boxShadow: '0 0 0 1px var(--rule-2)',
                    margin: '0 auto 6px',
                  }}
                />
                <div
                  style={{
                    fontSize: 12,
                    fontWeight: 500,
                    color: 'var(--ink)',
                    background: 'var(--paper)',
                    padding: '2px 8px',
                    borderRadius: 999,
                    border: '1px solid var(--rule)',
                  }}
                >
                  {p.name}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <aside style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
        <Focus focus={focus} />
        <div className="side-card">
          <span className="side-card-label">Most recent</span>
          <span className="side-card-val" style={{ fontSize: 14, fontWeight: 400, lineHeight: 1.4 }}>
            {narratives[0]?.text ?? '—'}
          </span>
        </div>
      </aside>
    </div>
  );
}

function SignalDrawerContent({ n }: { n: Narrative }) {
  return (
    <>
      <h2>{n.text}</h2>
      <p className="lede">
        {n.pillar} · {n.source}
      </p>
      <div className="drawer-section">
        <h4>Original signal</h4>
        <div className="drawer-quote">
          <span className="who">
            {n.author} · {n.source}
          </span>
          {n.quote ? <Markdown>{n.quote}</Markdown> : '—'}
        </div>
      </div>
    </>
  );
}
