# Decisions and assumptions

The design lives in `docs/DESIGN-SPEC.md`. This file lists each decision with one line of
rationale. Items marked **(beyond spec)** add to the spec. Items marked **(deviation)**
change it. No item changes the response fields that the spec defines.

## Architecture

- **Synchronous processing in the request.** Payloads are small, the sender gets an exact
  result, and a non-2xx tells Tive to retry. At higher volume, move to "persist raw, return
  202, queue worker". `webhook_events` already works as the outbox for that.
- **Pure transform layer (`src/transform/`).** Normalize, validate, clean, map and schema-check
  are pure functions with an injected clock, so every rule has a unit test with no database.
- **Hono + `@hono/node-server`, `pg`, pino, ajv, vitest.** This is the spec stack. It has few
  dependencies and no ORM, so the SQL is clear and reviewable.
- **Migrations run at boot and through `npm run migrate`.** Each file runs in its own
  transaction that first takes `pg_advisory_xact_lock`, so two instances in a rolling deploy
  apply each file once. The runner checks `schema_migrations` again after it gets the lock.
  A transaction lock (not a session lock) is freed by COMMIT or ROLLBACK, so a crash cannot leak
  it, and it works through a transaction-mode pooler.
- **Migration timeouts:** `SET LOCAL statement_timeout = 0` (DDL and the wait for another
  instance may be slow), then `SET LOCAL lock_timeout = '5s'` once the advisory lock is held, so
  a busy table fails the migration instead of making live queries queue behind it.
- **Known limits of the runner:** no checksum (an edited applied file is not detected, so 001 is
  never edited), and every file runs inside `BEGIN`, so `CREATE INDEX CONCURRENTLY` cannot be
  used. At this size a plain `CREATE INDEX` is fine.
- **(beyond spec) `DATABASE_URL_DIRECT` (optional).** When `DATABASE_URL` goes through a pooler,
  migrations (boot, `migrate`, `create-key`) use this direct URL instead.
- **Pool session settings are sent with `SET` after connect, not as startup parameters:**
  `statement_timeout` 10 s and `idle_in_transaction_session_timeout` 15 s. The Neon pooler rejects
  a `statement_timeout` startup parameter, so the API could not boot on the pooled URL. Even
  now, use the direct URL for the app: PgBouncer in transaction mode does not keep session
  settings, so the timeouts would not hold on every transaction.

## Ingest pipeline

- **The audit row is written first, with status `failed`/500, then updated.** If the process
  dies mid-item, the row is still correct, and the raw body is still kept for replay.
- **The status update and the reading inserts share one transaction.** Event status and stored
  rows can never disagree. The final `UPDATE webhook_events` also sets `payload_hash` and
  `device_imei`, so each stored item costs one event update, not two.
- **`processed_at IS NULL` marks a row whose process died mid-item.** Such a row keeps
  `failed`/500 and its raw body, so it can be found and replayed.
- **The event id (UUID) is made in the app, before the audit insert.** If that insert fails (for
  example a dropped connection), the item still gets a result with an `event_id`, status
  `failed` and `INTERNAL_ERROR` ("could not be recorded; send it again"). That id has no row,
  but it is in the error log line. Before this, the error escaped and a batch lost the results
  of every item, including the ones already committed.
- **Batch items run one after another, each in its own transaction.** A repeat inside one batch
  resolves in order (first write wins), and one bad item does not roll back the others. A
  database error in one item gives that item `failed`; the 207 still lists every item.
- **(beyond spec) `NUMERIC_STRING_COERCED` warning.** The spec coerces `"10.5"` silently. A
  warning keeps a record that the sender sent strings, and the status stays `processed`.
- **(beyond spec) `NOT_A_NUMBER` warning code.** The spec says "missing + warning" for a
  non-numeric string but gives no code. This is the code we use. A numeric string that
  overflows to Infinity (`"1e400"`) is also `NOT_A_NUMBER`, not `NUMERIC_STRING_COERCED`.
- **Accuracy falls through units.** When `Accuracy.Meters` is out of range (for example -5), it
  gets `OUT_OF_RANGE` and the next unit (`Kilometers`, then `Miles`) is used. Before, a bad
  `Meters` stopped the fallback and the accuracy was null.
- **`partial` means one of the two records was not stored.** Today that happens only for an
  invalid location. Soft-rule warnings alone (sentinel, out of range) keep `processed`.
- **(beyond spec) Fahrenheit gets the same sentinel and range checks**, through its Celsius
  equivalent. This blocks a bad Fahrenheit value from being used to derive Celsius.
