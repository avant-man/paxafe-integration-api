import type { Issue } from '../transform/types.js';
import type { Pool, PoolClient } from './pool.js';

export const EVENT_STATUSES = ['processed', 'partial', 'duplicate', 'duplicate_conflict', 'rejected', 'failed'] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];

export interface NewEvent {
  id: string;
  apiKeyId: string | null;
  requestId: string;
  batchIndex: number | null;
  rawBody?: unknown;
  rawText?: string | null;
  rawBytes?: Uint8Array | null;
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

// Row starts as failed/500, so a crash mid-way leaves it honest.
export async function insertEvent(pool: Pool, e: NewEvent): Promise<void> {
  let rawText = e.rawText ?? null;
  let rawBytes = e.rawBytes ? Buffer.from(e.rawBytes) : null;
  // Postgres text cannot hold NUL, so keep those bodies as bytes.
  if (rawText?.includes('\u0000')) {
    rawBytes = Buffer.from(rawText, 'utf8');
    rawText = null;
  }
  const rawJson = e.rawBody === undefined ? null : JSON.stringify(e.rawBody);
  const sql = `INSERT INTO webhook_events (id, api_key_id, request_id, batch_index, payload_hash, device_imei, status, http_status, raw_body, raw_text, raw_bytes)
               VALUES ($1, $2, $3, $4, $5, $6, 'failed', 500, $7::jsonb, $8, $9)`;
  const params = [e.id, e.apiKeyId, e.requestId, e.batchIndex, e.payloadHash ?? null, e.deviceImei ?? null];
  try {
    await pool.query(sql, [...params, rawJson, rawText, rawBytes]);
  } catch (err) {
    // jsonb rejects NUL, lone surrogates and deep nesting, so store text.
    const code = (err as { code?: string }).code ?? '';
    if (rawJson !== null && (code.startsWith('22') || code.startsWith('54'))) {
      await pool.query(sql, [...params, null, rawJson, null]);
      return;
    }
    throw err;
  }
}

const storableText = (text: string): string => text.replaceAll('\u0000', '').toWellFormed();
const storableIssues = (issues: Issue[]): string =>
  JSON.stringify(issues.map((i) => ({ ...i, path: storableText(i.path), message: storableText(i.message) })));

export async function finalizeEvent(db: Pool | PoolClient, id: string, u: EventUpdate): Promise<void> {
  await db.query(
    `UPDATE webhook_events SET
       status = $2, http_status = $3, errors = $4::jsonb, warnings = $5::jsonb,
       sensor_reading_id = $6, location_reading_id = $7,
       payload_hash = COALESCE($8, payload_hash), device_imei = COALESCE($9, device_imei),
       processed_at = now()
     WHERE id = $1`,
    [
      id, u.status, u.httpStatus, storableIssues(u.errors), storableIssues(u.warnings),
      u.sensorReadingId ?? null, u.locationReadingId ?? null, u.payloadHash ?? null, u.deviceImei ?? null,
    ],
  );
}

export interface EventFilter {
  limit: number;
  status: EventStatus | null;
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
            e.device_imei, e.payload_hash, e.raw_body, e.raw_text, encode(e.raw_bytes, 'base64') AS raw_base64,
            e.errors, e.warnings,
            e.sensor_reading_id, e.location_reading_id, k.name AS api_key_name
     FROM webhook_events e LEFT JOIN api_keys k ON k.id = e.api_key_id
     WHERE e.id = $1 AND ($2::uuid IS NULL OR e.api_key_id = $2)`,
    [id, apiKeyId],
  );
  return rows[0] ?? null;
}
