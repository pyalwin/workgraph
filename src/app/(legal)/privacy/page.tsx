export const metadata = {
  title: 'Privacy Policy — WorkGraph',
  description: 'How WorkGraph handles your data.',
};

const EFFECTIVE_DATE = 'May 10, 2026';
const CONTACT_EMAIL = 'arun.tgode@gmail.com';

export default function PrivacyPage() {
  return (
    <>
      <h1>Privacy Policy</h1>
      <p className="legal-meta">Effective {EFFECTIVE_DATE}</p>

      <p>
        WorkGraph (&ldquo;the service&rdquo;) is a tool that connects your existing
        work systems — email, calendar, documents, ticket trackers, chat — into a
        single graph for search, summarization, and AI assistance. This policy
        describes what data the service handles, why, and how to delete it.
      </p>

      <h2>1. Who runs the service</h2>
      <p>
        WorkGraph is open source. You may be using it as a self-hosted instance
        (where you run the software on your own infrastructure) or as a managed
        cloud instance operated by the maintainer. <strong>This policy applies to the cloud
        instance.</strong> Self-hosters: your data stays on your infrastructure and
        this policy is informational only.
      </p>

      <h2>2. Information we receive</h2>
      <p>When you sign in and connect data sources, the service receives:</p>
      <ul>
        <li><strong>Account identity</strong> — your email address and a stable user id from our
          authentication provider (WorkOS). Used to sign you in and tie your data
          to your account.</li>
        <li><strong>OAuth access tokens</strong> for each connected source (Google Workspace,
          Atlassian, GitHub, Slack, Notion, Linear, Microsoft Teams, etc.).
          Tokens are stored encrypted at rest. They are only used to fetch your
          data on your behalf.</li>
        <li><strong>The content of your connected sources</strong> — emails, calendar events,
          documents, tickets, messages, code reviews, etc. — limited to the OAuth
          scopes you granted (typically read-only).</li>
        <li><strong>Derived metadata</strong> — extracted entities (people, projects, tags),
          embeddings used for semantic search, AI-generated summaries, and links
          between items.</li>
      </ul>

      <h2>3. How we use it</h2>
      <ul>
        <li>To stitch related items together into a single view of work</li>
        <li>To power search, knowledge graphs, and AI assistance you explicitly request</li>
        <li>To classify items against goals and bets you define</li>
        <li>To detect anomalies and surface them in your dashboard</li>
      </ul>
      <p>
        We do not sell your data, do not use it for advertising, and do not use it to
        train any general-purpose AI model.
      </p>

      <h2>4. Third parties that process your data</h2>
      <p>The cloud instance relies on a small set of vendors:</p>
      <ul>
        <li><strong>WorkOS</strong> — authentication only (sign-in, session management). Receives
          your email and user id.</li>
        <li><strong>Turso</strong> — managed database for your tenant&apos;s SQLite/libSQL
          file. Encrypted at rest by the provider.</li>
        <li><strong>OpenRouter / Anthropic / Google / OpenAI</strong> — AI model providers. When
          you trigger a summarization, classification, or chat action, the
          relevant content is sent to the configured model provider for inference.
          You can choose your provider via configuration; self-host instances may
          use any compatible provider or none.</li>
        <li><strong>Inngest</strong> — background job runner for syncs and long-running tasks.
          Job payloads may include item ids and summaries; not full bodies.</li>
        <li><strong>Vercel</strong> — application hosting (cloud instance only).</li>
      </ul>
      <p>
        Each vendor processes your data only as needed to provide the service.
        We do not share your data with anyone else.
      </p>

      <h2>5. Where your data lives</h2>
      <p>
        Your indexed work data is stored in a per-tenant database isolated from
        other accounts. OAuth tokens are encrypted at rest with a key managed by
        the application. Embeddings are stored alongside the items they describe.
        Self-host instances store everything locally in a SQLite file.
      </p>

      <h2>6. Retention</h2>
      <p>
        Data is retained for as long as your account is active. When you delete
        your account, the service performs a hard delete: workspace data,
        OAuth tokens (revoked at the provider where supported), connector
        configs, custom tables, and your authentication identity are all
        removed. Backups are retained on a rolling basis (typically up to 30
        days) before being purged.
      </p>

      <h2>7. Your rights</h2>
      <ul>
        <li><strong>Access:</strong> all your data is visible in the app. You can export or
          screenshot it directly.</li>
        <li><strong>Correction:</strong> edit any item or remove individual records via the UI.</li>
        <li><strong>Deletion:</strong> Settings → Account → Delete account performs a complete
          wipe.</li>
        <li><strong>Disconnection:</strong> Settings → Connectors → Disconnect for any source removes
          its OAuth token and its synced items.</li>
      </ul>

      <h2>8. Google API Services User Data Policy</h2>
      <p>
        The service&apos;s use and transfer of information received from Google APIs
        adheres to the{' '}
        <a
          href="https://developers.google.com/terms/api-services-user-data-policy"
          target="_blank"
          rel="noopener noreferrer"
        >
          Google API Services User Data Policy
        </a>
        , including the Limited Use requirements. Specifically:
      </p>
      <ul>
        <li>Data accessed via Google APIs is used only to provide or improve user-facing features prominent in the application.</li>
        <li>We do not transfer this data to third parties except as necessary to provide or improve user-facing features, or as required by law.</li>
        <li>We do not use this data for serving advertisements.</li>
        <li>We do not allow humans to read this data unless we have your affirmative agreement, it is necessary for security purposes, or to comply with applicable law.</li>
      </ul>

      <h2>9. Security</h2>
      <p>
        Reasonable safeguards include encryption of OAuth tokens at rest,
        TLS in transit, scoped OAuth grants (read-only where possible), and
        per-tenant database isolation in the cloud instance. No system is
        perfectly secure; report suspected vulnerabilities to the contact below.
      </p>

      <h2>10. Children</h2>
      <p>The service is not intended for users under 16 and we do not knowingly collect their data.</p>

      <h2>11. Changes</h2>
      <p>
        Material changes to this policy will be announced before they take effect.
        The current version is always at this URL.
      </p>

      <h2>12. Contact</h2>
      <p>
        Questions, deletion requests, or security reports:{' '}
        <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
      </p>

      <p className="legal-disclaimer">
        This document is provided as a template for an open-source self-host project. It is not legal advice. Please review and adapt it with qualified counsel before relying on it for a production service.
      </p>
    </>
  );
}
