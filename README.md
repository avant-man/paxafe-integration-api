# PAXAFE Integration API

This service receives Tive webhook payloads at `POST /api/webhook/tive`. It checks each
payload and transforms it into one PAXAFE sensor document and one PAXAFE location document.
It stores both in PostgreSQL, together with an audit row for every request it reads. The
response tells the sender exactly what happened, with coded errors and warnings. A separate
repo, `paxafe-mock-tive-sender`, generates payloads and sends them here.

## Live deployment

```text
Integration API:  <API_URL>
Mock Tive sender: <SENDER_URL>
Test API key:     <TEST_API_KEY>
```

The deploy step fills in these values. Send the key as `X-API-Key: <TEST_API_KEY>`.
A free Render service sleeps after 15 minutes. The first request can take about 1 minute.

Other documents:

- [`docs/DECISIONS.md`](docs/DECISIONS.md): every decision and assumption, with the reason (long version of section 5).
- [`docs/DESIGN-SPEC.md`](docs/DESIGN-SPEC.md): the design contract for both repos.
- [`docs/DEPLOY.md`](docs/DEPLOY.md): the deploy and operations runbook (Render and Neon).
- [`docs/EXERCISE.md`](docs/EXERCISE.md): the exercise brief.
- [`schemas/`](schemas): the Tive and PX schemas and the 13 sample payloads.

## Contents

