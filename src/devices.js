// -----------------------------------------------------------------------------
// The thermostat -> Gladys devices and states (pure).
//
// Identifier rule (frozen, it fixes the external ids):
//   - one device per zone in use: `ext:<selector>:lennox:<serial>-zone<n>`
//     (n = 0 to 3, the zone id of the thermostat);
//   - one device for the system (outdoor temperature, alerts):
//     `ext:<selector>:lennox:<serial>`;
//   <serial>: the control serial number of the thermostat (its devices list,
//   device type 500, feature 9), in lower case, letters and digits only,
//   never its IP address nor a name. Features: `<device>:<key>`, the keys of
//   FEATURES (published forever).
//
// Never a `switch` nor a writable `binary`: the core hands every switch to
// the voice assistants, MCP and the "turn everything off" scene actions. The
// mode is `thermostat/mode` (off, heating, cooling, auto), the setpoints
// `thermostat/target-temperature` (heating) and
// `air-conditioning/target-temperature` (cooling), the fan a `text/select`.
//
// Units: the temperature features take the display unit of the thermostat
// (°F or °C) when they are created; a value is always given in the unit of
// the feature as it was CREATED in Gladys (a °F reading converted exactly,
// then to 0.1 degree; a setpoint in the unit the thermostat keeps it in). A
// device published again never loses a feature: those already created are
// kept as they were created.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import {
  ALERT_LEVELS,
  COMMAND_FEATURES,
  FAN_MODES,
  FEATURES,
  OPERATING_STATE,
  SYSTEM_MODES,
  THERMOSTAT_MODE,
} from './constants.js';
import { ALERT_NAMES, FAN_NAMES, FEATURE_NAMES, MODE_NAMES, NO_ALERT, word } from './i18n.js';
import { valueOf } from './lennox/protocol.js';
import { defaultRange, limitsOf, rangeOf, toC, toF } from './setpoints.js';

export const DEVICE_TYPE = 'lennox';

export const zonePlatformId = (serial, zone) => `${serial}-zone${zone}`;
export const zoneIds = (gladys, serial, zone) =>
  gladys.externalIds(DEVICE_TYPE, zonePlatformId(serial, zone));
export const systemIds = (gladys, serial) => gladys.externalIds(DEVICE_TYPE, serial);

const KEYS = Object.values(FEATURES);

/** `{ serial, zone (undefined: the system), key }` of one of our feature ids, else undefined. */
export function parseFeatureId(externalId) {
  if (typeof externalId !== 'string' || externalId.length > 300) {
    return undefined;
  }
  const match = /:lennox:([a-z0-9]{4,32})(?:-zone([0-3]))?:([a-z-]{1,40})$/.exec(externalId);
  if (!match || !KEYS.includes(match[3])) {
    return undefined;
  }
  return {
    serial: match[1],
    zone: match[2] === undefined ? undefined : Number(match[2]),
    key: match[3],
  };
}

/** `{ serial, zone }` of one of our device ids, else undefined. */
export function parseDeviceId(externalId) {
  const match = /:lennox:([a-z0-9]{4,32})(?:-zone([0-3]))?$/.exec(
    String(externalId ?? '').slice(0, 300),
  );
  return match
    ? { serial: match[1], zone: match[2] === undefined ? undefined : Number(match[2]) }
    : undefined;
}

export const gladysUnit = (unit) => (unit === 'F' ? U.FAHRENHEIT : U.CELSIUS);
export const apiUnitOf = (unit) =>
  unit === U.FAHRENHEIT ? 'F' : unit === U.CELSIUS ? 'C' : undefined;

/** Lennox system mode <-> THERMOSTAT_MODE (emergency heat reads as heating). */
export const MODE_MAP = [
  ['off', SYSTEM_MODES.OFF, THERMOSTAT_MODE.OFF],
  ['heat', SYSTEM_MODES.HEAT, THERMOSTAT_MODE.HEATING],
  ['cool', SYSTEM_MODES.COOL, THERMOSTAT_MODE.COOLING],
  ['auto', SYSTEM_MODES.AUTO, THERMOSTAT_MODE.AUTO],
];
export const modeOfLennox = (mode) =>
  mode === SYSTEM_MODES.EMERGENCY
    ? THERMOSTAT_MODE.HEATING
    : MODE_MAP.find((row) => row[1] === mode)?.[2];

