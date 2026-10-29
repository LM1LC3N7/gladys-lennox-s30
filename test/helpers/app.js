// -----------------------------------------------------------------------------
// The app against the SDK's fake Gladys (the real wiring of src/handlers.js),
// the fake thermostat of fakeLennox.js and the virtual clock of the testkit:
// every read of the clock moves it (1 µs), and nothing fires unless the test
// moves it on.
// -----------------------------------------------------------------------------

import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { testClock, settle } from '../kit/index.mjs';
import { LennoxApp } from '../../src/app.js';
import { SECOND } from '../../src/constants.js';
import { registerHandlers } from '../../src/handlers.js';
import { memoryStore } from '../../src/store.js';
import { HOST, NOW, SERIAL_ID, fakeLennox } from './fakeLennox.js';

export { settle };
export const CONFIG = { host: HOST };
export const ALLOWED = { ...CONFIG, allow_commands: true };
export const ZONE = (z) => `ext:test-integration:lennox:${SERIAL_ID}-zone${z}`;
export const SYSTEM = `ext:test-integration:lennox:${SERIAL_ID}`;
export const feature = (z, key) => `${z === undefined ? SYSTEM : ZONE(z)}:${key}`;
export const FIRST_READ = [
  'POST /Endpoints/gladys/Connect',
  'POST /Messages/RequestData',
  'GET /Messages/gladys/Retrieve',
];

export const recorder = (logs) =>
  Object.fromEntries(
    ['debug', 'info', 'warn', 'error'].map((level) => [
      level,
      (...args) => logs.push(args.map((a) => (a instanceof Error ? a.stack : String(a))).join(' ')),
    ]),
  );

/**
 * `clock`, `lennox` and `store` may be shared between two lives (a restart).
 * `create`: the devices are created in Gladys after the first read.
 */
export async function setup(
  t,
  {
    config = CONFIG,
    clock = testClock({ start: NOW }),
    lennox,
    store = memoryStore(),
    create = true,
    logs = [],
    devices,
    getConfig,
    connect = true,
  } = {},
) {
  const thermostat = lennox ?? fakeLennox({ timers: clock.timers });
  const gladys = createFakeGladys({ config, ...(devices ? { devices } : {}) });
  if (getConfig) {
    gladys.getConfig = getConfig;
  }
  const app = new LennoxApp({
    gladys,
    logger: recorder(logs),
    exchange: thermostat.exchange,
    now: clock.now,
    monotonic: clock.monotonic,
    timers: clock.timers,
    store,
  });
  registerHandlers(gladys, app);
  t.after(() => app.halt());
  const advance = async (ms, step = SECOND) => {
    for (let elapsed = 0; elapsed < ms; elapsed += step) {
      await clock.advance(Math.min(step, ms - elapsed));
      await settle();
    }
  };
  if (connect) {
    await gladys.connect();
    await settle();
    await app.lifecycle;
    await settle();
  }
  if (create && !devices) {
    for (const device of gladys.fake.discoveredDevices) {
      await gladys.fake.deviceCreated(device);
    }
    await settle();
  }
  const target = (z, key) => {
    const device = gladys.fake.devices.find(
      (d) => d.external_id === (z === undefined ? SYSTEM : ZONE(z)),
    );
    return [device, device.features.find((f) => f.external_id === feature(z, key))];
  };
  const send = (z, key, value) => gladys.fake.setValue(...target(z, key), value);
  /** A command, the clock moved on until it answers (5 s at most, as Gladys waits). */
  const press = async (z, key, value, wait = 5 * SECOND) => {
    const ack = send(z, key, value);
    await settle();
    await advance(wait, 50);
    return ack;
  };
  return { gladys, app, lennox: thermostat, store, clock, advance, logs, press, send, target };
}

export const last = (gladys, z, key) => gladys.fake.lastState(feature(z, key));
export const message = (gladys) => gladys.fake.connectionStatus?.message ?? {};
