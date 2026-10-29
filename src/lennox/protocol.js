// -----------------------------------------------------------------------------
// The local API of a Lennox S30 / E30 / M30, as lennoxs30api (MIT,
// PeteRager/lennoxs30api) speaks it on the LAN: the bodies of the requests,
// the answers checked, and the model of the thermostat built from the
// messages of its queue (pure: no network, no clock; `seq` and `at` are given
// by the caller).
//
// The thermostat sends everything asked (RequestData) once, then each change
// as it happens: the model is the last value of each field, with the number
// (`seq`) of the message that carried it and when (`at`, monotonic). A value
// of an unexpected type is unknown, never a number: `Number('')` is 0, a text
// is never a temperature. Only the messages of the thermostat itself
// (SenderID "LCC") are read; those of a sibling thermostat are dropped.
// -----------------------------------------------------------------------------

import { randomUUID } from 'node:crypto';
import { LennoxError, ERROR_KINDS } from './http.js';
import { alertText } from './alerts.js';
import {
  ALERT_LEVELS,
  APP_ID,
  FAN_MODES,
  JSON_PATH,
  LIMITS,
  SCHEDULE,
  SYSTEM_ID,
  SYSTEM_MODES,
  ZONES,
} from '../constants.js';

const plain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const list = (v) => (Array.isArray(v) ? v.slice(0, LIMITS.items) : []);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const bool = (v) => (typeof v === 'boolean' ? v : undefined);
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/g;
const text = (v) =>
  typeof v === 'string' ? v.replace(CONTROL, '').trim().slice(0, LIMITS.textLength) : undefined;
const oneOf = (v, values) => (typeof v === 'string' && values.includes(v) ? v : undefined);

// --- Requests -------------------------------------------------------------------

/** The body of RequestData: everything the integration reads, then its changes. */
export const requestDataBody = (id = randomUUID()) =>
  JSON.stringify({
    MessageType: 'RequestData',
    SenderID: APP_ID,
    MessageID: id,
    TargetID: SYSTEM_ID,
    AdditionalParameters: { JSONPath: JSON_PATH },
  });

/** The body of a change (Publish). */
export const publishBody = (data, id = randomUUID()) =>
  JSON.stringify({
    MessageType: 'Command',
    SenderID: APP_ID,
    MessageID: id,
    TargetID: SYSTEM_ID,
    Data: data,
  });

/** Connect, Disconnect, RequestData: 200 or 204, else an error. */
export function checkAccepted(answer) {
  if (answer.status === 200 || answer.status === 204) {
    return;
  }
  throw httpError(answer);
}

/** The error of an HTTP answer that is not a success. */
export function httpError(answer) {
  const status = answer.status;
  if (status === 429 || status === 503) {
    const seconds = /^\d{1,6}$/.test(String(answer.headers?.['retry-after'] ?? ''))
      ? Number(answer.headers['retry-after'])
      : undefined;
    return new LennoxError(ERROR_KINDS.RATE_LIMITED, `HTTP ${status}`, {
      status,
      retryAfter: seconds === undefined ? undefined : seconds * 1000,
    });
  }
  if (status >= 400 && status < 500) {
    return new LennoxError(ERROR_KINDS.REJECTED, `HTTP ${status}`, { status });
  }
  return new LennoxError(ERROR_KINDS.HTTP, `HTTP ${status}`, { status });
}

const parseJson = (body) => {
  try {
    return JSON.parse(body);
  } catch {
    throw new LennoxError(ERROR_KINDS.PROTOCOL, 'Not JSON');
  }
};

/** The messages of a Retrieve answer (204 or an empty body: none). */
export function messagesOf(answer) {
  if (answer.status === 204) {
    return [];
  }
  if (answer.status !== 200) {
    throw httpError(answer);
  }
  if (answer.body.trim() === '') {
    return [];
  }
  const json = parseJson(answer.body);
  if (!plain(json) || (json.messages !== undefined && !Array.isArray(json.messages))) {
    throw new LennoxError(ERROR_KINDS.PROTOCOL, 'Not a message list');
  }
  return list(json.messages).filter(plain);
}

/** The answer of a Publish: accepted only with code 1. */
export function checkPublished(answer) {
  if (answer.status !== 200) {
    throw httpError(answer);
  }
  const json = answer.body.trim() === '' ? undefined : parseJson(answer.body);
  if (!plain(json) || json.code !== 1) {
    const code = plain(json) && Number.isInteger(json.code) ? json.code : undefined;
    throw new LennoxError(ERROR_KINDS.REJECTED, `code ${code ?? '?'}`, {
      status: code === undefined ? 'code' : `code ${code}`,
    });
  }
}

// --- Changes -------------------------------------------------------------------------

/** One period of a schedule (the period 0, the one lennoxs30api writes). */
export const periodPart = (scheduleId, period) => ({
  id: scheduleId,
  schedule: { periods: [{ id: 0, period }] },
});

/** The zone follows its manual schedule from now on. */
export const manualPart = (zone) => ({ id: zone, config: { scheduleId: SCHEDULE.manual(zone) } });