/** What a zone offers (an option read false only removes it; unknown offers it). */
export function offers(zone) {
  const heat = valueOf(zone.config.heatingOption) !== false;
  const cool = valueOf(zone.config.coolingOption) !== false;
  return { off: true, heat, cool, auto: heat && cool };
}

const command = (definition) => ({
  read_only: false,
  has_feedback: true,
  keep_history: true,
  ...definition,
});
const sensor = (definition) => ({
  read_only: true,
  has_feedback: false,
  keep_history: true,
  ...definition,
});
const words = () =>
  sensor({ category: C.TEXT, type: T.TEXT.TEXT, min: 0, max: 0, keep_history: false });

const round1 = (x) => Math.round(x * 10) / 10;

/** The features of a zone, by key, in display order. */
export function zoneDefinitions(zone, unit, language) {
  const temperatureUnit = gladysUnit(unit);
  const can = offers(zone);
  const range = (kind) => {
    const limits = limitsOf(zone, kind);
    return (limits && rangeOf(limits, unit)) ?? defaultRange(kind, unit);
  };
  const defs = {};
  defs[FEATURES.TEMPERATURE] = sensor({
    category: C.TEMPERATURE_SENSOR,
    type: T.SENSOR.DECIMAL,
    unit: temperatureUnit,
    min: unit === 'C' ? -20 : -4,
    max: unit === 'C' ? 60 : 140,
  });
  defs[FEATURES.HUMIDITY] = sensor({
    category: C.HUMIDITY_SENSOR,
    type: T.SENSOR.DECIMAL,
    unit: U.PERCENT,
    min: 0,
    max: 100,
  });
  const modes = MODE_MAP.filter(([name]) => can[name]);
  defs[FEATURES.MODE] = command({
    category: C.THERMOSTAT,
    type: T.THERMOSTAT.MODE,
    min: THERMOSTAT_MODE.OFF,
    max: Math.max(...modes.map(([, , value]) => value)),
    supported_options: modes.map(([name, , value], index) => ({
      value,
      label: word(MODE_NAMES[name], language),
      sort_order: index,
    })),
  });
  if (can.heat) {
    defs[FEATURES.HEAT_SETPOINT] = command({
      category: C.THERMOSTAT,
      type: T.THERMOSTAT.TARGET_TEMPERATURE,
      unit: temperatureUnit,
      ...range('heat'),
    });
  }
  if (can.cool) {
    defs[FEATURES.COOL_SETPOINT] = command({
      category: C.AIR_CONDITIONING,
      type: T.AIR_CONDITIONING.TARGET_TEMPERATURE,
      unit: temperatureUnit,
      ...range('cool'),
    });
  }
  defs[FEATURES.OPERATING_STATE] = sensor({
    category: C.THERMOSTAT,
    type: T.THERMOSTAT.OPERATING_STATE,
    min: OPERATING_STATE.IDLE,
    max: OPERATING_STATE.COOLING,
  });
  defs[FEATURES.FAN_MODE] = command({
    category: C.TEXT,
    type: T.TEXT.SELECT,
    min: 0,
    max: 0,
    keep_history: false,
    supported_options: FAN_MODES.map((name, index) => ({
      value: name,
      label: word(FAN_NAMES[name], language),
      sort_order: index,
    })),
  });
  defs[FEATURES.FAN_RUNNING] = sensor({
    category: C.UNKNOWN,
    type: T.SENSOR.BINARY,
    min: 0,
    max: 1,
  });
  return defs;
}

/** The features of the system device. */
export function systemDefinitions(unit) {
  return {
    // A probe: the core keeps it out of the temperature of the room.
    [FEATURES.OUTDOOR]: sensor({
      category: C.TEMPERATURE_SENSOR,
      type: T.TEMPERATURE_SENSOR.PROBE,
      unit: gladysUnit(unit),
      min: unit === 'C' ? -50 : -58,
      max: unit === 'C' ? 60 : 140,
    }),
    [FEATURES.ALERT_LEVEL]: words(),
    [FEATURES.ALERT_COUNT]: sensor({
      category: C.UNKNOWN,
      type: T.SENSOR.INTEGER,
      min: 0,
      max: 1000,
    }),
    [FEATURES.ALERTS]: words(),
  };
}

