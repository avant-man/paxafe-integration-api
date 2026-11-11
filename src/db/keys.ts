import { randomBytes } from 'node:crypto';
import { sha256Hex } from '../transform/hash.js';
import type { Pool } from './pool.js';

export interface ApiKeyRecord {
  id: string;
  name: string;
  accountId: number | null;
  revoked: boolean;
}

export const hashApiKey = (key: string): string => sha256Hex(key);

export function generateApiKey(): string {
  return `pxk_${randomBytes(24).toString('base64url')}`;
}

export async function findApiKey(pool: Pool, key: string): Promise<ApiKeyRecord | null> {
  const { rows } = await pool.query<{ id: string; name: string; account_id: number | null; revoked_at: Date | null }>(
    'SELECT id, name, account_id, revoked_at FROM api_keys WHERE key_hash = $1',
    [hashApiKey(key)],
  );
  const row = rows[0];
  if (!row) return null;
  return { id: row.id, name: row.name, accountId: row.account_id, revoked: row.revoked_at !== null };
}

/** Records use at most once a minute per key, so auth does not write on every request. */
export async function touchApiKey(pool: Pool, id: string): Promise<void> {
  await pool.query(
    `UPDATE api_keys SET last_used_at = now()
     WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')`,
    [id],
  );
}

export async function createApiKey(pool: Pool, name: string, accountId: number | null): Promise<{ id: string; key: string }> {
  const key = generateApiKey();
  const { rows } = await pool.query<{ id: string }>(
    'INSERT INTO api_keys (name, key_hash, account_id) VALUES ($1, $2, $3) RETURNING id',
    [name, hashApiKey(key), accountId],
  );
  return { id: rows[0]!.id, key };
}

/**
 * Makes SEED_API_KEY the one valid key named "seed" (unscoped). Changing the env var
 * rotates the key: the old seed hash is replaced, not kept alongside.
 */
export async function upsertSeedKey(pool: Pool, key: string): Promise<void> {
  const hash = hashApiKey(key);
  const updated = await pool.query(
    `UPDATE api_keys SET key_hash = $1, account_id = NULL, revoked_at = NULL
     WHERE name = 'seed' AND id = (SELECT id FROM api_keys WHERE name = 'seed' ORDER BY created_at LIMIT 1)`,
    [hash],
  );
  if (updated.rowCount === 0) {
    await pool.query(
      `INSERT INTO api_keys (name, key_hash) VALUES ('seed', $1)
       ON CONFLICT (key_hash) DO UPDATE SET revoked_at = NULL`,
      [hash],
    );
  }
}
