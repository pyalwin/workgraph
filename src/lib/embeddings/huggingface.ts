import { featureExtraction } from '@huggingface/inference';

const HF_TOKEN = process.env.HF_TOKEN;
const HF_MODEL = process.env.HF_EMBED_MODEL || 'Octen/Octen-Embedding-0.6B';
const HF_PROVIDER = process.env.HF_EMBED_PROVIDER; // optional, defaults to auto

const DEFAULT_TIMEOUT_MS = 30_000;
// Octen-Embedding-0.6B outputs 768-dim vectors; cap input at ~6000 chars
// (≈ 1500 tokens) to stay well within context limits
const MAX_EMBED_CHARS = 6000;

export type EmbeddingModel = string; // HF model ID

export const TEXT_MODEL = HF_MODEL;
export const TEXT_DIM = 768;

export async function embed(text: string, _model: EmbeddingModel = TEXT_MODEL): Promise<number[]> {
  const input = text.length > MAX_EMBED_CHARS ? text.slice(0, MAX_EMBED_CHARS) : text;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    if (!HF_TOKEN) throw new Error('HF_TOKEN environment variable is not set');
    const result = await featureExtraction({
      model: HF_MODEL,
      inputs: input,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    provider: (HF_PROVIDER ?? 'auto') as any,
    });
    // result is number[][] — single string input returns number[][]
    // extract the first embedding
    if (!Array.isArray(result) || result.length === 0) {
      throw new Error(`HF embed returned no embedding for model ${HF_MODEL}`);
    }
    const embedding = Array.isArray(result[0]) ? result[0] : result;
    if (!Array.isArray(embedding) || embedding.length === 0) {
      throw new Error(`HF embed returned empty embedding for model ${HF_MODEL}`);
    }
    return embedding as number[];
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
  if (!HF_TOKEN) return false;
  try {
    await embed('ok');
    return true;
  } catch {
    return false;
  }
}