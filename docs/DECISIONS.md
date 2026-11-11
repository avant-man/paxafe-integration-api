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
- **Migrations run at boot and through `npm run migrate`.** A Postgres advisory lock stops two
  instances from applying the same migration during a rolling deploy.

## Ingest pipeline

- **The audit row is written first, with status `failed`/500, then updated.** If the process
  dies mid-item, the row is still correct, and the raw body is still kept for replay.
- **The status update and the reading inserts share one transaction.** Event status and stored
  rows can never disagree.
- **Batch items run one after another, each in its own transaction.** A repeat inside one batch
  resolves in order (first write wins), and one bad item does not roll back the others.
- **(beyond spec) `NUMERIC_STRING_COERCED` warning.** The spec coerces `"10.5"` silently. A
  warning keeps a record that the sender sent strings, and the status stays `processed`.
- **(beyond spec) `NOT_A_NUMBER` warning code.** The spec says "missing + warning" for a
  non-numeric string but gives no code. This is the code we use.
- **`partial` means one of the two records was not stored.** Today that happens only for an
  invalid location. Soft-rule warnings alone (sentinel, out of range) keep `processed`.
- **(beyond spec) Fahrenheit gets the same sentinel and range checks**, through its Celsius
  equivalent. This blocks a bad Fahrenheit value from being used to derive Celsius.
- **(beyond spec) Column-capacity guards.** Lux above 999,999,999, an accelerometer value above
  9,999 in absolute value, and accuracy or Wi-Fi counts above int32 become null with
  `OUT_OF_RANGE`. Without this a nonsense value would overflow a `numeric` column and fail with 500.
- **(beyond spec) A non-integer `AccountId` becomes null with `OUT_OF_RANGE`.** The record is not
  rejected, because AccountId is not a hard rule in the spec.
- **An unparseable `EntryTimeUtc` gives `TIMESTAMP_MISMATCH`.** The epoch stays the source of
  truth, as the spec says for a mismatch.
- **(beyond spec) `PAYLOAD_NOT_OBJECT` (422)** for an item that is not a JSON object, for
  example `42` in a batch.
- **(beyond spec) Request-level rejects use the single-item shape.** Invalid JSON (400,
  `INVALID_JSON`) and a bad batch size (400, `BATCH_SIZE_INVALID`) return
  `{event_id, request_id, status: "rejected", errors: [...]}` and are stored as one rejected event.
- **401, 413, 415 and 429 are not stored as events.** The caller is not trusted (401, 429), or
  the body is not read (413, 415). They are logged with the request id.
- **Battery and dBm go only into the location record.** PX has no sensor field for them, so an
  invalid location drops them too. The raw payload in `webhook_events` still holds them.
- **`ProbeTemperature` is kept only in `sensor_readings.probe_temperature_c`.** It is never used
  in place of the primary temperature, as the spec says.

## Idempotency

- **Natural key `(device_imei, timestamp_ms)`. The first write wins for the whole reading.** The
  sensor row marks the key as seen, because every accepted item stores a sensor row.
- **`duplicate` against `duplicate_conflict` uses the SHA-256 of the normalized payload,** with
  keys sorted and the epoch in ms. A resend in seconds of a reading first sent in ms is
  `duplicate`, not a conflict.
- **`INSERT ... ON CONFLICT DO NOTHING`, then a lookup.** Two concurrent identical requests give
  exactly one `processed` and one `duplicate`. The integration test sends 6 at once.
- **(beyond spec) `duplicate_of` in duplicate responses.** `sensor` and `location` stay null as
  the spec says. The new field gives the first write's event id and reading ids, so a retrying
  client can find the stored data. It is an added field, so existing clients are not affected.
- **(beyond spec) `DUPLICATE_CONFLICT` warning on conflicts.** It tells the reader that the
  payload was kept only in the event log. The event row also points at the first write's
  reading ids.
- **Device descriptive fields change only when a newer reading lands.** A late or conflicting
  resend cannot overwrite `device_id` or `account_id` with old data.

## Auth, limits and multi-tenancy

- **Keys are stored as SHA-256 hashes and found by hash lookup.** A database leak does not
  expose usable keys. Keys are random (192 bits), so a fast hash is enough.
- **`last_used_at` is written at most once a minute per key.** Auth does not write on every
  request.
- **(beyond spec) A scoped key (with `account_id`) sees only its own events and its account's
  devices.** This is the same data-separation rule as `ACCOUNT_MISMATCH`, applied to reads.
- **The seed key is rotated, not added.** A change to `SEED_API_KEY` replaces the hash of the
  key named `seed`, so the old demo key stops working.
- **The rate limit counts HTTP requests, not batch items, on all `/api/*` routes.** A batch of
  100 costs 1 token. The limit is in memory and per instance. A shared limit needs Redis or a
  Postgres counter.
- **Body limit is 1 MB, enforced while the body streams.** A missing or false `Content-Length`
  does not get around it.

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
- **`bigint` and `numeric` are read back as JS numbers.** Ids and epoch ms stay below 2^53, and
  the API returns numbers, not strings.

## Operations

- **(deviation) Compose host port is `${DB_PORT:-5433}`.** The default is still 5433 as the spec
  says. During this build, 5433 was taken by another local container, so the local run used
  `DB_PORT=5435`.
- **Integration tests run in a throwaway Postgres schema.** `DATABASE_URL` can point at the dev
  database and the tests never touch its data.
- **The Docker image is multi-stage, runs as the non-root `node` user, has no dev
  dependencies, and has a health check.** It follows the usual container hardening steps.
- **Render Blueprint with a managed Postgres, and `SEED_API_KEY` set by hand (`sync: false`).**
  No secret goes into git.

## Assumptions about the data

- **Sample "Vaccine Shipment Southbound" has `EntryTimeEpoch` 19:27:26Z but `EntryTimeUtc`
  14:27:26Z.** We keep the epoch and warn with `TIMESTAMP_MISMATCH`.
- **Samples "Device A571992 Reading" and "Device A571992 Follow-up Reading" share a key with
  "Standard Temperature Shipment".** In file order they are `duplicate_conflict`. Sent alone, they
  are `partial` (invalid latitude 95 and longitude -200).
- **`DeviceId` must be a string.** A numeric IMEI is rejected, because JSON numbers can lose
  digits and the Tive schema says string.
- **`EntityName` is a label the user can edit, so it is never mapped or used as an id.**
