import { parseAddress } from './address.js';
import { roundOrNull } from './round.js';
import type { AccuracyCategory, CleanReading, LocationSource, PxLocation, PxSensor } from './types.js';

export function accuracyCategory(meters: number | null): AccuracyCategory | null {
  if (meters === null) return null;
  if (meters <= 100) return 'High';
  if (meters <= 1000) return 'Medium';
  return 'Low';
}

const SOURCES: Record<string, LocationSource> = { gps: 'GPS', wifi: 'WiFi', cell: 'Cellular' };

export function locationSource(method: string | null): LocationSource | null {
  if (method === null) return null;
  return SOURCES[method.trim().toLowerCase()] ?? null;
}

export function toPxSensor(r: CleanReading): PxSensor {
  const a = r.accelerometer;
  return {
    device_id: r.deviceName,
    device_imei: r.deviceImei,
    timestamp: r.timestampMs,
    provider: 'Tive',
    type: 'Active',
    temperature: roundOrNull(r.temperatureC, 2),
    humidity: roundOrNull(r.humidityPct, 1),
    light_level: roundOrNull(r.lightLux, 1),
    accelerometer: a === null
      ? null
      : { x: roundOrNull(a.x, 3), y: roundOrNull(a.y, 3), z: roundOrNull(a.z, 3), magnitude: roundOrNull(a.g, 3) },
    tilt: null,
    box_open: null,
  };
}

export function toPxLocation(r: CleanReading): PxLocation | null {
  const l = r.location;
  if (l === null) return null;
  return {
    device_id: r.deviceName,
    device_imei: r.deviceImei,
    timestamp: r.timestampMs,
    provider: 'Tive',
    type: 'Active',
    latitude: l.latitude,
    longitude: l.longitude,
    altitude: null,
    location_accuracy: l.accuracyM,
    location_accuracy_category: accuracyCategory(l.accuracyM),
    location_source: locationSource(l.locationMethod),
    address: parseAddress(l.formattedAddress),
    battery_level: l.batteryPct,
    cellular_dbm: roundOrNull(l.cellularDbm, 2),
    cellular_network_type: null,
    cellular_operator: null,
    wifi_access_points: l.wifiAccessPoints,
  };
}
