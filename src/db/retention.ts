import type { Pool } from './pool.js';

export interface RetentionOptions {
  /** Delete duplicate, duplicate_conflict and rejected events older than this. */
  eventDays: number;
  /** Clear the raw body of processed and partial events older than this. */
  rawDays: number;
  /** Rows per statement, so each statement holds its locks only briefly. */
  batchSize: number;
}

/**
 * Keeps webhook_events from growing without end. Events that created readings stay (the
 * readings point at them), and so do `failed` events, which are the replay queue.
 */
export async function runRetention(pool: Pool, o: RetentionOptions): Promise<{ eventsDeleted: number; rawBodiesCleared: number }> {
  const eventsDeleted = await inBatches(pool, o.batchSize, `
    DELETE FROM webhook_events WHERE id IN (
      SELECT id FROM webhook_events
      WHERE status IN ('duplicate', 'duplicate_conflict', 'rejected') AND received_at < now() - make_interval(days => $1)
      LIMIT $2)`, o.eventDays);
  const rawBodiesCleared = await inBatches(pool, o.batchSize, `
    UPDATE webhook_events SET raw_body = NULL, raw_text = NULL, raw_bytes = NULL WHERE id IN (
      SELECT id FROM webhook_events
      WHERE status IN ('processed', 'partial') AND received_at < now() - make_interval(days => $1)
        AND (raw_body IS NOT NULL OR raw_text IS NOT NULL OR raw_bytes IS NOT NULL)
      LIMIT $2)`, o.rawDays);
  return { eventsDeleted, rawBodiesCleared };
}

/** Runs `sql` (params: days, batch size) until a batch touches fewer rows than the batch size. */
async function inBatches(pool: Pool, batchSize: number, sql: string, days: number): Promise<number> {
  let total = 0;
  for (;;) {
    const { rowCount } = await pool.query(sql, [days, batchSize]);
    total += rowCount ?? 0;
    if ((rowCount ?? 0) < batchSize) return total;
  }
}