/** The zone holds its override schedule until the next period (lennoxs30api setScheduleHold). */
export const holdPart = (zone) => ({
  id: zone,
  config: {
    scheduleHold: {
      scheduleId: SCHEDULE.override(zone),
      exceptionType: 'hold',
      enabled: true,
      expiresOn: '0',
      expirationMode: 'nextPeriod',
    },
  },
});

/** The Data of a change from its parts (`schedules`, `zones`), undefined when empty. */
export function dataOf({ schedules = [], zones = [] }) {
  const data = {};
  if (schedules.length > 0) data.schedules = schedules;
  if (zones.length > 0) data.zones = zones;
  return Object.keys(data).length > 0 ? data : undefined;
}

// --- Model ---------------------------------------------------------------------------

export const emptyModel = () => ({
  system: {},
  zones: new Map(),
  schedules: new Map(),
  /** The number of the last message applied. */
  seq: 0,
});

/** Sets `obj[key]` from `value` (undefined: left as it is), with its seq and date. */
function put(obj, key, value, stamp) {
  if (value === undefined) {
    return;
  }
  obj[key] = { value, seq: stamp.seq, at: stamp.at };
}

const PERIOD_FIELDS = {
  systemMode: (v) => oneOf(v, Object.values(SYSTEM_MODES)),
  fanMode: (v) => oneOf(v, FAN_MODES),
  humidityMode: (v) => oneOf(v, ['off', 'humidify', 'dehumidify', 'both']),
  hsp: num,
  hspC: num,
  csp: num,
  cspC: num,
  sp: num,
  spC: num,
  husp: num,
  desp: num,
  startTime: num,
};

function applyPeriod(target, period, stamp) {
  if (!plain(period)) return;
  for (const [key, read] of Object.entries(PERIOD_FIELDS)) {
    put(target, key, read(period[key]), stamp);
  }
}

function zoneOf(model, id) {
  if (!model.zones.has(id)) {
    model.zones.set(id, { id, config: {}, status: {}, period: {} });
  }
  return model.zones.get(id);
}

const CONFIG_FIELDS = {
  name: text,
  heatingOption: bool,
  coolingOption: bool,
  emergencyHeatingOption: bool,
  minHsp: num,
  maxHsp: num,
  minHspC: num,
  maxHspC: num,
  minCsp: num,
  maxCsp: num,
  minCspC: num,
  maxCspC: num,
  temperatureDeadband: num,
  temperatureDeadbandC: num,
  scheduleId: (v) => (Number.isInteger(v) && v >= 0 && v < 256 ? v : undefined),
};

const STATUS_FIELDS = {
  temperature: num,
  temperatureC: num,
  temperatureStatus: text,
  humidity: num,
  humidityStatus: text,
  tempOperation: (v) => oneOf(v, ['off', 'heating', 'cooling']),
  fan: bool,
};

function applyZone(model, raw, stamp) {
  if (!plain(raw) || !Number.isInteger(raw.id) || raw.id < 0 || raw.id >= ZONES.max) {
    return;
  }
  const zone = zoneOf(model, raw.id);
  if (plain(raw.config)) {
    for (const [key, read] of Object.entries(CONFIG_FIELDS)) {
      put(zone.config, key, read(raw.config[key]), stamp);
    }
    const hold = raw.config.scheduleHold;
    if (plain(hold)) {
      put(zone.config, 'holdEnabled', bool(hold.enabled), stamp);
      put(zone.config, 'holdScheduleId', CONFIG_FIELDS.scheduleId(hold.scheduleId), stamp);
    }
  }
  if (plain(raw.status)) {
    for (const [key, read] of Object.entries(STATUS_FIELDS)) {
      put(zone.status, key, read(raw.status[key]), stamp);
    }
    applyPeriod(zone.period, raw.status.period, stamp);
  }
}

/**
 * A schedule: kept for the manual and override schedules of the zones; the
 * period of the manual schedule of a zone that follows it is the period of
 * the zone (lennoxs30api: in manual mode, the changes reach the schedule
 * only).
 */
function applySchedule(model, raw, stamp) {
  if (!plain(raw) || !Number.isInteger(raw.id)) return;
  const id = raw.id;
  const zoneId = [...Array(ZONES.max).keys()].find(
    (z) => SCHEDULE.manual(z) === id || SCHEDULE.override(z) === id,
  );
  if (zoneId === undefined) return;
  const periods = list(raw.schedule?.periods);
  const first = periods.find((p) => plain(p) && p.id === 0);
  if (!first) return;
  if (!model.schedules.has(id)) model.schedules.set(id, {});
  applyPeriod(model.schedules.get(id), first.period, stamp);
  const zone = model.zones.get(zoneId);
  if (zone && SCHEDULE.manual(zoneId) === id && zone.config.scheduleId?.value === id) {
    applyPeriod(zone.period, first.period, stamp);
  }
}

