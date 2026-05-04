import { readConfig } from "./config.js";

type FetchInit = Omit<RequestInit, "body"> & { body?: unknown };

async function request(
  url: string,
  init: FetchInit = {},
  token?: string
): Promise<unknown> {
  const { body, ...rest } = init;
  const fetchInit: RequestInit = {
    ...rest,
    method: rest.method ?? (body !== undefined ? "POST" : "GET"),
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(rest.headers as Record<string, string> | undefined),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  };

  let res: Response;
  try {
    res = await fetch(url, fetchInit);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Could not reach ${url}: ${msg}`);
  }

  if (!res.ok) {
    let detail = "";
    try {
      const j = (await res.json()) as { error?: string; message?: string };
      detail = j.error ?? j.message ?? "";
    } catch {
      // ignore parse failure
    }
    throw new Error(
      `Server returned ${res.status} for ${url}${detail ? ": " + detail : ""}`
    );
  }

  return res.json();
}

/** Authenticated request — reads config for URL + token. */
export async function apiFetch(path: string, init: FetchInit = {}): Promise<unknown> {
  const config = await readConfig();
  if (!config) throw new Error("Not paired. Run `workgraph login` first.");
  const url = `${config.url}${path}`;
  return request(url, init, config.agent_token);
}

/** Unauthenticated request — used for /pair/start and /pair/poll. */
export async function apiFetchPublic(
  baseUrl: string,
  path: string,
  init: FetchInit = {}
): Promise<unknown> {
  const url = `${baseUrl}${path}`;
  return request(url, init);
}
