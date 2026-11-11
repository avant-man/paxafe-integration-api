import { roundOrNull } from '../transform/round.js';
import type { Issue, TransformOutcome } from '../transform/types.js';
import { finalizeEvent } from './events.js';
import type { Pool, PoolClient } from './pool.js';

type Accepted = Extract<TransformOutcome, { ok: true }>;

export type StoreStatus = 'processed' | 'partial' | 'duplicate' | 'duplicate_conflict';

export interface StoreResult {
  status: StoreStatus;
  sensorId: number | null;
  locationId: number | null;
  /** Ids of the first-written rows when this item is a repeat. */
  duplicateOf: { sensorReadingId: number; locationReadingId: number | null; eventId: string } | null;
  /** Transform warnings plus any added while storing. */
  warnings: Issue[];
}

export const HTTP_BY_STATUS: Record<StoreStatus, number> = {
  processed: 201,
  partial: 201,
  duplicate: 200,
  duplicate_conflict: 200,
};

/** The device belongs to another account. The item is rejected with DEVICE_ACCOUNT_CONFLICT (422). */
export class DeviceAccountConflict extends Error {
  constructor(readonly deviceImei: string) {
    super(`Device ${deviceImei} belongs to another account`);
    this.name = 'DeviceAccountConflict';
  }
}

/**
 * Stores one accepted reading and finalizes its event in a single transaction.
 * Idempotency key is (device_imei, timestamp_ms); the first write wins for the whole reading.
 * A repeat is `duplicate` when its normalized hash matches, else `duplicate_conflict`.
 * INSERT ... ON CONFLICT DO NOTHING makes this safe under concurrent retries.
 * Throws DeviceAccountConflict, which rolls the transaction back, when the device has another owner.
 */
export async function storeReading(client: PoolClient, eventId: string, o: Accepted): Promise<StoreResult> {
  const r = o.reading;
  const recordedAt = new Date(r.timestampMs).toISOString();

  // One upsert for the device row. account_id is set once, by the first write that carries an
  // account, and a payload never changes it after that. device_id follows the newest reading.
  // The upsert locks the row, so two tenants racing for a new device cannot both win.
  const device = await client.query<{ account_id: number | null }>(
    `INSERT INTO devices (device_imei, device_id, account_id, provider, type, last_reading_at)
     VALUES ($1, $2, $3, 'Tive', 'Active', $4)
     ON CONFLICT (device_imei) DO UPDATE SET
       account_id = COALESCE(devices.account_id, EXCLUDED.account_id),
       device_id = CASE WHEN devices.last_reading_at IS NULL OR EXCLUDED.last_reading_at > devices.last_reading_at
                        THEN EXCLUDED.device_id ELSE devices.device_id END,
       last_reading_at = GREATEST(devices.last_reading_at, EXCLUDED.last_reading_at),
       last_seen_at = now()
     RETURNING account_id`,
    [r.deviceImei, r.deviceName, r.accountId, recordedAt],
  );
  const deviceAccountId = device.rows[0]!.account_id;
  if (r.accountId !== null && r.accountId !== deviceAccountId) throw new DeviceAccountConflict(r.deviceImei);
  // A reading without an account (unscoped key, no AccountId) takes the device's account.
  const accountId = deviceAccountId;

  const sensor = o.sensor;
  const accel = sensor.accelerometer;
  const inserted = await client.query<{ id: number }>(
    `INSERT INTO sensor_readings (event_id, device_imei, device_id, timestamp_ms, recorded_at, provider, type,
        temperature_c, humidity_pct, light_lux, accel_x, accel_y, accel_z, accel_magnitude, probe_temperature_c,
        account_id, shipment_id, public_shipment_id, payload_hash, payload)
     VALUES ($1, $2, $3, $4, $5, 'Tive', 'Active', $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18::jsonb)
     ON CONFLICT (device_imei, timestamp_ms) DO NOTHING
     RETURNING id`,
    [
      eventId, r.deviceImei, r.deviceName, r.timestampMs, recordedAt,
      sensor.temperature, sensor.humidity, sensor.light_level,
      accel?.x ?? null, accel?.y ?? null, accel?.z ?? null, accel?.magnitude ?? null,
      roundOrNull(r.probeTemperatureC, 2),
      accountId, r.shipmentId, r.publicShipmentId, o.payloadHash, JSON.stringify(sensor),
    ],
  );

  const sensorId = inserted.rows[0]?.id ?? null;
  if (sensorId === null) return resolveDuplicate(client, eventId, o);

  let locationId: number | null = null;
  const loc = o.location;
  const warnings = [...o.warnings];
  if (loc !== null) {
    const l = r.location!;
    const insertedLoc = await client.query<{ id: number }>(
      `INSERT INTO location_readings (event_id, device_imei, device_id, timestamp_ms, recorded_at, provider, type,
          latitude, longitude, altitude, accuracy_m, accuracy_category, location_source, address, battery_pct,
          cellular_dbm, wifi_access_points, account_id, shipment_id, public_shipment_id, payload_hash, payload)
       VALUES ($1, $2, $3, $4, $5, 'Tive', 'Active', $6, $7, NULL, $8, $9, $10, $11::jsonb, $12, $13, $14, $15, $16, $17, $18, $19::jsonb)
       ON CONFLICT (device_imei, timestamp_ms) DO NOTHING
       RETURNING id`,
      [
        eventId, r.deviceImei, r.deviceName, r.timestampMs, recordedAt,
        loc.latitude, loc.longitude, loc.location_accuracy, loc.location_accuracy_category, loc.location_source,
        loc.address === null ? null : JSON.stringify(loc.address), l.batteryPct, loc.cellular_dbm, loc.wifi_access_points,
        accountId, r.shipmentId, r.publicShipmentId, o.payloadHash, JSON.stringify(loc),
      ],
    );
    locationId = insertedLoc.rows[0]?.id ?? null;
    if (locationId === null) {
      // Only reachable if a location row exists without its sensor row (manual data repair).
      warnings.push({ code: 'LOCATION_DUPLICATE', path: 'Location', message: 'A location row already exists for this device and timestamp; kept the existing row' });
    }
  }

  const status: StoreStatus = locationId !== null ? 'processed' : 'partial';
  await finalizeEvent(client, eventId, {
    status, httpStatus: HTTP_BY_STATUS[status], errors: [], warnings,
    sensorReadingId: sensorId, locationReadingId: locationId,
  });
  return { status, sensorId, locationId, duplicateOf: null, warnings };
}

