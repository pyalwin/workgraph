import { serve } from 'inngest/next';
import { inngest } from '@/inngest/client';
import { functions } from '@/inngest/functions';

/**
 * Inngest serve endpoint.
 *
 * Local dev: the Inngest dev server (http://localhost:8288) auto-discovers
 * this URL on startup. Each registered function appears in the dev UI; cron
 * triggers fire automatically.
 *
 * Production: Inngest Cloud POSTs here when an event matches a function's
 * trigger. Requests are signed; the SDK verifies via INNGEST_SIGNING_KEY.
 */
export const { GET, POST, PUT } = serve({
  client: inngest,
  functions,
});