/** The fields of a feature Gladys stores (what is kept of a created feature). */
const DECLARED = [
  'name',
  'external_id',
  'category',
  'type',
  'unit',
  'min',
  'max',
  'read_only',
  'has_feedback',
  'keep_history',
  'supported_options',
];

/**
 * A device: `created` (the device already created in Gladys) keeps each of
 * its features as it was created; new features are added after them.
 */
function assemble(built, created) {
  if (!created || !Array.isArray(created.features)) {
    return built;
  }
  const fresh = new Map(built.features.map((f) => [f.external_id, f]));
  const kept = created.features
    .filter((f) => typeof f?.external_id === 'string')
    .map((f) => {
      const entry = Object.fromEntries(
        DECLARED.filter((k) => f[k] !== undefined && f[k] !== null).map((k) => [k, f[k]]),
      );
      entry.name = fresh.get(f.external_id)?.name ?? f.name;
      return entry;
    });
  const known = new Set(kept.map((f) => f.external_id));
  return {
    ...built,
    features: [...kept, ...built.features.filter((f) => !known.has(f.external_id))],
  };
}

const modelName = (system) =>
  `Lennox ${valueOf(system.productType) ?? 'S30'}${valueOf(system.model) ? ` ${valueOf(system.model)}` : ''}`.slice(
    0,
    60,
  );

export function buildZoneDevice(gladys, serial, model, zone, { language, created }) {
  const ids = zoneIds(gladys, serial, zone.id);
  const unit = valueOf(model.system.unit) ?? 'C';
  const defs = zoneDefinitions(zone, unit, language);
  const params = [{ name: 'zone', value: String(zone.id) }];
  const firmware = valueOf(model.system.firmware);
  if (firmware) params.push({ name: 'firmware', value: firmware });
  const built = {
    name: (valueOf(zone.config.name) || `Zone ${zone.id + 1}`).slice(0, 60),
    external_id: ids.device,
    model: modelName(model.system),
    should_poll: false,
    features: Object.entries(defs).map(([key, def]) => ({
      name: word(FEATURE_NAMES[key], language),
      external_id: ids.feature(key),
      ...def,
    })),
    params,
  };
  return assemble(built, created);
}

export function buildSystemDevice(gladys, serial, model, { language, created }) {
  const ids = systemIds(gladys, serial);
  const unit = valueOf(model.system.unit) ?? 'C';
  const defs = systemDefinitions(unit);
  const name = valueOf(model.system.name);
  const built = {
    name: `Lennox ${name || serial.slice(-4).toUpperCase()}`.slice(0, 60),
    external_id: ids.device,
    model: modelName(model.system),
    should_poll: false,
    features: Object.entries(defs).map(([key, def]) => ({
      name: word(FEATURE_NAMES[key], language),
      external_id: ids.feature(key),
      ...def,
    })),
    params: [{ name: 'serial', value: serial }],
  };
  return assemble(built, created);
}

/**
 * A temperature in the unit `to` ('C' / 'F'): from the °F reading converted
 * exactly (to 0.1), or from the °C one; undefined when neither is known.
 */
export function temperatureIn(to, f, c) {
  if (to === 'F') {
    if (Number.isFinite(f)) return round1(f);
    return Number.isFinite(c) ? round1(toF(c)) : undefined;
  }
  if (Number.isFinite(f)) return round1(toC(f));
  return Number.isFinite(c) ? round1(c) : undefined;
}

/** A setpoint in the unit `to`: the value the thermostat keeps in that unit, else converted. */
export function setpointIn(to, f, c) {
  if (to === 'F') {
    if (Number.isFinite(f)) return f;
    return Number.isFinite(c) ? round1(toF(c)) : undefined;
  }
  if (Number.isFinite(c)) return c;
  return Number.isFinite(f) ? round1(toC(f)) : undefined;
}

/**
 * The states of a zone: each value in the unit of the feature as created
 * (`unitOf(featureId)` -> 'C' / 'F'), only the fields `fresh(field)`
 * accepts; unknown values are left out, never sent as undefined or NaN, and
 * a reading whose status is not "good" is not a measurement.
 */
