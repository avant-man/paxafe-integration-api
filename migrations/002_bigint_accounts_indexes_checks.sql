-- 002: bigint account ids, event_id indexes, a raw_bytes audit column and more CHECK constraints.
-- Runs in one transaction. ALTER ... TYPE bigint rewrites the four tables under an exclusive lock,
-- which is fine at this size. On a large table, add a new column and backfill it instead.

-- Tive AccountId values above 2^31 - 1 failed the insert with "integer out of range" (500 forever).
ALTER TABLE api_keys          ALTER COLUMN account_id TYPE bigint;
ALTER TABLE devices           ALTER COLUMN account_id TYPE bigint;
ALTER TABLE sensor_readings   ALTER COLUMN account_id TYPE bigint;
ALTER TABLE location_readings ALTER COLUMN account_id TYPE bigint;

-- The FK from the reading tables to webhook_events(id) needs these, or deleting events
-- (retention) scans the reading tables once per deleted row.
CREATE INDEX sensor_readings_event_id_idx   ON sensor_readings (event_id);
CREATE INDEX location_readings_event_id_idx ON location_readings (event_id);

-- A body that Postgres text cannot hold (not UTF-8, or a NUL byte) is kept byte for byte here.
ALTER TABLE webhook_events ADD COLUMN raw_bytes bytea NULL;

-- The database is the last guard if a transform bug gets through.
ALTER TABLE devices
  ADD CONSTRAINT devices_device_imei_check CHECK (device_imei ~ '^[0-9]{15}$'),
  ADD CONSTRAINT devices_provider_check    CHECK (provider = 'Tive');
ALTER TABLE sensor_readings
  ADD CONSTRAINT sensor_readings_provider_check          CHECK (provider = 'Tive'),
  ADD CONSTRAINT sensor_readings_humidity_check          CHECK (humidity_pct BETWEEN 0 AND 100),
  ADD CONSTRAINT sensor_readings_temperature_check       CHECK (temperature_c BETWEEN -100 AND 100),
  ADD CONSTRAINT sensor_readings_probe_temperature_check CHECK (probe_temperature_c BETWEEN -100 AND 100);
ALTER TABLE location_readings
  ADD CONSTRAINT location_readings_provider_check CHECK (provider = 'Tive');