- **`CELSIUS_DERIVED` only when Celsius is missing.** Missing means absent, null, or not a number
  (the spec treats a non-numeric value as missing). A Celsius that was sent but is a sentinel or
  out of range stays null with its warning, and Fahrenheit is not used: the device reported a
  bad sensor, and its Fahrenheit twin comes from the same sensor.
- **(beyond spec) Column-capacity guards.** Lux above 999,999,999, an accelerometer value above
  9,999 in absolute value, and accuracy or Wi-Fi counts above int32 become null with
  `OUT_OF_RANGE`. Without this a nonsense value would overflow a `numeric` column and fail with 500.
- **(beyond spec) A non-integer `AccountId` becomes null with `OUT_OF_RANGE`.** The record is not
  rejected, because AccountId is not a hard rule in the spec.
- **(beyond spec) An `EntryTimeUtc` that is not ISO 8601 with `Z` or an offset gives
  `TIMESTAMP_UTC_UNPARSEABLE`** (it was `TIMESTAMP_MISMATCH`). `Date.parse` reads a value with no
  offset as local time and accepts loose text such as `"2025"`, so the check could warn or stay
  silent for the wrong reason. A `T` or a space between date and time is fine. The epoch stays
  the source of truth.
- **(beyond spec) `PAYLOAD_NOT_OBJECT` (422)** for an item that is not a JSON object, for
  example `42` in a batch.
- **(beyond spec) Request-level rejects use the single-item shape.** Invalid JSON (400,
  `INVALID_JSON`) and a bad batch size (400, `BATCH_SIZE_INVALID`) return
  `{event_id, request_id, status: "rejected", errors: [...]}` and are stored as one rejected event.
- **401, 413, 429 and the Content-Type 415 are not stored as events.** The caller is not trusted
  (401, 429), or the body is not read (413, 415). They are logged with the request id.
- **(beyond spec) Every body that is read leaves an audit row, whatever its bytes.** Before this,
  some bodies gave a 500 with no row at all. The rules, in order:
  - `Content-Encoding` other than `identity` → 415 `UNSUPPORTED_ENCODING`, stored. We do not
    decode gzip: that needs a second size limit against gzip bombs, and Tive sends plain JSON.
  - Bytes that are not UTF-8 (for example gzip without the header) → 400 `INVALID_JSON`.
  - Invalid JSON → 400 `INVALID_JSON`, as before.
  - Objects and arrays nested more than 64 levels → 400 `PAYLOAD_TOO_DEEP`. A Tive payload needs
    4. Deep input broke the jsonb insert and the transform (stack depth).
  - NUL (`\u0000`) in a text field we store (`DeviceId`, `DeviceName`, `ShipmentId`,
    `PublicShipmentId`, `Shipment.Id`, `Location.FormattedAddress`) → 422 `CONTROL_CHARACTER`. A
    lone UTF-16 surrogate there → 422 `INVALID_STRING`. Postgres text and jsonb cannot store
    either, so the insert failed with 500 on every retry. The same text in an unknown or unmapped
    field does not reject the reading: a valid temperature must not be lost over a field we
    ignore. That field lives only in the audit copy, which falls back to `raw_text`.
- **(beyond spec) Where the raw body is kept.** `raw_body` (jsonb) holds parsed JSON. When jsonb
  rejects it (NUL, lone surrogate, SQLSTATE class 22 or 54), the same JSON goes to `raw_text`.
  Text that is not valid JSON goes to `raw_text`. Bytes that Postgres text cannot hold (not
  UTF-8, or a NUL byte) go to the new `raw_bytes` (bytea) column, and `GET /api/events/:id` shows
  them as `raw_base64`. Error and warning messages are stripped of NUL and lone surrogates before
  they are stored, because a `JSON.parse` message can quote the body.
- **Battery and dBm go only into the location record.** PX has no sensor field for them, so an
  invalid location drops them too. The raw payload in `webhook_events` still holds them.
- **`ProbeTemperature` is kept only in `sensor_readings.probe_temperature_c`.** It is never used
  in place of the primary temperature, as the spec says.

- **(beyond spec) Address parsing reads the last part as a state + postal code when it is one**
  (`"Bronx, NY 10474"` has no country), and reads Canadian `"ON M5V 3L9"` as state + postal code.
  A street is the first part when any part comes before the locality and it looks like a
  street. The PX example is unchanged. Other countries keep the part before the country as the
  locality as written (`"London SW1A 2AA"`).

## Idempotency

- **Natural key `(device_imei, timestamp_ms)`. The first write wins for the whole reading.** The
  sensor row marks the key as seen, because every accepted item stores a sensor row.
