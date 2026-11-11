import type { Issue } from '../transform/types.js';
import type { Pool, PoolClient } from './pool.js';

export const EVENT_STATUSES = ['processed', 'partial', 'duplicate', 'duplicate_conflict', 'rejected', 'failed'] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];

export interface NewEvent {
  apiKeyId: string | null;
  requestId: string;
  batchIndex: number | null;
  rawBody?: unknown;
  rawText?: string | null;
  payloadHash?: string | null;
  deviceImei?: string | null;
}

export interface EventUpdate {
  status: EventStatus;
  httpStatus: number;
  errors: Issue[];
  warnings: Issue[];
  sensorReadingId?: number | null;
  locationReadingId?: number | null;
  payloadHash?: string | null;
  deviceImei?: string | null;
}

/**
 * Writes the raw item first, before any processing, so every request is kept for audit and
 * replay. The row starts as `failed`/500: if the process dies mid-way the row is still honest.
 */
export async function insertEvent(pool: Pool, e: NewEvent): Promise<string> {
  const params = [e.apiKeyId, e.requestId, e.batchIndex, e.payloadHash ?? null, e.deviceImei ?? null];
  const sql = `INSERT INTO webhook_events (api_key_id, request_id, batch_index, payload_hash, device_imei, status, http_status, raw_body, raw_text)
               VALUES ($1, $2, $3, $4, $5, 'failed', 500, $6::jsonb, $7) RETURNING id`;
  const rawJson = e.rawBody === undefined ? null : JSON.stringify(e.rawBody);
  try {
    const { rows } = await pool.query<{ id: string }>(sql, [...params, rawJson, e.rawText ?? null]);
    return rows[0]!.id;
  } catch (err) {
    // jsonb cannot hold \u0000; keep the item as text instead of losing the audit row.
    if ((err as { code?: string }).code === '22P05' && rawJson !== null) {
      const { rows } = await pool.query<{ id: string }>(sql, [...params, null, rawJson]);
      return rows[0]!.id;
    }
    throw err;
  }
}

export async function finalizeEvent(db: Pool | PoolClient, id: string, u: EventUpdate): Promise<void> {
  await db.query(
    `UPDATE webhook_events SET
       status = $2, http_status = $3, errors = $4::jsonb, warnings = $5::jsonb,
       sensor_reading_id = $6, location_reading_id = $7,
       payload_hash = COALESCE($8, payload_hash), device_imei = COALESCE($9, device_imei),
       processed_at = now()
     WHERE id = $1`,
    [
      id, u.status, u.httpStatus, JSON.stringify(u.errors), JSON.stringify(u.warnings),
      u.sensorReadingId ?? null, u.locationReadingId ?? null, u.payloadHash ?? null, u.deviceImei ?? null,
    ],
  );
}

export interface EventFilter {
  limit: number;
  status: EventStatus | null;
  /** Scoped keys only see their own events. */
  apiKeyId: string | null;
}

export async function listEvents(pool: Pool, f: EventFilter): Promise<unknown[]> {
  const { rows } = await pool.query(
    `SELECT id, received_at, processed_at, request_id, batch_index, status, http_status, device_imei,
            payload_hash, errors, warnings, sensor_reading_id, location_reading_id
     FROM webhook_events
     WHERE ($1::text IS NULL OR status = $1) AND ($2::uuid IS NULL OR api_key_id = $2)
     ORDER BY received_at DESC, id DESC
     LIMIT $3`,
    [f.status, f.apiKeyId, f.limit],
  );
  return rows;
}

export async function getEvent(pool: Pool, id: string, apiKeyId: string | null): Promise<unknown | null> {
  const { rows } = await pool.query(
    `SELECT e.id, e.received_at, e.processed_at, e.request_id, e.batch_index, e.status, e.http_status,
            e.device_imei, e.payload_hash, e.raw_body, e.raw_text, e.errors, e.warnings,
            e.sensor_reading_id, e.location_reading_id, k.name AS api_key_name
     FROM webhook_events e LEFT JOIN api_keys k ON k.id = e.api_key_id
     WHERE e.id = $1 AND ($2::uuid IS NULL OR e.api_key_id = $2)`,
    [id, apiKeyId],
  );
  return rows[0] ?? null;
}
