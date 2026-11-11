import { randomUUID } from 'node:crypto';
import { finalizeEvent, insertEvent, type EventStatus } from './db/events.js';
import type { ApiKeyRecord } from './db/keys.js';
import { withTransaction, type Pool } from './db/pool.js';
import { DeviceAccountConflict, HTTP_BY_STATUS, storeReading, type StoreResult } from './db/readings.js';
import type { Logger } from './logger.js';
import { OutputSchemaViolation, transformPayload } from './transform/pipeline.js';
import type { Issue, PxLocation, PxSensor } from './transform/types.js';

export interface IngestContext {
  pool: Pool;
  log: Logger;
  apiKey: ApiKeyRecord;
  requestId: string;
  nowMs: number;
}

export interface ItemResultBody {
  event_id: string;
  request_id: string;
  status: EventStatus;
  sensor: { id: number; payload: PxSensor } | null;
  location: { id: number; payload: PxLocation } | null;
  warnings: Issue[];
  errors: Issue[];
  duplicate_of?: { event_id: string; sensor_reading_id: number; location_reading_id: number | null };
}

export interface ItemResult {
  httpStatus: number;
  body: ItemResultBody;
}

function body(ctx: IngestContext, eventId: string, status: EventStatus, extra: Partial<ItemResultBody> = {}): ItemResultBody {
  return {
    event_id: eventId,
    request_id: ctx.requestId,
    status,
    sensor: null,
    location: null,
    warnings: [],
    errors: [],
    ...extra,
  };
}

export async function ingestItem(ctx: IngestContext, item: unknown, batchIndex: number | null): Promise<ItemResult> {
  const eventId = randomUUID();
  const log = ctx.log.child({ event_id: eventId, batch_index: batchIndex });
  let recorded = false;

  const reject = async (errors: Issue[], warnings: Issue[], payloadHash: string | null, deviceImei: string | null): Promise<ItemResult> => {
    await finalizeEvent(ctx.pool, eventId, { status: 'rejected', httpStatus: 422, errors, warnings, payloadHash, deviceImei });
    log.info({ status: 'rejected', error_codes: errors.map((e) => e.code), device_imei: deviceImei }, 'item rejected');
    return { httpStatus: 422, body: body(ctx, eventId, 'rejected', { errors, warnings }) };
  };

  try {
    await insertEvent(ctx.pool, { id: eventId, apiKeyId: ctx.apiKey.id, requestId: ctx.requestId, batchIndex, rawBody: item });
    recorded = true;

    const outcome = transformPayload(item, { nowMs: ctx.nowMs, keyAccountId: ctx.apiKey.accountId });
    if (!outcome.ok) return await reject(outcome.errors, outcome.warnings, outcome.payloadHash, outcome.deviceImei);

    let stored: StoreResult;
    try {
      stored = await withTransaction(ctx.pool, (client) => storeReading(client, eventId, outcome));
    } catch (err) {
      if (!(err instanceof DeviceAccountConflict)) throw err;
      const error: Issue = { code: 'DEVICE_ACCOUNT_CONFLICT', path: 'DeviceId', message: `${err.message}; nothing was stored` };
      return await reject([error], [], outcome.payloadHash, outcome.deviceImei);
    }

    log.info({
      status: stored.status,
      device_imei: outcome.deviceImei,
      timestamp_ms: outcome.reading.timestampMs,
      warning_codes: stored.warnings.map((w) => w.code),
    }, 'item stored');

    return {
      httpStatus: HTTP_BY_STATUS[stored.status],
      body: body(ctx, eventId, stored.status, {
        sensor: stored.sensorId === null ? null : { id: stored.sensorId, payload: outcome.sensor },
        location: stored.locationId === null || outcome.location === null ? null : { id: stored.locationId, payload: outcome.location },
        warnings: stored.warnings,
        ...(stored.duplicateOf
          ? {
              duplicate_of: {
                event_id: stored.duplicateOf.eventId,
                sensor_reading_id: stored.duplicateOf.sensorReadingId,
                location_reading_id: stored.duplicateOf.locationReadingId,
              },
            }
          : {}),
      }),
    };
  } catch (err) {
    const error: Issue = err instanceof OutputSchemaViolation
      ? { code: 'OUTPUT_SCHEMA_VIOLATION', path: '', message: err.message }
      : recorded
        ? { code: 'INTERNAL_ERROR', path: '', message: 'Unexpected error while processing; the raw payload is kept for replay' }
        : { code: 'INTERNAL_ERROR', path: '', message: 'The item could not be recorded; send it again' };
    log.error({ err, recorded }, 'item failed');
    if (recorded) {
      await finalizeEvent(ctx.pool, eventId, { status: 'failed', httpStatus: 500, errors: [error], warnings: [] })
        .catch((e: unknown) => log.error({ err: e }, 'could not mark event failed'));
    }
    return { httpStatus: 500, body: body(ctx, eventId, 'failed', { errors: [error] }) };
  }
}

export type RawRequest = { rawBody?: unknown; rawText?: string; rawBytes?: Uint8Array };

export async function rejectRequest(
  ctx: IngestContext,
  httpStatus: number,
  error: Issue,
  raw: RawRequest,
): Promise<ItemResult> {
  const eventId = randomUUID();
  await insertEvent(ctx.pool, { id: eventId, apiKeyId: ctx.apiKey.id, requestId: ctx.requestId, batchIndex: null, ...raw });
  await finalizeEvent(ctx.pool, eventId, { status: 'rejected', httpStatus, errors: [error], warnings: [] });
  ctx.log.info({ event_id: eventId, status: 'rejected', error_codes: [error.code] }, 'request rejected');
  return { httpStatus, body: body(ctx, eventId, 'rejected', { errors: [error] }) };
}

export function summarize(results: ItemResultBody[]): Record<EventStatus, number> {
  const summary: Record<EventStatus, number> = {
    processed: 0, partial: 0, duplicate: 0, duplicate_conflict: 0, rejected: 0, failed: 0,
  };
  for (const r of results) summary[r.status] += 1;
  return summary;
}
