/**
 * RuntimeEvent — the canonical event shape flowing through the agent pipeline.
 * Defined verbatim from the design spec §2.
 * Every driver translates its native output into these shapes.
 * The EventSink batches them and POSTs to the server.
 * The UI subscribes to them over SSE — it never sees driver-native JSON.
 */
export type RuntimeEvent =
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string }
  | { type: 'tool-call'; tool: string; args: unknown; call_id: string }
  | { type: 'tool-result'; call_id: string; output: string; truncated?: boolean }
  | { type: 'text-delta'; text: string }
  | { type: 'usage'; input_tokens: number; output_tokens: number; cost_usd?: number }
  | { type: 'finish'; reason: 'stop' | 'error' | 'cancelled'; final_text?: string; error?: string };

/**
 * AgentConfig — stored at ~/.workgraph/config.json.
 */
export interface AgentConfig {
  agent_id: string;
  agent_token: string;
  base_url: string;
  paired_at: string; // ISO 8601
}

/**
 * Job — shape returned by POST /api/agent/jobs/poll.
 */
export interface Job {
  id: string;
  kind: string;
  params: Record<string, unknown>;
}

/**
 * JobResult — posted to POST /api/agent/jobs/:id/result.
 */
export type JobResult =
  | { status: 'done'; payload: unknown }
  | { status: 'failed'; error: string };
