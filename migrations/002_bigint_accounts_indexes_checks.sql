ALTER TABLE api_keys          ALTER COLUMN account_id TYPE bigint;
ALTER TABLE devices           ALTER COLUMN account_id TYPE bigint;
ALTER TABLE sensor_readings   ALTER COLUMN account_id TYPE bigint;
ALTER TABLE location_readings ALTER COLUMN account_id TYPE bigint;

CREATE INDEX sensor_readings_event_id_idx   ON sensor_readings (event_id);
CREATE INDEX location_readings_event_id_idx ON location_readings (event_id);

ALTER TABLE webhook_events ADD COLUMN raw_bytes bytea NULL;

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
