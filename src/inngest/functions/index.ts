/**
 * Registry of every Inngest function. Add new functions here so they're
 * picked up by the /api/inngest serve handler.
 */
import { heartbeat } from './heartbeat';

export const functions = [heartbeat];
