import type { Pool } from './pool.js';

export interface RetentionOptions {
  eventDays: number;
  rawDays: number;
  batchSize: number;
}

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

async function inBatches(pool: Pool, batchSize: number, sql: string, days: number): Promise<number> {
  let total = 0;
  for (;;) {
    const { rowCount } = await pool.query(sql, [days, batchSize]);
    total += rowCount ?? 0;
    if ((rowCount ?? 0) < batchSize) return total;
  }
}
