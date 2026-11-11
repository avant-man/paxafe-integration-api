import { finalizeEvent, insertEvent, type EventStatus } from './db/events.js';
import type { ApiKeyRecord } from './db/keys.js';
import { withTransaction, type Pool } from './db/pool.js';
import { HTTP_BY_STATUS, storeReading } from './db/readings.js';
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

/** One item in the response contract (see docs/DESIGN-SPEC.md, "Response contract"). */
export interface ItemResultBody {
  event_id: string;
  request_id: string;
  status: EventStatus;
  sensor: { id: number; payload: PxSensor } | null;
  location: { id: number; payload: PxLocation } | null;
  warnings: Issue[];
  errors: Issue[];
  /** Present only for duplicate and duplicate_conflict: the rows the first write created. */
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

/** Runs one parsed item through audit insert -> transform -> store. Never throws for item-level problems. */
export async function ingestItem(ctx: IngestContext, item: unknown, batchIndex: number | null): Promise<ItemResult> {
  const eventId = await insertEvent(ctx.pool, { apiKeyId: ctx.apiKey.id, requestId: ctx.requestId, batchIndex, rawBody: item });
  const log = ctx.log.child({ event_id: eventId, batch_index: batchIndex });

  try {
    const outcome = transformPayload(item, { nowMs: ctx.nowMs, keyAccountId: ctx.apiKey.accountId });

    if (!outcome.ok) {
      await finalizeEvent(ctx.pool, eventId, {
        status: 'rejected', httpStatus: 422, errors: outcome.errors, warnings: outcome.warnings,
        payloadHash: outcome.payloadHash, deviceImei: outcome.deviceImei,
      });
      log.info({ status: 'rejected', error_codes: outcome.errors.map((e) => e.code), device_imei: outcome.deviceImei }, 'item rejected');
      return { httpStatus: 422, body: body(ctx, eventId, 'rejected', { errors: outcome.errors, warnings: outcome.warnings }) };
    }

    const stored = await withTransaction(ctx.pool, async (client) => {
      // The hash and IMEI are known now; set them in the same transaction as the readings.
      await client.query('UPDATE webhook_events SET payload_hash = $2, device_imei = $3 WHERE id = $1', [
        eventId, outcome.payloadHash, outcome.deviceImei,
      ]);
      return storeReading(client, eventId, outcome);
    });

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
      : { code: 'INTERNAL_ERROR', path: '', message: 'Unexpected error while processing; the raw payload is kept for replay' };
    log.error({ err }, 'item failed');
    await finalizeEvent(ctx.pool, eventId, { status: 'failed', httpStatus: 500, errors: [error], warnings: [] })
      .catch((e: unknown) => log.error({ err: e }, 'could not mark event failed'));
    return { httpStatus: 500, body: body(ctx, eventId, 'failed', { errors: [error] }) };
  }
}

/** Records a request-level rejection (invalid JSON, bad batch size) as one rejected event. */
export async function rejectRequest(
  ctx: IngestContext,
  httpStatus: number,
  error: Issue,
  raw: { rawText?: string; rawBody?: unknown },
): Promise<ItemResult> {
  const eventId = await insertEvent(ctx.pool, { apiKeyId: ctx.apiKey.id, requestId: ctx.requestId, batchIndex: null, ...raw });
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