- **`duplicate` against `duplicate_conflict` uses the SHA-256 of the normalized payload,** with
  keys sorted and the epoch in ms. A resend in seconds of a reading first sent in ms is
  `duplicate`, not a conflict.
- **Only the sensor insert has `ON CONFLICT DO NOTHING`; the location insert is plain.** The
  sensor row is the idempotency gate, so a location row for a new key cannot exist. If one does
  (a manual data repair), the item fails with 500 and rolls back. It used to be stored as
  `partial` with a `LOCATION_DUPLICATE` warning, a branch normal traffic never reached.
- **`INSERT ... ON CONFLICT DO NOTHING`, then a lookup.** Two concurrent identical requests give
  exactly one `processed` and one `duplicate`. The integration test sends 6 at once.
- **(beyond spec) `duplicate_of` in duplicate responses.** `sensor` and `location` stay null as
  the spec says. The new field gives the first write's event id and reading ids, so a retrying
  client can find the stored data. It is an added field, so existing clients are not affected.
- **(beyond spec) `DUPLICATE_CONFLICT` warning on conflicts.** It tells the reader that the
  payload was kept only in the event log. The event row also points at the first write's
  reading ids.
- **`device_id` (the device name) changes only when a newer reading lands.** A late or
  conflicting resend cannot overwrite it with old data. One `INSERT ... ON CONFLICT DO UPDATE`
  keeps the device row; there is no second `UPDATE devices`.

## Auth, limits and multi-tenancy

- **Keys are stored as SHA-256 hashes and found by hash lookup.** A database leak does not
  expose usable keys. Keys are random (192 bits), so a fast hash is enough.
- **`last_used_at` is written at most once a minute per key.** Auth does not write on every
  request.
