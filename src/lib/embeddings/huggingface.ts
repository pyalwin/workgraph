const HF_TOKEN = process.env.HF_TOKEN;
const HF_MODEL = process.env.HF_EMBED_MODEL || 'sentence-transformers/all-MiniLM-L6-v2';
const HF_ROUTER_URL = 'https://router.huggingface.co/hf-inference';

const DEFAULT_TIMEOUT_MS = 30_000;
// all-MiniLM-L6-v2 outputs 384-dim vectors; cap input at ~6000 chars
const MAX_EMBED_CHARS = 6000;

export type EmbeddingModel = string;

export const TEXT_MODEL = HF_MODEL;
export const TEXT_DIM = 384;

function makeUrl(model: string): string {
  const encodedModel = encodeURIComponent(model);
  return `${HF_ROUTER_URL}/v1/models/${encodedModel}/pipeline/feature-extraction`;
}

export async function embed(text: string, _model: EmbeddingModel = TEXT_MODEL): Promise<number[]> {
  if (!HF_TOKEN) throw new Error('HF_TOKEN environment variable is not set');
  const input = text.length > MAX_EMBED_CHARS ? text.slice(0, MAX_EMBED_CHARS) : text;
  const url = makeUrl(HF_MODEL);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${HF_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ inputs: input }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    const contentType = response.headers.get('Content-Type') ?? '';
    let errDetail = '';
    if (contentType.includes('application/json')) {
      try {
        const body = await response.json();
        errDetail = body.error ?? body.detail ?? JSON.stringify(body);
      } catch { /* ignore */ }
    }
    throw new Error(`HF embed HTTP ${response.status}: ${errDetail || response.statusText}`);
  }
  const json = await response.json() as number[] | number[][];
  // feature-extraction returns number[][] (batch) even for single input
  if (!Array.isArray(json) || json.length === 0) {
    throw new Error(`HF embed returned no embedding for model ${HF_MODEL}`);
  }
  return Array.isArray(json[0]) ? (json[0] as number[]) : (json as number[]);
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