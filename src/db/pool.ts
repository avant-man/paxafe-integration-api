import pg from 'pg';

// bigint (int8) as number: ids and epoch ms stay far below 2^53. numeric as number for API output.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => Number.parseFloat(v));

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;

export interface PoolOptions {
  /** Postgres search_path, used by the integration tests to run in an isolated schema. */
  searchPath?: string;
  max?: number;
}

export function createPool(connectionString: string, options: PoolOptions = {}): pg.Pool {
  const pool = new pg.Pool({
    connectionString,
    max: options.max ?? 10,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
  });
  // Set once per new session with SET, not as startup parameters: a transaction-mode pooler
  // (Neon's PgBouncer) rejects unknown startup parameters, so the API could not boot behind it.
  // node-postgres runs queries on a client in order, so this runs before the caller's first query.
  const settings = [
    'SET statement_timeout = 10000',
    'SET idle_in_transaction_session_timeout = 15000',
    ...(options.searchPath ? [`SET search_path TO ${options.searchPath}`] : []),
  ].join('; ');
  pool.on('connect', (client) => {
    // A connection where SET fails is broken, and its next query fails with the real error.
    client.query(settings).catch(() => undefined);
  });
  return pool;
}

export async function withTransaction<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
