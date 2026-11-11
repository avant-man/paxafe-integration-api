/** A coded problem found in a payload. `path` uses dot notation on the Tive payload. */
export interface Issue {
  code: string;
  path: string;
  message: string;
}

export type JsonObject = Record<string, unknown>;

export interface PxAccelerometer {
  x: number | null;
  y: number | null;
  z: number | null;
  magnitude: number | null;
}

export interface PxSensor {
  device_id: string;
  device_imei: string;
  timestamp: number;
  provider: 'Tive';
  type: 'Active';
  temperature: number | null;
  humidity: number | null;
  light_level: number | null;
  accelerometer: PxAccelerometer | null;
  tilt: null;
  box_open: null;
}

export interface PxAddress {
  street: string | null;
  locality: string | null;
  state: string | null;
  country: string | null;
  postal_code: string | null;
  full_address: string | null;
}

export type AccuracyCategory = 'High' | 'Medium' | 'Low';
export type LocationSource = 'GPS' | 'WiFi' | 'Cellular';

export interface PxLocation {
  device_id: string;
  device_imei: string;
  timestamp: number;
  provider: 'Tive';
  type: 'Active';
  latitude: number;
  longitude: number;
  altitude: null;
  location_accuracy: number | null;
  location_accuracy_category: AccuracyCategory | null;
  location_source: LocationSource | null;
  address: PxAddress | null;
  battery_level: number | null;
  cellular_dbm: number | null;
  cellular_network_type: null;
  cellular_operator: null;
  wifi_access_points: number | null;
}

/** Values that survived the soft rules, before PX mapping and rounding. */
export interface CleanReading {
  deviceImei: string;
  deviceName: string;
  timestampMs: number;
  temperatureC: number | null;
  probeTemperatureC: number | null;
  humidityPct: number | null;
  lightLux: number | null;
  accelerometer: { x: number | null; y: number | null; z: number | null; g: number | null } | null;
  location: CleanLocation | null;
  accountId: number | null;
  shipmentId: string | null;
  publicShipmentId: string | null;
}

export interface CleanLocation {
  latitude: number;
  longitude: number;
  accuracyM: number | null;
  locationMethod: string | null;
  formattedAddress: string | null;
  wifiAccessPoints: number | null;
  batteryPct: number | null;
  cellularDbm: number | null;
}

/** Outcome of the pure pipeline for one item (no database involved). */
export type TransformOutcome =
  | {
      ok: false;
      errors: Issue[];
      warnings: Issue[];
      normalized: JsonObject | null;
      payloadHash: string | null;
      deviceImei: string | null;
    }
  | {
      ok: true;
      errors: [];
      warnings: Issue[];
      normalized: JsonObject;
      payloadHash: string;
      deviceImei: string;
      reading: CleanReading;
      sensor: PxSensor;
      location: PxLocation | null;
    };