export function zoneStates(ids, zone, { fresh, unitOf }) {
  const states = [];
  const add = (key, value) => {
    if (value !== undefined && value !== null) {
      states.push({ device_feature_external_id: ids.feature(key), ...value });
    }
  };
  const ok = (field) => (field !== undefined && fresh(field) ? field.value : undefined);
  const number = (n) => (Number.isFinite(n) ? { state: n } : undefined);
  const s = zone.status;
  const p = zone.period;
  const good = (status) => ok(status) === 'good';
  const unit = (key) => unitOf(ids.feature(key)) ?? 'C';
  if (good(s.temperatureStatus)) {
    add(
      FEATURES.TEMPERATURE,
      number(temperatureIn(unit(FEATURES.TEMPERATURE), ok(s.temperature), ok(s.temperatureC))),
    );
  }
  if (good(s.humidityStatus)) {
    const h = ok(s.humidity);
    add(FEATURES.HUMIDITY, number(Number.isFinite(h) && h >= 0 && h <= 100 ? h : undefined));
  }
  add(FEATURES.MODE, number(modeOfLennox(ok(p.systemMode))));
  add(
    FEATURES.HEAT_SETPOINT,
    number(setpointIn(unit(FEATURES.HEAT_SETPOINT), ok(p.hsp), ok(p.hspC))),
  );
  add(
    FEATURES.COOL_SETPOINT,
    number(setpointIn(unit(FEATURES.COOL_SETPOINT), ok(p.csp), ok(p.cspC))),
  );
  const operating = { off: 0, heating: 1, cooling: 2 }[ok(s.tempOperation)];
  add(FEATURES.OPERATING_STATE, number(operating));
  const fan = ok(p.fanMode);
  add(FEATURES.FAN_MODE, fan === undefined ? undefined : { text: fan });
  const running = ok(s.fan);
  add(FEATURES.FAN_RUNNING, running === undefined ? undefined : { state: running ? 1 : 0 });
  return states;
}

/** The states of the system device. */
export function systemStates(ids, system, { fresh, unitOf, language }) {
  const states = [];
  const add = (key, value) => {
    if (value !== undefined && value !== null) {
      states.push({ device_feature_external_id: ids.feature(key), ...value });
    }
  };
  const ok = (field) => (field !== undefined && fresh(field) ? field.value : undefined);
  if (ok(system.outdoorStatus) === 'good') {
    const t = temperatureIn(
      unitOf(ids.feature(FEATURES.OUTDOOR)) ?? 'C',
      ok(system.outdoor),
      ok(system.outdoorC),
    );
    if (Number.isFinite(t)) add(FEATURES.OUTDOOR, { state: t });
  }
  const level = ok(system.alert);
  if (ALERT_LEVELS.includes(level)) {
    add(FEATURES.ALERT_LEVEL, { text: word(ALERT_NAMES[level], language) });
  }
  const count = ok(system.alertCount);
  if (Number.isInteger(count)) add(FEATURES.ALERT_COUNT, { state: count });
  const alerts = ok(system.alerts);
  if (Array.isArray(alerts)) {
    const text =
      alerts.length === 0
        ? word(NO_ALERT, language)
        : alerts
            .slice(0, 10)
            .map((a) => `${a.text} (${a.code})`)
            .join(', ')
            .slice(0, 250);
    add(FEATURES.ALERTS, { text });
  }
  return states;
}

/** A command value, strictly: a finite number, or a text that is exactly one. */
export function strictNumber(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === 'string' && /^-?\d{1,3}(?:\.\d{1,3})?$/.test(value)) {
    return Number(value);
  }
  return undefined;
}

/**
 * The change a command asks, checked on its own, else undefined:
 *   { mode: 'off' | 'heat' | 'cool' | 'heat and cool' }
 *   { setpoint: 'heat' | 'cool', asked }  (asked: in the unit of the feature)
 *   { fan: 'auto' | 'on' | 'circulate' }
 */
export function commandValue(key, value) {
  if (!COMMAND_FEATURES.includes(key)) {
    return undefined;
  }
  if (key === FEATURES.FAN_MODE) {
    return typeof value === 'string' && FAN_MODES.includes(value) ? { fan: value } : undefined;
  }
  const n = strictNumber(value);
  if (n === undefined) {
    return undefined;
  }
  if (key === FEATURES.MODE) {
    const row = MODE_MAP.find((r) => r[2] === n);
    return row ? { mode: row[1] } : undefined;
  }
  return { setpoint: key === FEATURES.HEAT_SETPOINT ? 'heat' : 'cool', asked: n };
}
