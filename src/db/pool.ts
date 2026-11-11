import pg from 'pg';

// int8 and numeric parse as number, since values stay below 2^53.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => Number.parseFloat(v));

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;

export interface PoolOptions {
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
  // SET, not startup parameters: Neon's PgBouncer rejects unknown ones.
  const settings = [
    'SET statement_timeout = 10000',
    'SET idle_in_transaction_session_timeout = 15000',
    ...(options.searchPath ? [`SET search_path TO ${options.searchPath}`] : []),
  ].join('; ');
  pool.on('connect', (client) => {
    // A broken connection fails its next query with the real error.
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
