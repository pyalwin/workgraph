/**
 * Per-model pricing for free-tier cost metering. Rates are USD per million
 * tokens, sourced from Vercel AI Gateway list pricing as of May 2026.
 *
 * Conversion math: cost in micros (1/1_000_000 USD) = tokens * (USD/M tokens)
 * because the per-million and per-micro factors cancel.
 *
 * If a model is missing from this map, the call still records token counts
 * but contributes $0 to the cost cap. That fails open — pricing-aware caps
 * never block calls for unknown models, but ops will see uncapped spend in
 * logs and can add the entry.
 */

export interface ModelPrice {
  /** USD per million input tokens. */
  inPerM: number;
  /** USD per million output tokens. */
  outPerM: number;
}

export const MODEL_PRICING: Record<string, ModelPrice> = {
  // Google
  'google/gemini-2.5-flash-lite': { inPerM: 0.1, outPerM: 0.4 },
  'google/gemini-2.5-flash':      { inPerM: 0.3, outPerM: 2.5 },
  'google/gemini-2.5-pro':        { inPerM: 1.25, outPerM: 10.0 },

  // Anthropic
  'anthropic/claude-haiku-4.5':   { inPerM: 1.0, outPerM: 5.0 },
  'anthropic/claude-sonnet-4.6':  { inPerM: 3.0, outPerM: 15.0 },
  'anthropic/claude-opus-4.7':    { inPerM: 15.0, outPerM: 75.0 },

  // OpenAI
  'openai/gpt-5':                 { inPerM: 1.25, outPerM: 10.0 },
  'openai/gpt-5-mini':            { inPerM: 0.25, outPerM: 2.0 },
  'openai/gpt-5-nano':            { inPerM: 0.05, outPerM: 0.4 },
};

/**
 * Compute cost in micros (1/1_000_000 USD) for a single call.
 * tokens × (USD per million) yields micros directly because the unit
 * factors cancel: tokens × (1/1M USD/token) × (1M micros/USD).
 */
export function estimateCostMicros(modelId: string, inputTokens: number, outputTokens: number): number {
  const p = MODEL_PRICING[modelId];
  if (!p) return 0;
  return Math.round(inputTokens * p.inPerM + outputTokens * p.outPerM);
}

/**
 * Format micros as a human-readable USD string.
 *   1_000_000 → "$1.00"
 *      32_000 → "$0.03"
 *           5 → "<$0.01"
 *           0 → "$0.00"
 */
export function formatUsdMicros(micros: number): string {
  if (micros <= 0) return '$0.00';
  const dollars = micros / 1_000_000;
  if (dollars < 0.01) return '<$0.01';
  return `$${dollars.toFixed(2)}`;
}
