import type { AgentConfig } from './types.js';

/**
 * apiFetch — authenticated fetch against the Workgraph server.
 * Uses the bearer token from config on every request.
 * Throws on non-2xx with the response body included in the error message.
 */
export async function apiFetch(
  path: string,
  options: { method?: string; body?: unknown } = {},
  config: AgentConfig,
): Promise<unknown> {
  return fetchJson(config.base_url, path, options, `Bearer ${config.agent_token}`);
}

/**
 * apiFetchPublic — unauthenticated fetch (used during device-flow pairing).
 */
export async function apiFetchPublic(
  baseUrl: string,
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<unknown> {
  return fetchJson(baseUrl, path, options, undefined);
}

async function fetchJson(
  baseUrl: string,
  path: string,
  options: { method?: string; body?: unknown },
  authorization: string | undefined,
): Promise<unknown> {
  const url = `${baseUrl.replace(/\/$/, '')}${path}`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  if (authorization) {
    headers['Authorization'] = authorization;
  }

  const res = await fetch(url, {
    method: options.method ?? (options.body !== undefined ? 'POST' : 'GET'),
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });

  const text = await res.text();

  if (!res.ok) {
    throw new ApiError(
      `HTTP ${res.status} ${res.statusText} for ${options.method ?? 'GET'} ${path}: ${text}`,
      res.status,
      text,
    );
  }

  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}
