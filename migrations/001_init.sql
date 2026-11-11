-- 001_init: API keys, the ingest audit log (webhook_events), devices and the two PX reading tables.
-- gen_random_uuid() is built in since PostgreSQL 13.

CREATE TABLE api_keys (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  key_hash      char(64) NOT NULL UNIQUE,          -- SHA-256 hex of the key; the key itself is never stored
  account_id    integer NULL,                      -- when set, payloads with a different AccountId are rejected
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz NULL,
  revoked_at    timestamptz NULL
);

CREATE TABLE webhook_events (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  received_at         timestamptz NOT NULL DEFAULT now(),
  api_key_id          uuid NULL REFERENCES api_keys(id),
  request_id          text NOT NULL,
  batch_index         integer NULL,                -- position in an array body, null for a single object
  status              text NOT NULL CHECK (status IN
                        ('processed', 'partial', 'duplicate', 'duplicate_conflict', 'rejected', 'failed')),
  http_status         integer NOT NULL,
  raw_body            jsonb NULL,                  -- the item as received (parsed JSON)
  raw_text            text NULL,                   -- the body text when it is not valid JSON
  payload_hash        char(64) NULL,               -- SHA-256 of the normalized payload
  device_imei         text NULL,
  errors              jsonb NOT NULL DEFAULT '[]'::jsonb,
  warnings            jsonb NOT NULL DEFAULT '[]'::jsonb,
  sensor_reading_id   bigint NULL,
  location_reading_id bigint NULL,
  processed_at        timestamptz NULL
);

CREATE INDEX webhook_events_received_at_idx ON webhook_events (received_at DESC);
CREATE INDEX webhook_events_status_received_at_idx ON webhook_events (status, received_at DESC);
CREATE INDEX webhook_events_device_imei_idx ON webhook_events (device_imei);
CREATE INDEX webhook_events_api_key_received_at_idx ON webhook_events (api_key_id, received_at DESC);

CREATE TABLE devices (
  device_imei      text PRIMARY KEY,
  device_id        text NOT NULL,                  -- latest DeviceName seen
  account_id       integer NULL,
  provider         text NOT NULL,
  type             text NOT NULL,
  first_seen_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at     timestamptz NOT NULL DEFAULT now(),
  last_reading_at  timestamptz NULL                -- newest reading timestamp, not arrival time
);

CREATE INDEX devices_account_id_idx ON devices (account_id);

CREATE TABLE sensor_readings (
  id                   bigserial PRIMARY KEY,
  event_id             uuid NOT NULL REFERENCES webhook_events(id),
  device_imei          text NOT NULL REFERENCES devices(device_imei),
  device_id            text NOT NULL,
  timestamp_ms         bigint NOT NULL CHECK (timestamp_ms >= 0),
  recorded_at          timestamptz NOT NULL,
  provider             text NOT NULL,
  type                 text NOT NULL,
  temperature_c        numeric(5,2) NULL,
  humidity_pct         numeric(4,1) NULL,
  light_lux            numeric(10,1) NULL,
  accel_x              numeric(7,3) NULL,
  accel_y              numeric(7,3) NULL,
  accel_z              numeric(7,3) NULL,
  accel_magnitude      numeric(7,3) NULL,
  probe_temperature_c  numeric(5,2) NULL,          -- no PX field for the probe; kept here only
  account_id           integer NULL,
  shipment_id          text NULL,
  public_shipment_id   text NULL,
  payload_hash         char(64) NOT NULL,
  payload              jsonb NOT NULL,             -- the exact PX sensor document
  created_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sensor_readings_device_ts_key UNIQUE (device_imei, timestamp_ms)
);

CREATE INDEX sensor_readings_device_recorded_at_idx ON sensor_readings (device_imei, recorded_at DESC);

CREATE TABLE location_readings (
  id                   bigserial PRIMARY KEY,
  event_id             uuid NOT NULL REFERENCES webhook_events(id),
  device_imei          text NOT NULL REFERENCES devices(device_imei),
  device_id            text NOT NULL,
  timestamp_ms         bigint NOT NULL CHECK (timestamp_ms >= 0),
  recorded_at          timestamptz NOT NULL,
  provider             text NOT NULL,
  type                 text NOT NULL,
  latitude             double precision NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude            double precision NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  altitude             double precision NULL,
  accuracy_m           integer NULL,
  accuracy_category    text NULL CHECK (accuracy_category IN ('High', 'Medium', 'Low')),
  location_source      text NULL,
  address              jsonb NULL,
  battery_pct          smallint NULL CHECK (battery_pct BETWEEN 0 AND 100),
  cellular_dbm         numeric(6,2) NULL,
  wifi_access_points   integer NULL,
  account_id           integer NULL,
  shipment_id          text NULL,
  public_shipment_id   text NULL,
  payload_hash         char(64) NOT NULL,
  payload              jsonb NOT NULL,             -- the exact PX location document
  created_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT location_readings_device_ts_key UNIQUE (device_imei, timestamp_ms)
);

CREATE INDEX location_readings_device_recorded_at_idx ON location_readings (device_imei, recorded_at DESC);

ALTER TABLE webhook_events
  ADD CONSTRAINT webhook_events_sensor_reading_fk FOREIGN KEY (sensor_reading_id) REFERENCES sensor_readings(id),
  ADD CONSTRAINT webhook_events_location_reading_fk FOREIGN KEY (location_reading_id) REFERENCES location_readings(id);
