// -----------------------------------------------------------------------------
// Devices, states, setpoints and configuration (pure parts).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as TYPES,
} from '@gladysassistant/integration-sdk';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import {
  buildSystemDevice,
  buildZoneDevice,
  commandValue,
  parseDeviceId,
  parseFeatureId,
  setpointIn,
  temperatureIn,
} from '../src/devices.js';
import { applyMessage, emptyModel } from '../src/lennox/protocol.js';
import { limitsOf, pairOf, planSetpoint, rangeOf, toC } from '../src/setpoints.js';
import { normalizeConfig, parseAddress } from '../src/config.js';
import { FEATURES as F, SETPOINT_BOUNDS } from '../src/constants.js';

const field = (value) => ({ value, seq: 1, at: 0 });
const zoneOf = (config = {}, period = {}) => ({
  id: 0,
  config: Object.fromEntries(
    Object.entries({
      name: 'Main',
      minHsp: 40,
      maxHsp: 90,
      minHspC: 4.5,
      maxHspC: 32,
      minCsp: 60,
      maxCsp: 99,
      minCspC: 15.5,
      maxCspC: 37,
      ...config,
    }).map(([k, v]) => [k, field(v)]),
  ),
  status: {},
  period: Object.fromEntries(
    Object.entries({ hsp: 68, hspC: 20, csp: 77, cspC: 25, ...period }).map(([k, v]) => [
      k,
      field(v),
    ]),
  ),
});

test('°F and °C: exact conversions, both values within both limits after conversion', () => {
  assert.deepEqual(pairOf(21.3, 'C'), { C: 21.5, F: 71 });
  assert.deepEqual(pairOf(70, 'F'), { F: 70, C: 21 });
  assert.deepEqual(pairOf(71, 'F'), { F: 71, C: 21.5 });
  assert.equal(temperatureIn('C', 68.875), 20.5);
  assert.equal(temperatureIn('C', 71.625), 22);
  assert.equal(temperatureIn('F', undefined, 20), 68);
  assert.equal(setpointIn('C', 68, 20), 20);
  assert.equal(setpointIn('F', 68, 20), 68);
  // The top of a zone in °F (86) gives 30 °C, never 30.5 (= 86.9 °F).
  const zone = zoneOf({ maxHsp: 86, maxHspC: 30.5 });
  assert.deepEqual(rangeOf(limitsOf(zone, 'heat'), 'C'), { min: 4.5, max: 30 });
  assert.deepEqual(rangeOf(limitsOf(zone, 'heat'), 'F'), { min: 40, max: 86 });
  // Our own ceiling holds whatever the zone says.
  const wide = zoneOf({ maxHsp: 120, maxHspC: 49 });
  assert.equal(rangeOf(limitsOf(wide, 'heat'), 'F').max, SETPOINT_BOUNDS.heat.F.max);
  assert.equal(planSetpoint(wide, 'heat', 95, 'F').error, 'range');
  // Every value offered converts within the limits.
  for (const unit of ['C', 'F']) {
    const r = rangeOf(limitsOf(zone, 'heat'), unit);
    for (let x = r.min; x <= r.max; x += unit === 'C' ? 0.5 : 1) {
      const p = pairOf(x, unit);
      assert.ok(p.F <= 86 && p.C <= 30.5 && toC(p.F) <= 30.6, `${x} ${unit}`);
    }
  }
});

test('setpoints: the other one moves the safe way, within its limits, or the command is refused', () => {
  assert.deepEqual(planSetpoint(zoneOf(), 'heat', 76, 'F').fields, {
    hsp: 76,
    hspC: 24.5,
    csp: 79,
    cspC: 26,
  });
  assert.deepEqual(planSetpoint(zoneOf(), 'cool', 66, 'F').fields, {
    hsp: 63,
    hspC: 17.5,
    csp: 66,
    cspC: 19,
  });
  assert.equal(
    planSetpoint(zoneOf({ minHsp: 64, minHspC: 18 }), 'cool', 66, 'F').error,
    'deadband',
  );
  assert.equal(
    planSetpoint(zoneOf({ maxCsp: 79, maxCspC: 26 }), 'heat', 77, 'F').error,
    'deadband',
  );
  assert.equal(planSetpoint(zoneOf(), 'heat', 68, 'F').same, true);
  assert.equal(limitsOf(zoneOf({ maxHsp: 120 }), 'heat').F.max, SETPOINT_BOUNDS.heat.F.max);
  assert.equal(planSetpoint(zoneOf({ maxHsp: undefined }), 'heat', 70, 'F').error, 'limits');
  assert.equal(planSetpoint(zoneOf({}, { csp: undefined }), 'heat', 70, 'F').error, 'missing');
});

function modelOf(options = {}) {
  const m = emptyModel();
  applyMessage(
    m,
    {
      SenderID: 'LCC',
      Data: {
        system: { config: { name: 'House', temperatureUnit: 'F' } },
        zones: [
          {
            id: 0,
            config: { name: 'Main', heatingOption: true, coolingOption: true, ...options },
            status: { temperature: 70, temperatureStatus: 'good' },
          },
        ],
      },
    },
    0,
  );
  return m;
}

// The core's own validator of supported_options, when a Gladys clone is at hand
// (not on GitHub CI): the rules below are its schema, this is the proof.
const CORE_NORMALIZE = '/home/claude/code/Gladys/server/utils/normalizeSupportedOptions.js';
const normalizeSupportedOptions = existsSync(CORE_NORMALIZE)
  ? createRequire(import.meta.url)(CORE_NORMALIZE).normalizeSupportedOptions
  : undefined;