1. [Quick start (local)](#1-quick-start-local)
2. [Architecture](#2-architecture)
3. [API reference](#3-api-reference)
4. [Mapping Tive to PAXAFE](#4-mapping-tive-to-paxafe)
5. [Assumptions and decisions](#5-assumptions-and-decisions)
6. [Database design](#6-database-design)
7. [Testing](#7-testing)
8. [Deployment and operations](#8-deployment-and-operations)
9. [Known limits and next steps](#9-known-limits-and-next-steps)

## 1. Quick start (local)

You need Node.js 22 or later and Docker.

```bash
npm install
cp .env.example .env
docker compose up -d db                  # postgres:16 on host port DB_PORT (default 5435)
npm run migrate                          # applies migrations/*.sql (boot also runs them)
npm run create-key -- local-dev          # prints a new api_key once, keep it
SEED_API_KEY=test-key-local npm run dev  # http://localhost:3000, key "test-key-local" also works
```

**Host port 5435 is taken?** Docker Compose reads `DB_PORT` from `.env`, and the app reads
`DATABASE_URL` from `.env`. Both name port 5435, so change both before `docker compose up`:

```bash
sed -i.bak 's/5435/5436/g' .env          # DB_PORT=5436 and DATABASE_URL=...@localhost:5436/paxafe
```

**Port 3000 is taken?** Start the API with another port, for example `PORT=3300 npm run dev`.
Real environment variables win over `.env`.

Send the first sample payload in a second terminal:

```bash
curl -s -X POST http://localhost:3000/api/webhook/tive \
  -H 'Content-Type: application/json' -H 'X-API-Key: test-key-local' \
  -d "$(node -e "console.log(JSON.stringify(require('./schemas/sample-tive-payloads.json').payloads[0].payload))")"
```

The first send answers `201` with `"status":"processed"` and both PX documents. Send it
again and the answer is `200` with `"status":"duplicate"` and a `duplicate_of` block.

Read the data back:

```bash
curl -s -H 'X-API-Key: test-key-local' 'http://localhost:3000/api/events?limit=5'
curl -s -H 'X-API-Key: test-key-local' 'http://localhost:3000/api/devices/863257063350583/readings?limit=5'
```

### Scripts

| Script | What it does |
|---|---|
| `npm run dev` | Starts the API with reload (tsx) |
| `npm run build` then `npm start` | Compiles to `dist/` and runs the compiled code |
| `npm run migrate` | Applies new files in `migrations/` |
| `npm run create-key -- <name> [accountId]` | Creates a key and prints it once. With `accountId` the key is scoped to that account |
| `npm run retention` | Deletes old repeat and reject events and clears old raw bodies |
| `npm test` | Runs the unit tests. The integration tests also run when a database URL is set (section 7) |
| `npm run typecheck` / `npm run lint` | `tsc --noEmit` / ESLint |

### Configuration

| Variable | Default | Notes |
|---|---|---|
| `DATABASE_URL` | none, required | Postgres connection string. Use `sslmode=verify-full` for Neon |
| `DATABASE_URL_DIRECT` | empty | Direct (unpooled) URL. Migrations use it when `DATABASE_URL` goes through a pooler |
| `PORT` | `3000` | HTTP port |
| `LOG_LEVEL` | `info` | pino log level |
| `SEED_API_KEY` | empty | When set, boot stores it as the unscoped key named `seed` |
| `RATE_LIMIT_PER_MIN` | `600` | Requests per key per minute, per instance |
| `RATE_LIMIT_PER_IP_PER_MIN` | `1200` | Requests per client IP per minute, checked before auth |
| `DB_PORT` | `5435` | Host port of the Compose database. Docker Compose reads it, the app does not |
| `RETENTION_EVENT_DAYS` / `RETENTION_RAW_DAYS` / `RETENTION_BATCH_SIZE` | `30` / `90` / `1000` | Used only by `npm run retention` |

## 2. Architecture

```text
Tive or the mock sender
  |  POST /api/webhook/tive   (JSON body, X-API-Key)
  v
request context ........ X-Request-Id (kept when safe, else generated), one JSON log line
per-IP token bucket .... 429 + Retry-After
API key auth ........... SHA-256 hash lookup; missing, unknown or revoked key -> 401
per-key token bucket ... 429 + Retry-After
Content-Type check ..... not JSON -> 415
body limit 1 MB ........ 413 (enforced while the body streams)
decode and parse ....... encoding, UTF-8, JSON, depth, batch size -> 400 or 415, stored as a rejected event
  |
  v  for each item, one after another
  1. INSERT webhook_events   raw body first, status failed/500 until step 3
  2. transformPayload        normalize -> validate -> clean -> map -> ajv check of the PX output (pure, no I/O)
       a hard rule fails ... UPDATE the event to rejected/422, stop
  3. one transaction         upsert devices
                             INSERT sensor_readings ... ON CONFLICT (device_imei, timestamp_ms) DO NOTHING
                             INSERT location_readings (skipped when the location is invalid)
                             UPDATE webhook_events with status, warnings and reading ids
  v
201 processed or partial | 200 duplicate or duplicate_conflict | 422 rejected | 500 failed
an array body gets 207 with one result per item, in order
```

Code layout:

```text
src/transform/   pure functions: normalize, validate, clean, map, address, round, hash, PX schema check
src/db/          pg pool, migration runner, repositories (keys, events, readings, retention)
src/http/        Hono app, auth, rate limits, request id and logging, routes, body helpers
src/ingest.ts    one item: audit row -> transform -> transactional store
src/scripts/     migrate, create-key, retention
migrations/      plain SQL (001_init, 002_bigint_accounts_indexes_checks)
```

### Why synchronous processing

- A Tive payload is small, and the transform is pure code with no I/O.
- The sender gets the exact result in the same response: status, PX documents, codes.
- A non-2xx answer tells Tive to retry. Idempotency makes the retry safe.
- One process and one database are simple to run on a free tier.

### Why the raw event comes first

The API writes the `webhook_events` row before it transforms anything. That row works as an
outbox and an audit log:

- Every request that the API reads leaves a row, also rejects and invalid JSON.
- A row starts as `failed`/500. A process that dies mid-item leaves an honest row with its raw body, ready for replay.
- The final status update and the reading inserts share one transaction, so they never disagree.
- The move to asynchronous processing at higher volume is small. Keep step 1, return 202,
  and let a worker run steps 2 and 3 from the stored rows.

## 3. API reference

### Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/webhook/tive` | API key | Ingest one payload (JSON object) or a batch (JSON array of 1 to 100 objects) |
| GET | `/api/events?limit=50&status=` | API key | Recent ingest events, newest first, without raw bodies. `limit` 1 to 200 |
| GET | `/api/events/:id` | API key | One event with its raw body (`raw_body`, `raw_text` or `raw_base64`), errors, warnings and reading ids |
| GET | `/api/devices/:imei/readings?limit=50` | API key | The device row and its latest sensor and location rows. `limit` 1 to 200 |
| GET | `/health` | none | Runs `SELECT 1`. `200 {"status":"ok","db":"ok"}`, or `503` when the database is down or slower than 2 s |
| GET | `/` | none | Service name and the endpoint list |

`status` filters by one of `processed`, `partial`, `duplicate`, `duplicate_conflict`,
`rejected`, `failed`.

### Authentication

- Send `X-API-Key: <key>` or `Authorization: Bearer <key>`.
- The database stores only the SHA-256 hash of a key. The logs never contain the key.
- A missing, unknown or revoked key gets `401 {"error":"unauthorized"}`.
- An unscoped key (no account) can write and read every account.
- A scoped key (with an account id) writes only its own account. It reads only its own
  events, its own account's devices and that account's readings.

### Status codes for `POST /api/webhook/tive`

| HTTP | When | Stored as an event |
|---|---|---|
| 201 | `processed` (sensor and location stored) or `partial` (sensor stored, location invalid) | yes |
| 200 | `duplicate` (same key, same content) or `duplicate_conflict` (same key, other content) | yes |
| 207 | Array body. `results` has one item result per element, in order, plus `summary` | yes, one row per element |
| 400 | `INVALID_JSON`, `PAYLOAD_TOO_DEEP` or `BATCH_SIZE_INVALID` | yes, as `rejected` |
| 401 | Missing, unknown or revoked key | no |
| 413 | Body above 1 MB (1,048,576 bytes) | no |
| 415 | `Content-Type` is not JSON | no |
| 415 | `Content-Encoding` is not `identity` (`UNSUPPORTED_ENCODING`) | yes, as `rejected` |
| 422 | `rejected`: a hard rule failed, nothing stored in the reading tables | yes |
| 429 | Rate limit, with `Retry-After` | no |
| 500 | `failed`: database error or a bug. The raw body is kept for replay | yes, when the audit insert worked |

Every response has `X-Request-Id`. Every `/api/*` response has `X-RateLimit-Limit` and
`X-RateLimit-Remaining`.

### Response shape

A single item, and each element of `results` in a 207:

```json
{
  "event_id": "a3855e1f-064a-48ba-a269-4f9a4a86e7fa",
  "request_id": "d5885c68-7691-4c5c-9490-267c8fc5c8d4",
  "status": "processed",
  "sensor": { "id": 1, "payload": { "device_id": "A571992", "device_imei": "863257063350583", "temperature": 10.08 } },
  "location": { "id": 1, "payload": { "latitude": 40.810562, "location_source": "WiFi" } },
  "warnings": [{ "code": "SENSOR_SENTINEL", "path": "ProbeTemperature.Celsius", "message": "..." }],
  "errors": []
}
```

- `sensor.payload` and `location.payload` are the full PX documents (shortened above).
- `sensor` or `location` is `null` when that record was not stored.
- `duplicate` and `duplicate_conflict` add `duplicate_of: { event_id, sensor_reading_id, location_reading_id }`. It points at the first write.
- A batch answers `{ "results": [ ... ], "summary": { "processed": 0, "partial": 0, "duplicate": 0, "duplicate_conflict": 0, "rejected": 0, "failed": 0 } }`.
- Request-level 400 and the stored 415 use the item shape with `status: "rejected"`.

Other errors have a small shape: `{"error":"unauthorized"}` (401),
`{"error":"payload_too_large",...}` (413), `{"error":"unsupported_media_type",...}` (415),
`{"error":"rate_limited","retry_after_seconds":N}` (429), `{"error":"bad_request",...}` (400 on
the read endpoints), `{"error":"not_found"}` (404) and `{"error":"internal_error","request_id":...}` (500).

### Error and warning codes

This table comes from the code strings in `src/` (27 codes).

**Request-level errors.** The whole request is one rejected event.

| Code | HTTP | Meaning | Source |
|---|---|---|---|
| `INVALID_JSON` | 400 | Body is not valid UTF-8, or not valid JSON | `src/http/routes.ts` |
| `PAYLOAD_TOO_DEEP` | 400 | Objects and arrays nest more than 64 levels | `src/http/routes.ts` |
| `BATCH_SIZE_INVALID` | 400 | Array body with 0 or more than 100 items | `src/http/routes.ts` |
| `UNSUPPORTED_ENCODING` | 415 | `Content-Encoding` other than `identity`. The API does not decode gzip | `src/http/routes.ts` |

**Item errors.** The item is `rejected` (422) and no reading is stored.

| Code | Path | Meaning | Source |
|---|---|---|---|
| `PAYLOAD_NOT_OBJECT` | (empty) | The item is not a JSON object, for example `42` in a batch | `src/transform/pipeline.ts` |
| `CONTROL_CHARACTER` | stored text field | NUL (`\u0000`) in `DeviceId`, `DeviceName`, `ShipmentId`, `PublicShipmentId`, `Shipment.Id` or `Location.FormattedAddress` | `src/transform/validate.ts` |
| `INVALID_STRING` | stored text field | A lone UTF-16 surrogate in one of those fields | `src/transform/validate.ts` |
| `DEVICE_ID_INVALID` | `DeviceId` | Missing, not a string, or not 15 digits. Not derived from `DeviceName` or `EntityName` | `src/transform/validate.ts` |
| `DEVICE_NAME_MISSING` | `DeviceName` | Missing or blank | `src/transform/validate.ts` |
| `TIMESTAMP_INVALID` | `EntryTimeEpoch` | Not an integer of 0 or more | `src/transform/validate.ts` |
| `TIMESTAMP_FUTURE` | `EntryTimeEpoch` | More than 24 hours in the future | `src/transform/validate.ts` |
| `TEMPERATURE_MISSING` | `Temperature` | Not an object | `src/transform/validate.ts` |
| `LOCATION_MISSING` | `Location` | Not an object | `src/transform/validate.ts` |
| `ACCOUNT_MISMATCH` | `AccountId` | Scoped key, and `AccountId` is present and not the key's account (also garbage such as `"abc"`) | `src/transform/validate.ts` |
| `DEVICE_ACCOUNT_CONFLICT` | `DeviceId` | The device already belongs to another account | `src/ingest.ts` |

**Item failures.** The item is `failed` (500). The raw body stays in `webhook_events`.

| Code | Meaning | Source |
|---|---|---|
| `OUTPUT_SCHEMA_VIOLATION` | A produced PX document failed the ajv check against the PX schema. This is a bug | `src/ingest.ts` |
| `INTERNAL_ERROR` | Unexpected error, for example a database error. The message says if the raw body was kept or if you must send again | `src/ingest.ts` |

**Warnings.** The record is kept. The named field is changed or set to `null`.

| Code | Effect | Source |
|---|---|---|
| `NUMERIC_STRING_COERCED` | A numeric string on a numeric path (`"10.5"`) became a number | `src/transform/normalize.ts` |
| `NOT_A_NUMBER` | A non-numeric value on a numeric path (or `"1e400"`) is treated as missing | `src/transform/normalize.ts` |
| `TIMESTAMP_SECONDS_COERCED` | `EntryTimeEpoch` below 1e11 is seconds, so it was multiplied by 1000 | `src/transform/validate.ts` |
| `TIMESTAMP_MISMATCH` | `EntryTimeUtc` differs from the epoch by more than 1 s. The epoch is used | `src/transform/validate.ts` |
| `TIMESTAMP_UTC_UNPARSEABLE` | `EntryTimeUtc` is not ISO 8601 with `Z` or an offset. The epoch is used | `src/transform/validate.ts` |
| `SENSOR_SENTINEL` | A temperature is a sensor sentinel (`327.67`, `-327.68`, `32767`, `-32768`, `-3276.8`, `3276.7`) and became `null` | `src/transform/clean.ts` |
| `OUT_OF_RANGE` | A value is outside its range and became `null`. See the ranges below | `src/transform/clean.ts` |
| `CELSIUS_DERIVED` | Celsius was missing, so it was computed from a valid Fahrenheit | `src/transform/clean.ts` |
| `LOCATION_INVALID` | Latitude or longitude missing, out of range, or both 0. The location record is skipped and the status is `partial` | `src/transform/clean.ts` |
| `DUPLICATE_CONFLICT` | Same device and timestamp as a stored reading, other content. The first write is kept | `src/db/readings.ts` |

`OUT_OF_RANGE` ranges: temperature (Celsius, or Fahrenheit through its Celsius value) outside
-100 to 100 °C. Humidity outside 0 to 100. Lux below 0 or above 999,999,999. Accelerometer
values above 9,999 in absolute value. Battery not an integer from 0 to 100. Dbm outside -150 to
-50. Accuracy or Wi-Fi count outside 0 to 2,147,483,647. `AccountId` not an integer.

## 4. Mapping Tive to PAXAFE

**Rounding rule:** round half away from zero (`-0.5625` gives `-0.563`, `0.6875` gives
`0.688`). The helper first clears float noise with `toPrecision(15)`, so `1.005` gives `1.01`
and not `1.00` (`src/transform/round.ts`). Latitude and longitude are not rounded.

### Sensor (`px-sensor-schema.json`)

| PX field | Tive source | Rule |
|---|---|---|
| `device_id` | `DeviceName` | Required, non-empty |
| `device_imei` | `DeviceId` | Required, 15 digits |
| `timestamp` | `EntryTimeEpoch` | Epoch ms. A value below 1e11 is seconds and is multiplied by 1000 |
| `provider` | constant | `"Tive"` |
| `type` | constant | `"Active"` |
| `temperature` | `Temperature.Celsius` | 2 decimals. From `Fahrenheit` only when Celsius is missing. `null` after a sentinel or range warning |
| `humidity` | `Humidity.Percentage` | 1 decimal, 0 to 100 |
| `light_level` | `Light.Lux` | 1 decimal, 0 or more |
| `accelerometer` | `Accelerometer.X`, `.Y`, `.Z`, `.G` | `{x, y, z, magnitude}`, 3 decimals each. `null` when the object is missing or all four are null |
| `tilt`, `box_open` | none | `null`. Tive does not send them |

### Location (`px-location-schema.json`)

| PX field | Tive source | Rule |
|---|---|---|
| `device_id`, `device_imei`, `timestamp`, `provider`, `type` | as for the sensor | same values |
| `latitude` | `Location.Latitude` | -90 to 90, not rounded |
| `longitude` | `Location.Longitude` | -180 to 180, not rounded. Both 0 is invalid |
| `altitude` | none | `null` |
| `location_accuracy` | `Location.Accuracy.Meters`, else `Kilometers` x 1000, else `Miles` x 1609.344 | Whole meters. An out-of-range unit falls through to the next unit |
| `location_accuracy_category` | from `location_accuracy` | 100 m or less `High`, 1000 m or less `Medium`, else `Low`. `null` when accuracy is null |
| `location_source` | `Location.LocationMethod` | `gps` to `GPS`, `wifi` to `WiFi`, `cell` to `Cellular`, else `null` (case insensitive) |
| `address` | `Location.FormattedAddress` | Parsed into `street`, `locality`, `state`, `postal_code`, `country`, `full_address`. `null` when absent |
| `battery_level` | `Battery.Percentage` | Integer 0 to 100 |
| `cellular_dbm` | `Cellular.Dbm` | 2 decimals, -150 to -50 |
| `cellular_network_type`, `cellular_operator` | none | `null`. Tive does not send them |
| `wifi_access_points` | `Location.WifiAccessPointUsedCount` | Integer 0 or more |

Address parsing (`src/transform/address.ts`): split on commas. The last part is the country,
unless it is itself a US or Canadian state plus postal code (`"Bronx, NY 10474"`,
`"ON M5V 3L9"`). The part before the state and postal code is the locality. The first part is
the street only when a part comes before the locality and it starts with a number and ends
with a street suffix. `"114 Hunts Point Market, Bronx, NY 10474, USA"` gives street `null`,
locality `Bronx`, state `NY`, postal code `10474`, country `USA`, as in the PX example.

Not mapped to PX: `EntityName` (a label the user can edit), `ProbeTemperature` (stored in
`sensor_readings.probe_temperature_c` only), `ShipmentId` or `Shipment.Id`,
`PublicShipmentId` and `AccountId` (stored as columns). `Battery` and `Cellular` go only into
the location record, because the PX sensor schema has no field for them.

## 5. Assumptions and decisions

This is the short list. [`docs/DECISIONS.md`](docs/DECISIONS.md) has every decision with its reason.

### The sample payloads

The table comes from a run of all 13 samples through `transformPayload`. "Alone" is the result
when the sample is sent by itself. "In file order" is the result when all 13 go in file order
to an empty database. `tests/unit/pipeline.test.ts` asserts the codes for every sample.

| # | Sample | Trap | Alone | In file order | Codes |
|---|---|---|---|---|---|
| 1 | Standard Temperature Shipment | None. It must match the PX examples exactly (golden test) | processed | processed | none |
| 2 | Device A571992 Reading | Same IMEI and epoch as #1 with other content. Latitude 95 | partial | duplicate_conflict | `LOCATION_INVALID` (+ `DUPLICATE_CONFLICT` in order) |
| 3 | GPS Location Shipment | `gps` maps to `GPS` | processed | processed | none |
| 4 | Vaccine Shipment Checkpoint | Probe Celsius 327.67 is a sentinel. Probe Fahrenheit 621.806 is out of range | processed | processed | `SENSOR_SENTINEL`, `OUT_OF_RANGE` (probe only) |
| 5 | Device Name Only | No `DeviceId`. The IMEI is not guessed from `DeviceName` | rejected | rejected | `DEVICE_ID_INVALID` |
| 6 | Biologics Replenishment Shipment | `EntryTimeEpoch` in seconds | processed | processed | `TIMESTAMP_SECONDS_COERCED` |
| 7 | Cellular Location Only | Probe -32768 is a sentinel. Address `"London, UK"` has no state | processed | processed | `SENSOR_SENTINEL`, `OUT_OF_RANGE` (probe only) |
| 8 | Standard Temperature Shipment Update | `"10.5"`, `"50.9"` and `"-100"` sent as strings | processed | processed | `NUMERIC_STRING_COERCED` x 3 |
| 9 | Device A571992 Follow-up Reading | Same IMEI and epoch as #1 with other content. Longitude -200 | partial | duplicate_conflict | `LOCATION_INVALID` (+ `DUPLICATE_CONFLICT` in order) |
| 10 | Clinical Supply Shipment | `AccountId` 999, the others use 478 | processed | processed | none. With a key scoped to 478: rejected, `ACCOUNT_MISMATCH` |
| 11 | Minimal Data Payload | Probe values null. No accuracy, method or address | processed | processed | none. The missing fields are `null` |
| 12 | Vaccine Shipment Southbound | `EntryTimeUtc` is 5 hours off from `EntryTimeEpoch` | processed | processed | `TIMESTAMP_MISMATCH` |
| 13 | Entity and Device Name | No `DeviceId`. `EntityName` looks like a device name | rejected | rejected | `DEVICE_ID_INVALID` |

A second run of the samples gives `duplicate` for every stored sample. The mock sender accepts
that.

### Other assumptions

- `DeviceId` (the IMEI) is the device identity. It must be a 15-digit string. A JSON number is rejected, because it can lose digits.
- `EntityName` is a label that users can edit. It is never mapped or used as an id.
- The epoch is the source of truth for time. `EntryTimeUtc` only adds a warning when it disagrees.
- An epoch below 1e11 is in seconds (1e11 ms is the year 1973).
- A timestamp more than 24 hours in the future is rejected. A device clock that far ahead is not trusted.
- A valid temperature must survive a bad GPS fix. An invalid location gives `partial`, not a reject.
- Bad sensor values (sentinels, out of range) become `null` with a warning. The record survives.
- The probe temperature never replaces the primary temperature.
- A sent Celsius that fails a check is not replaced from Fahrenheit, because both come from the same sensor.
- Numeric strings are coerced with a warning, so the record shows that the sender sent strings.
- The idempotency key is `(DeviceId, timestamp in ms)`. The first write wins. A repeat with other content is `duplicate_conflict` and stays only in the event log.
- A device belongs to one account, set by the first write that carries an account.
- The API does not decode gzip. Tive sends plain JSON, and decoding needs a second size limit.
- Rate limits are per instance and in memory. The deploy runs one instance.

## 6. Database design

PostgreSQL 16. Plain SQL in `migrations/`. A small runner applies each new file in its own
transaction under `pg_advisory_xact_lock` and records it in `schema_migrations`.

| Table | Primary key | Purpose |
|---|---|---|
| `api_keys` | `id uuid` | `name`, `key_hash char(64) UNIQUE` (SHA-256), `account_id bigint NULL`, `created_at`, `last_used_at`, `revoked_at` |
| `webhook_events` | `id uuid` | One row per item or rejected request: raw body (`raw_body jsonb`, `raw_text`, `raw_bytes bytea`), `status`, `http_status`, `errors`, `warnings`, `payload_hash`, `device_imei`, reading ids, `request_id`, `batch_index`, `received_at`, `processed_at` |
| `devices` | `device_imei` | Latest `DeviceName`, owning `account_id`, first and last seen, newest reading time |
| `sensor_readings` | `id bigserial` | Typed columns for queries plus `payload jsonb`, the exact PX sensor document. `probe_temperature_c`, shipment ids, `account_id`, `payload_hash` |
| `location_readings` | `id bigserial` | Typed columns plus `payload jsonb`, the exact PX location document. `address jsonb`, battery, Dbm, shipment ids, `account_id` |

Keys and constraints:

- `sensor_readings` and `location_readings` have `UNIQUE (device_imei, timestamp_ms)`. This is the idempotency key.
- Foreign keys: readings to `webhook_events` and `devices`. Events to `api_keys` and to their reading rows.
- CHECK constraints are the last guard against a transform bug. They cover status values, latitude, longitude, battery and accuracy category. They also cover `timestamp_ms >= 0`, a 15-digit IMEI, `provider = 'Tive'`, humidity 0 to 100 and temperatures -100 to 100.

Indexes:

- `webhook_events`: `(received_at DESC)`, `(status, received_at DESC)`, `(device_imei)`, `(api_key_id, received_at DESC)`.
- `sensor_readings` and `location_readings`: `(device_imei, recorded_at DESC)` for the device read, `(event_id)` for the foreign key.
- `devices`: `(account_id)`.

**Idempotency.** The sensor insert uses `ON CONFLICT (device_imei, timestamp_ms) DO NOTHING`.
When it inserts nothing, the API looks up the first row. Equal SHA-256 of the normalized
payload gives `duplicate`, else `duplicate_conflict`. The hash uses sorted keys and the epoch in
ms, so a resend in seconds is still a `duplicate`. Six concurrent identical requests give
exactly one `processed` (integration test).

**Tenancy.** A key can be scoped to one `account_id`. A scoped key decides the account of
every reading it writes. `devices.account_id` is set once and never moves. A write for another
account's device is rejected before the duplicate check, so another tenant cannot learn reading ids.
Reads filter by the key's account.

**Retention.** `npm run retention` deletes `duplicate`, `duplicate_conflict` and `rejected`
events older than 30 days. It clears the raw body of `processed` and `partial` events older
than 90 days. It works in batches of 1000 rows. It keeps `failed` events (the replay queue) and
every event that a reading points at. Render free has no cron, so it runs by hand.

**Scale path.**

1. Move to "persist raw, return 202, queue worker". `webhook_events` is already the outbox.
2. Partition `webhook_events` and the reading tables by month on `received_at` and `recorded_at`. Drop old partitions instead of deleting rows.
3. Move the rate limits to Redis or a Postgres counter, so they hold across instances.
4. Add read replicas for the read endpoints. The typed columns and indexes already serve them.

## 7. Testing

```bash
npm test                                                                   # unit tests, 152 pass, 64 integration tests skip
TEST_DATABASE_URL=postgres://paxafe:paxafe@localhost:5435/paxafe npm test  # all 216 tests
npm run typecheck
npm run lint
```

- The integration tests read `TEST_DATABASE_URL`, else `DATABASE_URL`. `npm test` does not read `.env`.
- Change the port in the URL if you moved `DB_PORT`.
- The integration tests create and drop their own Postgres schema, so they do not touch your data.
- CI (`.github/workflows/ci.yml`) runs typecheck, lint, all tests against a Postgres 16 service and the build. It then boots the Docker image and runs the compiled scripts in it.

| Suite | Tests | What it proves |
|---|---|---|
| `tests/unit/pipeline.test.ts` | 29 | Golden test: sample 1 gives exactly the PX schema examples. Contract test: the codes of all 13 samples, and that every output passes ajv. Hash stability, non-object items, tenant account rules, bad text |
| `tests/unit/validate.test.ts` | 38 | Every hard rule: IMEI, name, epoch, seconds, future, UTC mismatch and parse, objects, account mismatch, NUL and surrogates |
| `tests/unit/clean-map.test.ts` | 38 | Sentinels, temperature range and Celsius derivation, other ranges, location validity, accuracy fallback, the PX mapping |
| `tests/unit/round.test.ts` | 18 | Round half away from zero, float noise (`1.005`), no negative zero, tiny values, null |
| `tests/unit/address.test.ts` | 11 | The address parser: the PX example, street rules, ZIP+4, no country, Canadian postal codes, blank input |
| `tests/unit/http-units.test.ts` | 10 | Key extraction, token bucket, client IP, body helpers, 413 drain |
| `tests/unit/normalize.test.ts` | 6 | Numeric string coercion and `NOT_A_NUMBER`, also for overflow |
| `tests/unit/config.test.ts` | 2 | Env parsing and the required `DATABASE_URL` |
| `tests/integration/api.test.ts` | 56 | HTTP and Postgres end to end. Auth (revoked key, Bearer, hashes), 400/413/415 and hostile input. All six outcomes, scoped keys and tenant isolation. Migration 002, batch 207, database failures in one item, read endpoints, both rate limits |
| `tests/integration/db.test.ts` | 5 | Pool session timeouts, migration locking with 2 concurrent runners, rollback of a failed file, retention |
| `tests/integration/keep-alive.test.ts` | 3 | The next request on a keep-alive connection works after a 413, 415 or 401 (100 rounds each) |

The mock sender adds a live contract check: `LIVE_TARGET_URL=http://localhost:3000
LIVE_TARGET_KEY=test-key-local npm test -- contract.live` in that repo sends every scenario here.

## 8. Deployment and operations

The deploy is one Render free web service (Docker, `render.yaml`) and a Neon free Postgres.
[`docs/DEPLOY.md`](docs/DEPLOY.md) has the steps, the smoke test and troubleshooting.

- **Migrations** run at boot, before the server listens. Each file runs once, also with two instances.
- **Health check:** `GET /health` runs `SELECT 1` with a 2 s timeout. Render uses it as `healthCheckPath`.
- **Logs:** JSON lines (pino) on stdout, one per request, with `request_id`, method, path, status and `duration_ms`. Item lines add `event_id` and the codes. Find them in Render > service > Logs.
- **Tracing one request:** take `request_id` or `event_id` from the response. Then search the logs, or call `GET /api/events/:id`.
- **Create a key:** `npm run create-key -- <name> [accountId]` against the database. In the image: `node dist/scripts/create-key.js <name> [accountId]`.
- **Rotate the seed key:** change `SEED_API_KEY` and redeploy. Boot replaces the hash of the key named `seed`, so the old value stops working.
- **Rotate any other key:** create a new key, move the client to it, then revoke the old key.
- **Revoke a key:** there is no revoke command. Set `revoked_at` with SQL. The next request with that key gets 401:

  ```sql
  UPDATE api_keys SET revoked_at = now() WHERE name = 'local-dev' AND revoked_at IS NULL;
  ```

  Locally: `docker compose exec -T db psql -U paxafe -d paxafe -c "<the SQL above>"`. Do not
  revoke the `seed` key this way: the next boot with `SEED_API_KEY` set clears `revoked_at` again.
  Unset or change `SEED_API_KEY` instead.
- **Retention:** `npm run retention` (in the image: `node dist/scripts/retention.js`).
- **Shutdown:** on SIGTERM the API closes the server and the pool. It force-exits after 10 s.

## 9. Known limits and next steps

Known limits:

- Rate limits live in memory, per instance. More instances multiply the limit.
- The per-IP limit trusts the last `X-Forwarded-For` entry. Without a proxy a client can set it. It is a flood guard, not a security boundary.
- Processing is synchronous. A slow database slows the webhook response.
- There is no command to revoke or list keys, and no admin endpoint. SQL does it.
- The migration runner has no checksums. It cannot run `CREATE INDEX CONCURRENTLY`, because every file runs in a transaction.
- No replay command exists yet for `failed` events, although their raw bodies are kept.
- Backups are only the Neon free restore window. There is no tested restore drill.
- Retention does not run on a schedule. Render free has no cron.
- The address parser reads only US and Canadian state and postal formats.
- Free-tier services sleep, so the first request after a pause takes about 1 minute.

With more time, I would:

1. Add `202 Accepted` with a queue worker that reads the `webhook_events` outbox, plus a replay command for `failed` rows.
2. Add key commands (`list-keys`, `revoke-key`) and key expiry.
3. Move rate limits to Redis or Postgres so they hold across instances.
4. Partition the event and reading tables by month.
5. Add metrics (counts by status and code, latency) and an alert on `failed`.
6. Schedule retention and a `pg_dump` backup job, and test a restore.
7. Check Tive webhook signatures, if Tive offers them, in addition to the API key.
