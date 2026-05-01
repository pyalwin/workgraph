import { Inngest } from 'inngest';

/**
 * Inngest client. One per app.
 *
 * Local dev: runs against the Inngest dev server (default :8288). No env
 * vars required — the SDK relaxes signing checks when it sees no keys.
 *
 * Production: set INNGEST_EVENT_KEY (for sending events) and
 * INNGEST_SIGNING_KEY (for verifying requests Inngest Cloud sends back
 * to /api/inngest).
 */
export const inngest = new Inngest({
  id: 'workgraph',
  // Optional in dev, required in prod. The SDK reads these from env if not passed.
  eventKey: process.env.INNGEST_EVENT_KEY,
});