test('the supported options follow the rules of the core (a bad one refuses all Discovery)', () => {
  const gladys = createFakeGladys({ config: {} });
  const OPTION_KEYS = ['id', 'value', 'label', 'sort_order'];
  let lists = 0;
  for (const language of ['fr', 'en']) {
    for (const options of [{}, { coolingOption: false }, { heatingOption: false }]) {
      const m = modelOf(options);
      const device = buildZoneDevice(gladys, 'abcd1234', m, m.zones.get(0), { language });
      for (const f of device.features) {
        if (f.supported_options === undefined) continue;
        lists += 1;
        const allowStringValues = f.category === C.TEXT && f.type === TYPES.TEXT.SELECT;
        assert.ok(f.supported_options.length > 0);
        for (const option of f.supported_options) {
          assert.equal(typeof option.label, 'string');
          assert.ok(option.label.trim().length > 0);
          assert.equal(option.label, option.label.trim());
          assert.ok(
            Number.isInteger(option.value) ||
              (allowStringValues &&
                typeof option.value === 'string' &&
                option.value === option.value.trim() &&
                option.value !== ''),
          );
          assert.deepEqual(
            Object.keys(option).filter((k) => !OPTION_KEYS.includes(k)),
            [],
          );
        }
        const values = f.supported_options.map((o) => `${o.value}`);
        assert.equal(new Set(values).size, values.length);
        if (normalizeSupportedOptions) {
          assert.doesNotThrow(() =>
            normalizeSupportedOptions(f.supported_options, { allowStringValues }),
          );
        }
      }
    }
  }
  assert.equal(lists, 12, 'mode and fan of each zone');
});

test('devices: no switch, no writable binary, ids frozen and parsed back', () => {
  const gladys = createFakeGladys({ config: {} });
  const m = modelOf({ coolingOption: false });
  const zone = buildZoneDevice(gladys, 'abcd1234', m, m.zones.get(0), { language: 'en' });
  const system = buildSystemDevice(gladys, 'abcd1234', m, { language: 'en' });
  assert.equal(zone.external_id, 'ext:test-integration:lennox:abcd1234-zone0');
  assert.equal(system.external_id, 'ext:test-integration:lennox:abcd1234');
  assert.ok(!zone.features.some((f) => f.external_id.endsWith(':cool-setpoint')));
  for (const f of [...zone.features, ...system.features]) {
    assert.notEqual(f.category, 'switch');
    assert.ok(f.type !== 'binary' || f.read_only);
  }
  const mode = zone.features.find((f) => f.external_id.endsWith(':mode'));
  assert.deepEqual(
    mode.supported_options.map((o) => o.value),
    [0, 1],
  );
  assert.deepEqual(parseFeatureId(`${zone.external_id}:${F.MODE}`), {
    serial: 'abcd1234',
    zone: 0,
    key: 'mode',
  });
  assert.deepEqual(parseFeatureId(`${system.external_id}:${F.OUTDOOR}`), {
    serial: 'abcd1234',
    zone: undefined,
    key: 'outdoor-temperature',
  });
  assert.equal(parseFeatureId(`${zone.external_id}:bogus`), undefined);
  assert.deepEqual(parseDeviceId(zone.external_id), { serial: 'abcd1234', zone: 0 });
  // A created device keeps its features as created (no "structure changed").
  const created = {
    ...zone,
    features: zone.features.map((f) => ({ ...f, unit: f.unit, min: -99 })),
  };
  const again = buildZoneDevice(gladys, 'abcd1234', m, m.zones.get(0), { language: 'en', created });
  assert.ok(again.features.every((f) => f.min === -99 || f.min === undefined));
});

test('command values are strict', () => {
  assert.deepEqual(commandValue(F.MODE, 0), { mode: 'off' });
  assert.deepEqual(commandValue(F.MODE, '3'), { mode: 'heat and cool' });
  assert.equal(commandValue(F.MODE, 4), undefined);
  assert.equal(commandValue(F.MODE, ''), undefined);
  assert.equal(commandValue(F.MODE, true), undefined);
  assert.equal(commandValue(F.MODE, null), undefined);
  assert.deepEqual(commandValue(F.FAN_MODE, 'circulate'), { fan: 'circulate' });
  assert.equal(commandValue(F.FAN_MODE, 'turbo'), undefined);
  assert.deepEqual(commandValue(F.HEAT_SETPOINT, '20.5'), { setpoint: 'heat', asked: 20.5 });
  assert.equal(commandValue(F.TEMPERATURE, 20), undefined);
});

test('the address: no broadcast, multicast, unspecified, nor credentials shown back', () => {
  assert.deepEqual(parseAddress('https://192.168.1.60/x'), { host: '192.168.1.60', port: 443 });
  assert.deepEqual(parseAddress('thermostat.lan:8443'), { host: 'thermostat.lan', port: 8443 });
  for (const bad of ['0.0.0.0', '224.0.0.1', '192.168.1.255', 'a b', 'u:p@1.2.3.4', '999.1.1.1']) {
    assert.equal(parseAddress(bad), undefined, bad);
  }
  const c = normalizeConfig({
    host: 'user:secret@thermostat',
    allow_commands: 'yes',
    poll_interval: '',
  });
  assert.doesNotMatch(c.invalidHost, /secret/);
  assert.equal(c.allowCommands, false);
  assert.equal(c.pollInterval, 10);
  assert.equal(normalizeConfig({ poll_interval: 1 }).pollInterval, 5);
});
