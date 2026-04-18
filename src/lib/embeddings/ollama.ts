const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const DEFAULT_TIMEOUT_MS = 30_000;
// nomic-embed-text's context window is 2048 tokens. Cap input at ~6000 chars (≈ 1500 tokens)
// to leave headroom for tokenization variance.
const MAX_EMBED_CHARS = 6000;

export type EmbeddingModel = 'nomic-embed-text' | 'nomic-embed-code';

export const TEXT_MODEL: EmbeddingModel = 'nomic-embed-text';
export const TEXT_DIM = 768;

export async function embed(text: string, model: EmbeddingModel = TEXT_MODEL): Promise<number[]> {
  const input = text.length > MAX_EMBED_CHARS ? text.slice(0, MAX_EMBED_CHARS) : text;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const resp = await fetch(`${OLLAMA_URL}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt: input }),
      signal: controller.signal,
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(`Ollama HTTP ${resp.status}: ${body.slice(0, 200)}`);
    }
    const json = (await resp.json()) as { embedding?: number[] };
    if (!json.embedding || !Array.isArray(json.embedding) || json.embedding.length === 0) {
      throw new Error(`Ollama returned no embedding for model ${model}`);
    }
    return json.embedding;
  } finally {
    clearTimeout(timer);
  }
}

export async function embedWithRetry(text: string, model: EmbeddingModel = TEXT_MODEL, attempts = 3): Promise<number[]> {
  let lastErr: Error | null = null;
  for (let i = 0; i < attempts; i++) {
    try {
      return await embed(text, model);
    } catch (err: any) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      if (i < attempts - 1) {
        await new Promise(r => setTimeout(r, 400 * (i + 1)));
      }
    }
  }
  throw lastErr ?? new Error('embed failed');
}

export async function embedBatch(
  texts: string[],
  model: EmbeddingModel = TEXT_MODEL,
  opts: { concurrency?: number } = {},
): Promise<number[][]> {
  const concurrency = Math.max(1, opts.concurrency ?? 4);
  const out: number[][] = new Array(texts.length);
  for (let i = 0; i < texts.length; i += concurrency) {
    const slice = texts.slice(i, i + concurrency);
    const embs = await Promise.all(slice.map(t => embedWithRetry(t, model)));
    for (let j = 0; j < embs.length; j++) out[i + j] = embs[j];
  }
  return out;
}

export function cosineSim(a: number[], b: number[]): number {
  if (a.length !== b.length) throw new Error(`dim mismatch: ${a.length} vs ${b.length}`);
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

export async function isReady(): Promise<boolean> {
  try {
    const resp = await fetch(`${OLLAMA_URL}/api/version`, { signal: AbortSignal.timeout(2000) });
    return resp.ok;
  } catch {
    return false;
  }
}