- **A scoped key (with `account_id`) decides the account of every reading it writes.** The
  payload may leave `AccountId` out (the key's account is stored) or repeat the key's account.
  Any other value, including garbage such as `"abc"` or `1.5`, is `ACCOUNT_MISMATCH` (422).
  Before this, `"abc"` became null in normalize and got past the check.
- **(beyond spec) A device belongs to one account, set once.** The first write that carries an
  account sets `devices.account_id`. After that no payload changes it, not even one sent with
  the unscoped key. A write whose account differs is rejected with `DEVICE_ACCOUNT_CONFLICT`
  (422, path `DeviceId`) and nothing is stored. The message does not name the owner. The check
  runs before the duplicate check, so another tenant cannot learn reading ids through
  `duplicate_of`. A device first written with no account can be claimed once by the next write
  that carries one.
- **A reading with no account (unscoped key, no `AccountId`) takes the device's account.**
- **(beyond spec) A scoped key sees only its own events, its own devices and, on a device, only
  the readings of its own account.** This is the same rule as `ACCOUNT_MISMATCH`, applied to
  reads.
- **The seed key is rotated, not added.** A change to `SEED_API_KEY` replaces the hash of the
  key named `seed`, so the old demo key stops working.
- **The rate limit counts HTTP requests, not batch items, on all `/api/*` routes.** A batch of
  100 costs 1 token. The limit is in memory and per instance. A shared limit needs Redis or a
  Postgres counter.
- **(beyond spec) A per-client-IP limit runs before auth** (`RATE_LIMIT_PER_IP_PER_MIN`, default
  1200). Before this, requests with a bad key were never limited, and each one cost a database
  lookup. It is higher than the per-key limit so that Tive, which sends for many keys from few
  IPs, is limited by key first. The IP is the last `X-Forwarded-For` entry, which Render's proxy
  adds; entries to its left can be forged. Run without a proxy, a client could set that header,
  so this is a flood guard, not a security boundary. Refilled buckets are dropped above 10,000
  IPs, so memory stays bounded. 401 and 429 are still not stored as events.
- **Body limit is 1 MB, enforced while the body streams.** A missing or false `Content-Length`
  does not get around it.
- **A 413 keeps the keep-alive connection usable.** Before it answers, the API reads and drops
  the rest of the body, up to 8 MB and for at most 1 second. Before this, the 413 went out while the client was still
  sending, and the client's next request on that connection failed with "other side closed"
  (about 1 request in 10 with `fetch`). A larger or slower body (for example a `Content-Length`
  larger than what is sent), or a chunked body that the limit middleware is still reading, gets
  `Connection: close` instead. 401 and 415 did not show the
  problem in the same test (100 rounds each), because the Node adapter drains those bodies.

## Database

- **(beyond spec) Added columns:** `webhook_events.batch_index` and `processed_at`, plus
  `account_id`, `shipment_id` and `public_shipment_id` on `location_readings`. These help the
  audit and give the two reading tables the same filters.
- **(beyond spec) Added index** `webhook_events(api_key_id, received_at desc)` for scoped event
  listing, and `devices(account_id)`.
- **(beyond spec) CHECK constraints** on latitude, longitude, battery, accuracy category and
  `timestamp_ms >= 0`. The database is the last guard if a transform bug gets through.
- **`payload jsonb` holds the exact PX document.** Typed columns are for queries. The jsonb is
  what PX consumers get, with no new serialization step.
- **(deviation) `account_id` is `bigint` everywhere (migration 002).** The spec says `int`. A Tive
  `AccountId` above 2^31 - 1 failed the insert with "integer out of range", so the item failed
  with 500 and Tive retried it forever. Values up to 2^53 now store. A larger or non-integer
  `AccountId` becomes null with `OUT_OF_RANGE` (unscoped key) or `ACCOUNT_MISMATCH` (scoped key).
- **Migration 002 is a new file; 001 is never edited.** A database that already ran 001 gets the
  change, and the migration history stays true.
- **(beyond spec) Indexes on `sensor_readings(event_id)` and `location_readings(event_id)`.** The
  foreign keys to `webhook_events` need them, or every event delete scans both tables.
- **(beyond spec) More CHECK constraints (002):** a 15-digit `devices.device_imei`, `provider =
  'Tive'` on the three tables, humidity 0 to 100, and temperature and probe temperature -100 to
  100 °C. These match the soft rules, so a transform bug fails loudly instead of storing bad data.
- **`bigint` and `numeric` are read back as JS numbers.** Ids and epoch ms stay below 2^53, and
  the API returns numbers, not strings.

## Operations

- **(deviation) Compose host port is `${DB_PORT:-5435}`.** The first spec said 5433. Port 5433 is a
  common choice for a second local Postgres or a cloud database proxy, so a copied
  `.env.example` could point at the wrong database. The default is now 5435, and `DB_PORT`
  overrides it.
- **Integration tests run in a throwaway Postgres schema.** `DATABASE_URL` can point at the dev
  database and the tests never touch its data.
- **The Docker image is multi-stage, runs as the non-root `node` user, has no dev
  dependencies, and has a health check.** It follows the usual container hardening steps.
- **(deviation) Render Blueprint with no database; Postgres is on Neon free.** Render free
  Postgres expires after 30 days. `DATABASE_URL` is set by hand (`sync: false`), `SEED_API_KEY`
  is generated by Render (`generateValue`), region `oregon` matches Neon `us-west-2`, and
  `autoDeployTrigger: checksPass` deploys only after CI passes. No secret goes into git.
  Steps: `docs/DEPLOY.md`.
- **The scripts run from compiled JS in the image.** The image has no dev dependencies, so no
  `tsx`. Use `node dist/scripts/migrate.js`, `create-key.js` or `retention.js`. CI runs all three
  in the built image.

- **(beyond spec) `npm run retention` (in the image: `node dist/scripts/retention.js`).** It
  deletes `duplicate`, `duplicate_conflict` and `rejected` events older than
  `RETENTION_EVENT_DAYS` (30), and clears the raw body of `processed` and `partial` events older
  than `RETENTION_RAW_DAYS` (90). It works in batches of `RETENTION_BATCH_SIZE` (1000) rows, so
  no statement holds locks for long. It keeps `failed` events (the replay queue) and the events
  that readings point at. Render free has no cron, so it runs by hand or from a scheduler.
- **Scale path for storage:** at high volume, partition `webhook_events` and the reading tables
  by month on `received_at` / `recorded_at`, and drop old partitions instead of deleting rows.
- **Backups are what the free tier gives, nothing more.** Neon free keeps a short restore window
  (point in time), so the recovery point is that window and the recovery time is a manual
  branch restore. There is no tested restore drill. A paid plan or a `pg_dump` job is the next step.
- **The `/health` check runs `SELECT 1`, so Render's health checks keep the Neon compute awake.**
  That spends Neon free compute hours. It is the price of a health check that tests the database.

## Assumptions about the data

- **Sample "Vaccine Shipment Southbound" has `EntryTimeEpoch` 19:27:26Z but `EntryTimeUtc`
  14:27:26Z.** We keep the epoch and warn with `TIMESTAMP_MISMATCH`.
- **Samples "Device A571992 Reading" and "Device A571992 Follow-up Reading" share a key with
  "Standard Temperature Shipment".** In file order they are `duplicate_conflict`. Sent alone, they
  are `partial` (invalid latitude 95 and longitude -200).
- **`DeviceId` must be a string.** A numeric IMEI is rejected, because JSON numbers can lose
  digits and the Tive schema says string.
- **`EntityName` is a label the user can edit, so it is never mapped or used as an id.**
