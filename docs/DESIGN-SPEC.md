# Design spec: PAXAFE Tive integration (shared by both apps)

This spec is the contract for both repos. Source brief: `docs/EXERCISE.md`.
Schemas: `schemas/tive-incoming-schema.json` (input), `schemas/px-sensor-schema.json`
and `schemas/px-location-schema.json` (output), `schemas/sample-tive-payloads.json`.

## Stack (both apps)

- TypeScript, Node 22+ (ESM), Hono + `@hono/node-server`, `vitest` for tests.
- Integration API database: PostgreSQL (`pg`). Local: `docker compose up -d db`
  (postgres:16, port 5435 on the host to avoid clashes). Deploy: Render web service +
  Neon or Render Postgres. Config only through env vars (`DATABASE_URL`, `PORT`,
  `SEED_API_KEY`, `LOG_LEVEL`). Provide `.env.example`, `Dockerfile`, `render.yaml`.
- Structured JSON logs (pino) with a request id (`X-Request-Id`, generated when absent).
- Plain SQL migrations in `migrations/NNN_name.sql`, applied by a small runner
  (`npm run migrate`, also run at boot) that tracks `schema_migrations`.

## Integration API endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/webhook/tive` | API key | Ingest one Tive payload, or an array of up to 100 |
| GET | `/api/events?limit=50&status=` | API key | Recent ingest events (audit log) |
| GET | `/api/events/:id` | API key | One event with raw body, errors, warnings, output ids |
| GET | `/api/devices/:imei/readings?limit=50` | API key | Latest sensor + location rows for a device |
| GET | `/health` | none | Liveness plus a DB `select 1` (503 when the DB is down) |

Auth: header `X-API-Key: <key>` (also accept `Authorization: Bearer <key>`). Keys are
stored as SHA-256 hashes in `api_keys`, compared by hash lookup, never logged. A key can
have `account_id` (nullable). When set, a payload whose `AccountId` is present and
different is rejected with code `ACCOUNT_MISMATCH`. `revoked_at` set → 401.
`npm run create-key -- <name> [accountId]` prints a new key once. At boot, if
`SEED_API_KEY` is set, upsert it as key `seed` (unscoped) so the deployed demo key works.

Limits: body max 1 MB (413), `Content-Type` must be JSON (415), invalid JSON (400,
still logged as a rejected event with the raw text). Simple per-key in-memory token
bucket (default 600 req/min, 429 with `Retry-After`), documented as per-instance only.

## Processing pipeline (sync)

Decision: process synchronously inside the request. Payloads are small, the sender gets
a precise result, and a non-2xx tells Tive to retry. Documented tradeoff: at higher
volume, move to "persist raw → 202 → queue worker"; the `webhook_events` table is
already the outbox for that.

For each item:
1. Insert a `webhook_events` row with the raw body first (audit and replay, even for
   rejects).
2. `normalize`: coerce numeric strings on known numeric paths (`"10.5"` → 10.5,
   `"-100"` → -100). Non-numeric strings on numeric paths → treated as missing + warning.
3. `validate` hard rules → reject with HTTP 422 and coded errors when violated:
   - `DeviceId` present and matches `^[0-9]{15}$` (`DEVICE_ID_INVALID`). No IMEI
     guessing from DeviceName/EntityName (samples "Device Name Only" and
     "Entity and Device Name" must be rejected).
   - `DeviceName` non-empty string (`DEVICE_NAME_MISSING`).
   - `EntryTimeEpoch` integer ≥ 0 (`TIMESTAMP_INVALID`). If < 1e11 treat it as
     seconds and multiply by 1000, with warning `TIMESTAMP_SECONDS_COERCED`
     (sample "Biologics Replenishment Shipment"). If `EntryTimeUtc` is present and
     differs from the final epoch by more than 1 s, add warning `TIMESTAMP_MISMATCH`
     and keep the epoch. Reject when more than 24 h in the future (`TIMESTAMP_FUTURE`).
   - `Temperature` is an object (`TEMPERATURE_MISSING`); `Location` is an object
     (`LOCATION_MISSING`).