async function resolveDuplicate(client: PoolClient, eventId: string, o: Accepted): Promise<StoreResult> {
  const key = [o.reading.deviceImei, o.reading.timestampMs];
  const existing = await client.query<{ id: number; payload_hash: string; event_id: string }>(
    'SELECT id, payload_hash, event_id FROM sensor_readings WHERE device_imei = $1 AND timestamp_ms = $2',
    key,
  );
  const first = existing.rows[0];
  if (!first) throw new Error('sensor row vanished during duplicate check');
  const loc = await client.query<{ id: number }>(
    'SELECT id FROM location_readings WHERE device_imei = $1 AND timestamp_ms = $2',
    key,
  );
  const locationReadingId = loc.rows[0]?.id ?? null;
  const status: StoreStatus = first.payload_hash === o.payloadHash ? 'duplicate' : 'duplicate_conflict';
  const warnings = [...o.warnings];
  if (status === 'duplicate_conflict') {
    warnings.push({
      code: 'DUPLICATE_CONFLICT',
      path: '',
      message: `A reading for this device and timestamp already exists with different content (sensor reading ${first.id}); the first write is kept and this payload is stored only in the event log`,
    });
  }
  await finalizeEvent(client, eventId, {
    status, httpStatus: HTTP_BY_STATUS[status], errors: [], warnings,
    sensorReadingId: first.id, locationReadingId,
  });
  return {
    status,
    sensorId: null,
    locationId: null,
    duplicateOf: { sensorReadingId: first.id, locationReadingId, eventId: first.event_id },
    warnings,
  };
}

export interface DeviceReadings {
  device: Record<string, unknown>;
  sensor: unknown[];
  location: unknown[];
}

/** Latest readings for a device. A scoped key (accountId set) sees only its own device and readings. */
export async function getDeviceReadings(
  pool: Pool,
  imei: string,
  limit: number,
  accountId: number | null,
): Promise<DeviceReadings | null> {
  const device = await pool.query(
    `SELECT device_imei, device_id, account_id, provider, type, first_seen_at, last_seen_at, last_reading_at
     FROM devices WHERE device_imei = $1 AND ($2::bigint IS NULL OR account_id = $2)`,
    [imei, accountId],
  );
  if (!device.rows[0]) return null;
  const [sensor, location] = await Promise.all([
    pool.query(
      `SELECT id, event_id, timestamp_ms, recorded_at, probe_temperature_c, shipment_id, public_shipment_id, created_at, payload
       FROM sensor_readings WHERE device_imei = $1 AND ($3::bigint IS NULL OR account_id = $3)
       ORDER BY recorded_at DESC LIMIT $2`,
      [imei, limit, accountId],
    ),
    pool.query(
      `SELECT id, event_id, timestamp_ms, recorded_at, shipment_id, public_shipment_id, created_at, payload
       FROM location_readings WHERE device_imei = $1 AND ($3::bigint IS NULL OR account_id = $3)
       ORDER BY recorded_at DESC LIMIT $2`,
      [imei, limit, accountId],
    ),
  ]);
  return { device: device.rows[0] as Record<string, unknown>, sensor: sensor.rows, location: location.rows };
}

export type { Pool };