function applySystem(model, raw, stamp) {
  if (!plain(raw)) return;
  const s = model.system;
  if (plain(raw.config)) {
    put(s, 'name', text(raw.config.name), stamp);
    put(s, 'unit', oneOf(raw.config.temperatureUnit, ['F', 'C']), stamp);
    put(s, 'productType', text(raw.config.options?.productType), stamp);
  }
  if (plain(raw.status)) {
    put(s, 'outdoor', num(raw.status.outdoorTemperature), stamp);
    put(s, 'outdoorC', num(raw.status.outdoorTemperatureC), stamp);
    put(s, 'outdoorStatus', text(raw.status.outdoorTemperatureStatus), stamp);
    put(s, 'alert', oneOf(raw.status.alert, ALERT_LEVELS), stamp);
    put(s, 'zoningMode', oneOf(raw.status.zoningMode, ['zoned', 'central']), stamp);
    const zones = raw.status.numberOfZones;
    put(
      s,
      'numberOfZones',
      Number.isInteger(zones) && zones >= 1 && zones <= ZONES.max ? zones : undefined,
      stamp,
    );
    put(s, 'singleSetpoint', bool(raw.status.singleSetpointMode), stamp);
  }
}

function applyOccupancy(model, raw, stamp) {
  if (!plain(raw)) return;
  put(model.system, 'manualAway', bool(raw.manualAway), stamp);
  if (plain(raw.smartAway)) {
    put(model.system, 'smartAwayEnabled', bool(raw.smartAway.config?.enabled), stamp);
    put(model.system, 'smartAwayState', text(raw.smartAway.status?.setpointState), stamp);
  }
}

function applyAlerts(model, raw, stamp) {
  if (!plain(raw)) return;
  if (Array.isArray(raw.active)) {
    const active = [];
    for (const item of list(raw.active)) {
      const alert = item?.alert;
      if (!plain(alert) || !Number.isInteger(alert.code) || alert.code === 0) continue;
      if (alert.isStillActive === false) continue;
      active.push({
        code: alert.code,
        priority: oneOf(alert.priority, ALERT_LEVELS) ?? 'info',
        text: alertText(alert.code),
      });
    }
    put(model.system, 'alerts', active, stamp);
  }
  if (plain(raw.meta)) {
    const n = raw.meta.numActiveAlerts;
    put(
      model.system,
      'alertCount',
      Number.isInteger(n) && n >= 0 && n < 10_000 ? n : undefined,
      stamp,
    );
    if (raw.meta.numAlertsInActiveArray === 0) {
      put(model.system, 'alerts', [], stamp);
    }
  }
}

const SERIAL = /^[A-Za-z0-9]{4,32}$/;

/** The identity of the thermostat: its control serial number (device type 500, feature 9). */
function applyDevices(model, raw, stamp) {
  for (const item of list(raw)) {
    const device = item?.device;
    if (!plain(device) || device.deviceType !== 500) continue;
    for (const f of list(device.features)) {
      const feature = f?.feature;
      if (!plain(feature)) continue;
      const value = list(feature.values)[0]?.value;
      if (feature.fid === 9 && typeof value === 'string' && SERIAL.test(value)) {
        put(model.system, 'serial', value.toLowerCase(), stamp);
      } else if (feature.fid === 8) {
        put(model.system, 'model', text(value), stamp);
      } else if (feature.fid === 11) {
        put(model.system, 'firmware', text(value), stamp);
      }
    }
  }
}

/**
 * Applies one message of the queue to the model; returns false when it is not
 * one of the thermostat itself (dropped). `at`: monotonic date of now.
 */
export function applyMessage(model, message, at) {
  const sender = message.SenderID ?? message.SenderId;
  if (sender !== SYSTEM_ID || !plain(message.Data)) {
    return false;
  }
  model.seq += 1;
  const stamp = { seq: model.seq, at };
  const data = message.Data;
  // The system first (zoning mode), the zones before the schedules (scheduleId).
  applySystem(model, data.system, stamp);
  for (const zone of list(data.zones)) applyZone(model, zone, stamp);
  for (const schedule of list(data.schedules)) applySchedule(model, schedule, stamp);
  applyOccupancy(model, data.occupancy, stamp);
  applyAlerts(model, data.alerts, stamp);
  if (data.devices !== undefined) applyDevices(model, data.devices, stamp);
  return true;
}

/** The value of a field of the model (`{ value, seq, at }`), else undefined. */
export const valueOf = (field) => field?.value;

/** Whether a zone is in use: zone 0 always; the others in zoned mode, within the number of zones. */
export function zoneInUse(model, id) {
  if (id === 0) return true;
  const mode = valueOf(model.system.zoningMode);
  const count = valueOf(model.system.numberOfZones);
  if (mode === 'central') return false;
  return count === undefined || id < count;
}

/** The zones read with a name and a temperature, in use, by id. */
export function zonesOf(model) {
  return [...model.zones.values()]
    .filter((z) => zoneInUse(model, z.id) && z.config.name !== undefined)
    .sort((a, b) => a.id - b.id);
}

/** Away (manual or smart away in force): the zone follows its away schedule. */
export function awayOf(model) {
  const manual = valueOf(model.system.manualAway);
  const smart =
    valueOf(model.system.smartAwayEnabled) === true &&
    ['away', 'transition'].includes(valueOf(model.system.smartAwayState));
  if (manual === undefined) return undefined;
  return manual === true || smart;
}