4. Soft rules → the field becomes `null` with a coded warning, the record survives:
   - Sensor sentinel values (`327.67`, `-327.68`, `32767`, `-32768`, `-3276.8`,
     `3276.7`) on any temperature → null, `SENSOR_SENTINEL`. Also outside
     [-100, 100] °C → null, `OUT_OF_RANGE`.
   - `Temperature.Celsius` null but `Fahrenheit` valid → derive Celsius, warning
     `CELSIUS_DERIVED`. Never substitute the probe for the primary temperature.
   - Humidity outside 0–100, Lux < 0, battery outside 0–100 or non-integer,
     Dbm outside -150..-50 → null + `OUT_OF_RANGE`.
5. Location validity: lat in [-90, 90], lon in [-180, 180], not both 0. When invalid,
   skip the location record (warning `LOCATION_INVALID`) but still store the sensor
   record. Rationale: a valid temperature reading is the cold-chain signal and must not
   be lost because of a bad GPS fix. Result status is `partial`.
6. Transform to PX sensor + PX location payloads (mapping below), then validate both
   with ajv against the provided PX schemas before insert (defense in depth;
   failure → 500 `OUTPUT_SCHEMA_VIOLATION`, which is a bug).
7. Insert in one transaction: upsert `devices`, insert sensor and location rows with
   `ON CONFLICT (device_imei, timestamp_ms) DO NOTHING`. Update the event row with
   status, warnings, errors and output ids.

Idempotency: natural key `(device_imei, timestamp_ms)` per table. First write wins.
A repeat with identical content (same SHA-256 of the normalized payload) is
`duplicate`. A repeat with different content for the same key is `duplicate_conflict`
(kept for review in `webhook_events`, not overwritten). Samples "Device A571992
Reading" and "Device A571992 Follow-up Reading" share key with "Standard Temperature
Shipment".

## Mapping (Tive → PAXAFE)

Rounding: round half away from zero (`-0.5625` → `-0.563`, `0.6875` → `0.688`).
Use a helper safe against float error (for example `1.005` → `1.01`).

Sensor:
- `device_id` ← `DeviceName`; `device_imei` ← `DeviceId`; `timestamp` ← normalized ms
- `provider` = `"Tive"`, `type` = `"Active"`
- `temperature` ← `Temperature.Celsius` (2 dp, nullable)
- `humidity` ← `Humidity.Percentage` (1 dp); `light_level` ← `Light.Lux` (1 dp)
- `accelerometer` ← `{x: X, y: Y, z: Z, magnitude: G}` (3 dp each); null when the
  object is missing or all four values are null
- `tilt` = null, `box_open` = null
- `EntityName` is not mapped (user-editable label). `ProbeTemperature` has no PX field:
  store it in column `probe_temperature_c` only.

Location:
- identity and timestamp as above; `latitude`, `longitude` unrounded
- `altitude` = null (Tive does not send it)
- `location_accuracy` ← round(`Accuracy.Meters`), fallback `Kilometers*1000`, then
  `Miles*1609.344`; integer
- `location_accuracy_category`: ≤ 100 m `High`, ≤ 1000 m `Medium`, else `Low`; null
  when accuracy is null
- `location_source` ← `LocationMethod`: gps→`GPS`, wifi→`WiFi`, cell→`Cellular`, else null
- `address` ← parse `Location.FormattedAddress`, null when absent. Split on commas
  and trim. Last part = `country`. If the second-last part matches
  `^([A-Z]{2})\s+(\d{5}(-\d{4})?)$` → `state`, `postal_code`, and the part before it
  = `locality`. Otherwise, with 2+ parts, second-last = `locality`. `street` = first
  part only when there are 4+ parts and it looks like a street (starts with a number
  and ends with a street suffix such as St, Rd, Ave, Blvd, Dr, Ln, Way, Hwy, Pkwy, Ct,
  Pl, Street, Road, Avenue). `full_address` = the original string. This reproduces the
  PX example exactly: `"114 Hunts Point Market, Bronx, NY 10474, USA"` →
  street null, locality Bronx, state NY, postal 10474, country USA.
- `battery_level` ← `Battery.Percentage`; `cellular_dbm` ← `Cellular.Dbm` (2 dp)
- `cellular_network_type`, `cellular_operator` = null (not in Tive)
- `wifi_access_points` ← `Location.WifiAccessPointUsedCount`

## Database

- `api_keys(id uuid pk, name, key_hash char(64) unique, account_id int null,
  created_at, last_used_at, revoked_at)`
