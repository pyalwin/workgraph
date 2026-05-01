import { v4 as uuid } from 'uuid';
import { getDb } from '../db';
import { initSchema } from '../schema';
import { decrypt, decryptOptional, encrypt, encryptOptional, isCryptoConfigured } from '../crypto';

export interface RegisteredClient {
  source: string;
  redirectUri: string;
  clientId: string;
  clientSecret: string | null;
  authorizationEndpoint: string | null;
  tokenEndpoint: string | null;
  registeredAt: string;
  registrationResponse: Record<string, unknown> | null;
}

interface ClientRow {
  id: string;
  source: string;
  redirect_uri: string;
  client_id_enc: string;
  client_secret_enc: string | null;
  registration_response_enc: string | null;
  authorization_endpoint: string | null;
  token_endpoint: string | null;
  registered_at: string;
}

function rowToClient(row: ClientRow): RegisteredClient {
  const reg = decryptOptional(row.registration_response_enc);
  return {
    source: row.source,
    redirectUri: row.redirect_uri,
    clientId: decrypt(row.client_id_enc),
    clientSecret: decryptOptional(row.client_secret_enc),
    authorizationEndpoint: row.authorization_endpoint,
    tokenEndpoint: row.token_endpoint,
    registeredAt: row.registered_at,
    registrationResponse: reg ? JSON.parse(reg) : null,
  };
}

export function getRegisteredClient(source: string, redirectUri: string): RegisteredClient | null {
  initSchema();
  const db = getDb();
  const row = db
    .prepare('SELECT * FROM oauth_clients WHERE source = ? AND redirect_uri = ?')
    .get(source, redirectUri) as ClientRow | undefined;
  return row ? rowToClient(row) : null;
}

export function saveRegisteredClient(input: Omit<RegisteredClient, 'registeredAt'>): RegisteredClient {
  if (!isCryptoConfigured()) {
    throw new Error('Cannot persist OAuth client — WORKGRAPH_SECRET_KEY is not set.');
  }
  initSchema();
  const db = getDb();
  const existing = db
    .prepare('SELECT id FROM oauth_clients WHERE source = ? AND redirect_uri = ?')
    .get(input.source, input.redirectUri) as { id: string } | undefined;
  const id = existing?.id ?? uuid();
  const regBlob = input.registrationResponse ? encrypt(JSON.stringify(input.registrationResponse)) : null;

  if (existing) {
    db.prepare(`
      UPDATE oauth_clients
      SET client_id_enc = ?, client_secret_enc = ?, registration_response_enc = ?,
          authorization_endpoint = ?, token_endpoint = ?, registered_at = datetime('now')
      WHERE id = ?
    `).run(
      encrypt(input.clientId),
      encryptOptional(input.clientSecret),
      regBlob,
      input.authorizationEndpoint,
      input.tokenEndpoint,
      id,
    );
  } else {
    db.prepare(`
      INSERT INTO oauth_clients
        (id, source, redirect_uri, client_id_enc, client_secret_enc, registration_response_enc,
         authorization_endpoint, token_endpoint)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, input.source, input.redirectUri,
      encrypt(input.clientId),
      encryptOptional(input.clientSecret),
      regBlob,
      input.authorizationEndpoint,
      input.tokenEndpoint,
    );
  }
  return getRegisteredClient(input.source, input.redirectUri)!;
}
