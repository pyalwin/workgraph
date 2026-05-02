import { v4 as uuid } from 'uuid';
import { decrypt, decryptOptional, encrypt, encryptOptional, isCryptoConfigured } from '../crypto';
import { ensureSchemaAsync } from '../db/init-schema-async';
import { getLibsqlDb } from '../db/libsql';

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

let _initPromise: Promise<void> | null = null;
async function ensureInit(): Promise<void> {
  if (!_initPromise) _initPromise = ensureSchemaAsync();
  return _initPromise;
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

export async function getRegisteredClient(
  source: string,
  redirectUri: string,
): Promise<RegisteredClient | null> {
  await ensureInit();
  const row = await getLibsqlDb()
    .prepare('SELECT * FROM oauth_clients WHERE source = ? AND redirect_uri = ?')
    .get<ClientRow>(source, redirectUri);
  return row ? rowToClient(row) : null;
}

export async function saveRegisteredClient(
  input: Omit<RegisteredClient, 'registeredAt'>,
): Promise<RegisteredClient> {
  if (!isCryptoConfigured()) {
    throw new Error('Cannot persist OAuth client — WORKGRAPH_SECRET_KEY is not set.');
  }
  await ensureInit();
  const db = getLibsqlDb();
  const existing = await db
    .prepare('SELECT id FROM oauth_clients WHERE source = ? AND redirect_uri = ?')
    .get<{ id: string }>(input.source, input.redirectUri);
  const id = existing?.id ?? uuid();
  const regBlob = input.registrationResponse ? encrypt(JSON.stringify(input.registrationResponse)) : null;

  if (existing) {
    await db
      .prepare(
        `UPDATE oauth_clients
         SET client_id_enc = ?, client_secret_enc = ?, registration_response_enc = ?,
             authorization_endpoint = ?, token_endpoint = ?, registered_at = datetime('now')
         WHERE id = ?`,
      )
      .run(
        encrypt(input.clientId),
        encryptOptional(input.clientSecret),
        regBlob,
        input.authorizationEndpoint,
        input.tokenEndpoint,
        id,
      );
  } else {
    await db
      .prepare(
        `INSERT INTO oauth_clients
           (id, source, redirect_uri, client_id_enc, client_secret_enc, registration_response_enc,
            authorization_endpoint, token_endpoint)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.source,
        input.redirectUri,
        encrypt(input.clientId),
        encryptOptional(input.clientSecret),
        regBlob,
        input.authorizationEndpoint,
        input.tokenEndpoint,
      );
  }
  const saved = await getRegisteredClient(input.source, input.redirectUri);
  if (!saved) throw new Error('saveRegisteredClient: row vanished after insert/update');
  return saved;
}