- `webhook_events(id uuid pk, received_at timestamptz, api_key_id fk, request_id,
  status text check in (processed, partial, duplicate, duplicate_conflict, rejected,
  failed), http_status int, raw_body jsonb null, raw_text text null, payload_hash,
  device_imei null, errors jsonb, warnings jsonb, sensor_reading_id, location_reading_id)`
  with indexes on `(received_at desc)`, `(status, received_at desc)`, `(device_imei)`.
- `devices(device_imei pk, device_id, account_id, provider, type, first_seen_at,
  last_seen_at, last_reading_at)`
- `sensor_readings(id bigserial pk, event_id fk, device_imei fk, device_id,
  timestamp_ms bigint, recorded_at timestamptz, provider, type, temperature_c
  numeric(5,2), humidity_pct numeric(4,1), light_lux numeric(10,1), accel_x/y/z/
  magnitude numeric(7,3), probe_temperature_c numeric(5,2), account_id, shipment_id,
  public_shipment_id, payload_hash, payload jsonb (the exact PX sensor document),
  created_at, unique(device_imei, timestamp_ms))`, index `(device_imei, recorded_at desc)`
- `location_readings(... latitude/longitude double precision, altitude, accuracy_m int,
  accuracy_category, location_source, address jsonb, battery_pct smallint,
  cellular_dbm numeric(6,2), wifi_access_points int, payload jsonb, same unique key
  and index)`

## Response contract

Single item, HTTP status by outcome:
- 201 `processed` or `partial`; 200 `duplicate` or `duplicate_conflict`;
  422 `rejected`; 500 `failed`.

```json
{
  "event_id": "uuid",
  "request_id": "string",
  "status": "processed|partial|duplicate|duplicate_conflict|rejected|failed",
  "sensor": { "id": 1, "payload": { "...PX sensor..." } } ,
  "location": { "id": 1, "payload": { "...PX location..." } },
  "warnings": [{ "code": "SENSOR_SENTINEL", "path": "ProbeTemperature.Celsius", "message": "..." }],
  "errors": [{ "code": "DEVICE_ID_INVALID", "path": "DeviceId", "message": "..." }]
}
```

`sensor` or `location` is null when not stored. Array body → HTTP 207 with
`{ "results": [ ...one object per item, same order... ], "summary": {status: count} }`.
Empty array or more than 100 items → 400. Auth errors: 401 `{ "error": "unauthorized" }`.

## Tests (required)

- Unit tests for every mapping and rounding rule, the address parser, sentinels,
  epoch-seconds coercion and numeric-string coercion.
- Contract test: run every sample in `schemas/sample-tive-payloads.json` through the
  transformer and assert the expected outcome per sample (rejected / partial /
  processed + specific warnings), and that every produced output passes ajv against the
  PX schemas.
- Golden test: the first sample ("Standard Temperature Shipment") must produce exactly
  the `examples[0]` documents in `px-sensor-schema.json` and `px-location-schema.json`
  (deep equality).
- Integration tests (run when `DATABASE_URL` is set): auth, 401/413/415/400, duplicates,
  conflicts, partial, batch 207.

## Mock Tive Sender

Separate repo, no database. A Hono server that serves a single page UI and a small
JSON API. The sender stores the target URL and API key in server env vars
(`TARGET_URL`, `TARGET_API_KEY`), so the browser never sees the key. The UI may let a
user override both for testing.

Scenarios to generate (each one schema-shaped):
- `realistic`: N readings from a small simulated fleet moving along real lanes
  (for example Pharr TX → Bronx NY) with 2–8 °C temperature plus noise, an optional
  excursion, battery drain, random location method, 15-minute spacing.
- `samples`: send the provided sample payloads one by one.
- Edge cases: invalid coordinates, missing DeviceId, epoch in seconds, numeric strings,
  sentinel probe, duplicate resend, conflicting resend, future timestamp, malformed
  JSON, wrong API key, oversized body, batch of K.

UI: pick a scenario and count, send, then a results table (scenario, HTTP status, API
status, warnings and errors count, latency, event id) with an expandable request and
response JSON. Add a "verify" button that calls `GET /api/devices/:imei/readings`
through the sender backend. Also a CLI: `npm run send -- --scenario realistic --count 20`.
Unit tests for the generators (each generated valid payload passes ajv against the
Tive schema; edge-case payloads break exactly the intended rule).
