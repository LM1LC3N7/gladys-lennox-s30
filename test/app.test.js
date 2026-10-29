// -----------------------------------------------------------------------------
// End to end: the real SDK wiring (src/handlers.js) against the SDK's fake
// Gladys, a fake thermostat behind the injected `exchange`, and a virtual
// clock (each read moves it 1 µs; the tests move it on).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEVICE_TRANSPORTS } from '@gladysassistant/integration-sdk';
import { ACTIONS, FEATURES as F, SECOND, THERMOSTAT_MODE } from '../src/constants.js';
import { memoryStore } from '../src/store.js';
import { FP, SERIAL_ID } from './helpers/fakeLennox.js';
import { ALLOWED, CONFIG, FIRST_READ, ZONE, SYSTEM, last, message, setup } from './helpers/app.js';

test('first read: connect, subscribe, the queue; the devices and their states', async (t) => {
  const { gladys, lennox, store } = await setup(t);
  assert.deepEqual(lennox.routes().slice(0, 3), FIRST_READ);
  assert.ok(lennox.connections.every((c) => c.fingerprintChecked));
  const sub = lennox.requests[1].json;
  assert.equal(sub.SenderID, 'gladys');
  assert.equal(sub.TargetID, 'LCC');
  const ids = gladys.fake.discoveredDevices.map((d) => d.external_id).sort();
  assert.deepEqual(ids, [SYSTEM, ZONE(0), ZONE(1)].sort());
  const zone0 = gladys.fake.discoveredDevices.find((d) => d.external_id === ZONE(0));
  assert.equal(zone0.name, 'Main Floor');
  assert.ok(!zone0.features.some((f) => f.category === 'switch'));
  assert.ok(zone0.features.every((f) => f.type !== 'binary' || f.read_only));
  // °F as the thermostat shows it.
  assert.equal(last(gladys, 0, F.TEMPERATURE), 68.9);
  assert.equal(last(gladys, 0, F.HUMIDITY), 45);
  assert.equal(last(gladys, 0, F.MODE), THERMOSTAT_MODE.HEATING);
  assert.equal(last(gladys, 1, F.MODE), THERMOSTAT_MODE.COOLING);
  assert.equal(last(gladys, 0, F.HEAT_SETPOINT), 68);
  assert.equal(last(gladys, 0, F.COOL_SETPOINT), 77);
  assert.equal(last(gladys, 0, F.OPERATING_STATE), 1);
  assert.equal(last(gladys, 0, F.FAN_MODE), 'auto');
  assert.equal(last(gladys, 0, F.FAN_RUNNING), 0);
  assert.equal(last(gladys, undefined, F.OUTDOOR), 41);
  assert.equal(last(gladys, undefined, F.ALERT_LEVEL), 'Aucune');
  assert.equal(last(gladys, undefined, F.ALERT_COUNT), 0);
  assert.equal(last(gladys, undefined, F.ALERTS), 'Aucune alerte');
  assert.match(message(gladys).en, /^Connected\. House: 2 zones\./);
  assert.equal(gladys.fake.transports.at(-1).transport, DEVICE_TRANSPORTS.LOCAL);
  assert.equal(store.data.pin, FP);
  assert.equal(store.data.serial, SERIAL_ID);
});

const OFF = THERMOSTAT_MODE.OFF;
const publishes = (lennox) => lennox.requests.filter((r) => r.route === 'POST /Messages/Publish');

test('commands are off by default: refused, nothing sent; Off goes without the option', async (t) => {
  const { gladys, lennox, press } = await setup(t);
  lennox.requests.length = 0;
  const ack = await press(0, F.HEAT_SETPOINT, 70);
  assert.equal(ack.success, false);
  assert.match(ack.error, /désactivées/);
  for (const [key, value] of [
    [F.MODE, THERMOSTAT_MODE.COOLING],
    [F.COOL_SETPOINT, 75],
    [F.FAN_MODE, 'on'],
  ]) {
    assert.equal((await press(0, key, value)).success, false);
  }
  assert.equal(publishes(lennox).length, 0);
  const off = await press(0, F.MODE, OFF);
  assert.equal(off.success, true, off.error);
  const [p] = publishes(lennox);
  // The zone follows its manual schedule: one change, systemMode off in schedule 16.
  assert.deepEqual(p.json.Data, {
    schedules: [{ id: 16, schedule: { periods: [{ id: 0, period: { systemMode: 'off' } }] } }],
  });
  assert.equal(p.json.MessageType, 'Command');
  assert.equal(p.json.SenderID, 'gladys');
  assert.equal(last(gladys, 0, F.MODE), OFF);
});

test('Off of a zone following a program: the manual schedule off first, then followed', async (t) => {
  const { lennox, press, app } = await setup(t, {});
  lennox.state.zones[0].scheduleId = 1;
  lennox.push({ zones: [{ id: 0, config: { scheduleId: 1 } }] });
  await app.tick({ followUp: true });
  lennox.requests.length = 0;
  const ack = await press(0, F.MODE, OFF);
  assert.equal(ack.success, true, ack.error);
  const [first, second] = publishes(lennox);
  assert.deepEqual(first.json.Data.schedules[0].schedule.periods[0].period, { systemMode: 'off' });
  assert.deepEqual(second.json.Data, { zones: [{ id: 0, config: { scheduleId: 16 } }] });
  assert.equal(lennox.state.zones[0].period.systemMode, 'off');
});

test('Off with the thermostat unreachable: kept in /data, sent every 30 s, never dropped by the time', async (t) => {
  const { lennox, press, advance, store, gladys } = await setup(t);
  lennox.fail['POST /Messages/Publish'] = 'unreachable';
  const ack = await press(0, F.MODE, OFF);
  assert.equal(ack.success, false);
  assert.match(ack.error, /gardé dans \/data/);
  assert.equal(store.data.pendingStops['0'].state, 'unsent');
  assert.match(message(gladys).en, /Off not applied yet/);
  await advance(3 * 3600 * SECOND, 30 * SECOND);
  assert.ok(store.data.pendingStops['0'], 'still kept after 3 h');
  delete lennox.fail['POST /Messages/Publish'];
  await advance(40 * SECOND);
  assert.equal(lennox.state.zones[0].period.systemMode, 'off');
  assert.deepEqual(store.data.pendingStops, {});
});

test('after a restart, the Off kept in /data goes before any configuration or read', async (t) => {
  const store = memoryStore();
  const first = await setup(t, { store });
  first.lennox.fail['POST /Messages/Publish'] = 'unreachable';
  await first.press(1, F.MODE, OFF);
  first.app.halt();
  delete first.lennox.fail['POST /Messages/Publish'];
  first.lennox.requests.length = 0;
  first.lennox.queue = undefined;
  // A new life: getConfig() fails, nothing read, the Off goes from /data alone.
  let calls = 0;
  const again = await setup(t, {
    store,
    lennox: first.lennox,
    clock: first.clock,
    create: false,
    devices: first.gladys.fake.devices,
    // The first call is the resynchronization of the fake connect().
    getConfig: async () => {
      calls += 1;
      if (calls === 1) return {};
      throw new Error('down');
    },
  });
  await again.advance(2 * SECOND, 100);
  assert.ok(calls >= 2);
  assert.equal(again.app.config, undefined);
  const routes = again.lennox.routes();
  assert.ok(routes.includes('POST /Messages/Publish'), routes.join(', '));
  assert.ok(!routes.includes('POST /Messages/RequestData'));
  assert.equal(again.lennox.state.zones[1].period.systemMode, 'off');
});

test('getConfig() failing in connected is asked again without end, then the reads resume', async (t) => {
  let calls = 0;
  const ctx = await setup(t, {
    getConfig: async () => {
      calls += 1;
      if (calls === 2 || calls === 3) throw new Error('down');
      return CONFIG;
    },
  });
  assert.match(message(ctx.gladys).en, /could not be read from Gladys/);
  await ctx.advance(25 * SECOND);
  assert.match(message(ctx.gladys).en, /^Connected/);
  assert.ok(ctx.lennox.count('GET /Messages/gladys/Retrieve') >= 1);
});

test('Off goes during a 5xx pause, through a frozen read, and with /data slow or read only', async (t) => {
  const { lennox, advance, store, app, gladys } = await setup(t);
  lennox.fail['GET /Messages/gladys/Retrieve'] = 503;
  await advance(app.interval + SECOND);
  assert.ok(app.paused());
  assert.match(message(gladys).en, /server error/);
  delete lennox.fail['GET /Messages/gladys/Retrieve'];
  // A read that never answers holds the link: the Off takes it.
  lennox.fail['GET /Messages/gladys/Retrieve'] = 'silent';
  app.memory.pause = null;
  app.lastReadAt = -Infinity;
  const reading = app.tick();
  await advance(SECOND, 100);
  assert.equal(app.holder?.kind, 'poll');
  // /data slow and failing: the Off never waits for it.
  let release;
  store.hold = new Promise((r) => {
    release = r;
  });
  store.failSave = true;
  const ack = gladys.fake.setValue(
    gladys.fake.devices.find((d) => d.external_id === ZONE(0)),
    gladys.fake.devices
      .find((d) => d.external_id === ZONE(0))
      .features.find((f) => f.external_id.endsWith(':mode')),
    OFF,
  );
  await advance(SECOND, 50);
  // The model was not read in this session: the zone may follow a program, both changes go.
  assert.deepEqual(publishes(lennox)[0].json.Data.schedules[0].schedule.periods[0].period, {
    systemMode: 'off',
  });
  assert.equal(lennox.state.zones[0].period.systemMode, 'off');
  delete lennox.fail['GET /Messages/gladys/Retrieve'];
  release();
  await advance(5 * SECOND, 50);
  await ack;
  await reading;
});

test('Off refused 3 times in a row: given up and said; a click starts again', async (t) => {
  const { lennox, press, advance, store, gladys } = await setup(t);
  lennox.publishCode = 2;
  const ack = await press(0, F.MODE, OFF);
  assert.equal(ack.success, false);
  assert.equal(store.data.pendingStops['0'].refusal.count, 1);
  await advance(11 * 60 * SECOND, 30 * SECOND);
  assert.deepEqual(store.data.pendingStops, {});
  assert.equal(store.data.stopGivenUp['0'].status, 'code 2');
  assert.match(message(gladys).en, /given up/);
  assert.ok(gladys.fake.transports.some((e) => e.degraded));
  lennox.publishCode = 1;
  assert.equal((await press(0, F.MODE, OFF)).success, true);
  assert.deepEqual(store.data.stopGivenUp, {});
});

test('Off accepted but read not off: sent again, 3 accepted sends at most, never by the time', async (t) => {
  const { lennox, press, advance, store } = await setup(t);
  lennox.ignorePublish = true;
  const ack = await press(0, F.MODE, OFF);
  assert.equal(ack.success, false);
  assert.match(ack.error, /accepté/);
  assert.equal(store.data.pendingStops['0'].state, 'awaiting');
  // The check reads (everything asked again, 6 s after, then every 30 s)
  // show the zone still heating: sent again, 3 accepted sends at most.
  await advance(10 * SECOND);
  assert.equal(publishes(lennox).length, 2);
  await advance(2 * 60 * SECOND);
  assert.equal(publishes(lennox).length, 3);
  await advance(10 * 60 * SECOND, 10 * SECOND);
  assert.equal(publishes(lennox).length, 3);
  assert.equal(store.data.stopGivenUp['0'].status, 'not applied');
});

test('a scene stopping every zone, slow thermostat: every zone off in one change', async (t) => {
  const { lennox, send, advance } = await setup(t);
  lennox.latency = 800;
  const acks = [send(0, F.MODE, OFF), send(1, F.MODE, OFF)];
  await advance(5 * SECOND, 50);
  const results = await Promise.all(acks);
  assert.ok(
    results.every((r) => r.success),
    JSON.stringify(results),
  );
  assert.equal(publishes(lennox)[0].json.Data.schedules.length, 2);
});

const periodOf = (r) => r.json.Data.schedules?.[0]?.schedule.periods[0].period;

test('heat setpoint: both units written, bounded, confirmed by a read', async (t) => {
  const { gladys, lennox, press } = await setup(t, { config: ALLOWED });
  lennox.requests.length = 0;
  const ack = await press(0, F.HEAT_SETPOINT, 70);
  assert.equal(ack.success, true, ack.error);
  // The queue emptied after the click, then the change.
  assert.deepEqual(lennox.routes().slice(0, 2), [
    'GET /Messages/gladys/Retrieve',
    'POST /Messages/Publish',
  ]);
  assert.deepEqual(periodOf(publishes(lennox)[0]), { hsp: 70, hspC: 21, csp: 77, cspC: 25 });
  assert.equal(publishes(lennox)[0].json.Data.schedules[0].id, 16);
  assert.equal(last(gladys, 0, F.HEAT_SETPOINT), 70);
  // Outside the limits of the zone: refused, nothing sent.
  const high = await press(0, F.HEAT_SETPOINT, 91);
  assert.match(high.error, /40 à 90 °F/);
  const low = await press(0, F.HEAT_SETPOINT, 39);
  assert.equal(low.success, false);
  for (const bad of ['', ' ', null, true, '70abc', 'NaN']) {
    assert.equal((await press(0, F.HEAT_SETPOINT, bad)).success, false, String(bad));
  }
  assert.equal(publishes(lennox).length, 1);
});

test('the other setpoint moves out of the way, never the unsafe way', async (t) => {
  const { lennox, press } = await setup(t, { config: ALLOWED });
  assert.equal((await press(0, F.HEAT_SETPOINT, 76)).success, true);
  assert.deepEqual(periodOf(publishes(lennox).at(-1)), { hsp: 76, hspC: 24.5, csp: 79, cspC: 26 });
  assert.equal((await press(1, F.COOL_SETPOINT, 66)).success, true);
  assert.deepEqual(periodOf(publishes(lennox).at(-1)), { hsp: 63, hspC: 17.5, csp: 66, cspC: 19 });
  // A cool setpoint that would push the heat setpoint under its limit: refused.
  const tight = await setup(t, { config: ALLOWED });
  tight.lennox.state.zones[0].config.minHsp = 62;
  tight.lennox.state.zones[0].config.minHspC = 16.5;
  tight.lennox.requests.length = 0;
  await tight.app.configUpdated(ALLOWED);
  tight.app.session.subscribedAt = -Infinity;
  tight.app.lastReadAt = -Infinity;
  await tight.app.tick();
  const refused = await tight.press(0, F.COOL_SETPOINT, 63);
  assert.match(refused.error, /s'écarter/);
  assert.equal(publishes(tight.lennox).length, 0);
});

test('a zone following a program: an override copied from the period, then held', async (t) => {
  const { lennox, press, app } = await setup(t, { config: ALLOWED });
  lennox.state.zones[0].scheduleId = 2;
  lennox.push({ zones: [{ id: 0, config: { scheduleId: 2 } }] });
  await app.tick({ followUp: true });
  lennox.requests.length = 0;
  const ack = await press(0, F.FAN_MODE, 'circulate');
  assert.equal(ack.success, true, ack.error);
  const [override, hold] = publishes(lennox);
  assert.equal(override.json.Data.schedules[0].id, 32);
  assert.equal(periodOf(override).fanMode, 'circulate');
  assert.equal(periodOf(override).systemMode, 'heat');
  assert.equal(periodOf(override).hsp, 68);
  assert.deepEqual(hold.json.Data.zones[0].config.scheduleHold, {
    scheduleId: 32,
    exceptionType: 'hold',
    enabled: true,
    expiresOn: '0',
    expirationMode: 'nextPeriod',
  });
});

test('modes: a mode ends the Off kept; a setpoint during an Off is refused', async (t) => {
  const { gladys, lennox, press, store } = await setup(t, { config: ALLOWED });
  lennox.ignorePublish = true;
  await press(0, F.MODE, OFF);
  assert.ok(store.data.pendingStops['0']);
  const set = await press(0, F.HEAT_SETPOINT, 70);
  assert.match(set.error, /arrêt de cette zone est en cours/);
  lennox.ignorePublish = false;
  const heat = await press(0, F.MODE, THERMOSTAT_MODE.COOLING);
  assert.equal(heat.success, true, heat.error);
  assert.deepEqual(store.data.pendingStops, {});
  assert.equal(last(gladys, 0, F.MODE), THERMOSTAT_MODE.COOLING);
});

test('away mode and a /data that cannot be written refuse a command, nothing sent', async (t) => {
  const { lennox, press, store, app } = await setup(t, { config: ALLOWED });
  store.failSave = true;
  lennox.requests.length = 0;
  const ack = await press(0, F.HEAT_SETPOINT, 70);
  assert.match(ack.error, /\/data ne peut pas être écrit/);
  assert.equal(publishes(lennox).length, 0);
  store.failSave = false;
  lennox.state.manualAway = true;
  lennox.push({ occupancy: { manualAway: true } });
  await app.tick({ followUp: true });
  const away = await press(0, F.HEAT_SETPOINT, 70);
  assert.match(away.error, /absence/);
  assert.equal(publishes(lennox).length, 0);
});

test('a scene on four zones, slow thermostat: one round, every zone set; one refused stops none', async (t) => {
  const { fakeLennox, initialState, NOW } = await import('./helpers/fakeLennox.js');
  const { testClock } = await import('./kit/index.mjs');
  const clock = testClock({ start: NOW });
  const state = initialState();
  state.numberOfZones = 4;
  for (const id of [2, 3]) {
    state.zones.push({
      ...structuredClone(state.zones[0]),
      id,
      name: `Zone ${id + 1}`,
      scheduleId: 16 + id,
    });
  }
  state.zones[3].config.coolingOption = false;
  const lennox = fakeLennox({ timers: clock.timers, state });
  const { send, advance } = await setup(t, { config: ALLOWED, clock, lennox });
  lennox.latency = 800;
  const acks = [
    send(0, F.HEAT_SETPOINT, 66),
    send(1, F.COOL_SETPOINT, 80),
    send(2, F.FAN_MODE, 'on'),
    send(3, F.MODE, THERMOSTAT_MODE.AUTO),
  ];
  await advance(5 * SECOND, 50);
  const results = await Promise.all(acks);
  assert.deepEqual(
    results.map((r) => r.success),
    [true, true, true, false],
    JSON.stringify(results),
  );
  assert.equal(publishes(lennox).length, 1);
  assert.equal(lennox.state.zones[0].period.hsp, 66);
  assert.equal(lennox.state.zones[1].period.csp, 80);
  assert.equal(lennox.state.zones[2].period.fanMode, 'on');
  assert.equal(lennox.state.zones[3].period.systemMode, 'heat');
});

test('nothing emitted before an Off leaves after it', async (t) => {
  const { lennox, send, advance } = await setup(t, { config: ALLOWED });
  lennox.latency = 600;
  const set = send(0, F.HEAT_SETPOINT, 75);
  await advance(300, 50);
  const off = send(0, F.MODE, OFF);
  await advance(5 * SECOND, 50);
  const [a, b] = await Promise.all([set, off]);
  assert.equal(a.success, false);
  assert.match(a.error, /arrêt/i);
  assert.equal(b.success, true, b.error);
  assert.ok(publishes(lennox).every((p) => periodOf(p)?.hsp === undefined));
  assert.equal(lennox.state.zones[0].period.systemMode, 'off');
});

test('a °C thermostat: °C features, readings converted exactly, setpoints in half degrees', async (t) => {
  const { fakeLennox, initialState } = await import('./helpers/fakeLennox.js');
  const { testClock } = await import('./kit/index.mjs');
  const { NOW } = await import('./helpers/fakeLennox.js');
  const clock = testClock({ start: NOW });
  const state = initialState();
  state.unit = 'C';
  const lennox = fakeLennox({ timers: clock.timers, state });
  const { gladys, press } = await setup(t, { config: ALLOWED, clock, lennox });
  const zone0 = gladys.fake.discoveredDevices.find((d) => d.external_id === ZONE(0));
  const heat = zone0.features.find((f) => f.external_id.endsWith(':heat-setpoint'));
  assert.equal(heat.unit, 'celsius');
  assert.deepEqual([heat.min, heat.max], [4.5, 32]);
  // 68.875 °F = 20.486 °C (the thermostat rounds it to 20.5 itself).
  assert.equal(last(gladys, 0, F.TEMPERATURE), 20.5);
  assert.equal(last(gladys, undefined, F.OUTDOOR), 5);
  assert.equal(last(gladys, 0, F.HEAT_SETPOINT), 20);
  const ack = await press(0, F.HEAT_SETPOINT, 21.3);
  assert.equal(ack.success, true, ack.error);
  // 21.5 °C, and 70.7 °F -> 71 °F, both within the limits.
  assert.deepEqual(periodOf(publishes(lennox).at(-1)), { hsp: 71, hspC: 21.5, csp: 77, cspC: 25 });
  assert.match((await press(0, F.HEAT_SETPOINT, 32.4)).error, /4\.5 à 32 °C/);
});

test('a reading whose status is not good is not a measurement; a text is never 0', async (t) => {
  const { gladys, lennox, app } = await setup(t);
  const before = gladys.fake.states.length;
  lennox.push({
    zones: [{ id: 0, status: { temperatureStatus: 'not_available', temperature: 0 } }],
  });
  lennox.push({
    system: { status: { outdoorTemperatureStatus: 'not_exist', outdoorTemperature: 0 } },
  });
  lennox.push({ zones: [{ id: 1, status: { humidity: 'n/a', temperature: '70' } }] });
  await app.tick({ followUp: true });
  const after = gladys.fake.states.slice(before);
  assert.ok(
    !after.some((s) => s.state === 0 && /temperature|humidity/.test(s.device_feature_external_id)),
  );
  assert.equal(last(gladys, 0, F.TEMPERATURE), 68.9);
});

test('the certificate changed: nothing sent; trusted in two clicks, then the Off kept goes', async (t) => {
  const { gladys, lennox, press, advance, app, store } = await setup(t);
  const { OTHER_FP } = await import('./helpers/fakeLennox.js');
  lennox.fingerprint = OTHER_FP;
  lennox.requests.length = 0;
  await advance(app.interval + SECOND);
  const off = await press(0, F.MODE, OFF);
  assert.equal(off.success, false);
  assert.equal(lennox.requests.length, 0);
  assert.match(message(gladys).en, /certificate of the thermostat changed/);
  assert.equal(store.data.refusedPin, OTHER_FP);
  const first = await gladys.fake.action(ACTIONS.TRUST_CERTIFICATE);
  assert.match(first.data.message.en, new RegExp(OTHER_FP));
  assert.equal(store.data.pin, FP);
  await advance(4 * SECOND);
  await gladys.fake.action(ACTIONS.TRUST_CERTIFICATE);
  await advance(SECOND, 100);
  assert.equal(store.data.pin, OTHER_FP);
  assert.equal(lennox.state.zones[0].period.systemMode, 'off');
});

test('the thermostat gone: unreachable, no old value published as new; back: a new session', async (t) => {
  const { gladys, lennox, advance, app } = await setup(t);
  for (const r of ['GET /Messages/gladys/Retrieve', 'POST /Endpoints/gladys/Connect']) {
    lennox.fail[r] = 'unreachable';
  }
  await advance(app.interval + SECOND);
  assert.match(message(gladys).en, /No answer from 192\.168\.1\.60/);
  assert.equal(gladys.fake.transports.at(-1).transport, DEVICE_TRANSPORTS.UNREACHABLE);
  const before = gladys.fake.states.length;
  gladys.fake.forgetPublishedStates?.();
  await app.connected(CONFIG);
  await app.deviceCreated(gladys.fake.devices[0]);
  await advance(60 * SECOND);
  assert.equal(gladys.fake.states.length, before, 'nothing republished while unreachable');
  lennox.fail = {};
  lennox.requests.length = 0;
  await advance(5 * 60 * SECOND);
  // The session is kept (the queue stays readable): no Connect, the numbers go on.
  assert.equal(lennox.count('POST /Endpoints/gladys/Connect'), 0);
  assert.ok(lennox.count('GET /Messages/gladys/Retrieve') >= 1);
  assert.match(message(gladys).en, /^Connected/);
});

test('another thermostat at the address: its devices are new, the old ones unreachable, the Off kept dropped', async (t) => {
  const { gladys, lennox, press, advance, app, store } = await setup(t);
  lennox.fail['POST /Messages/Publish'] = 'unreachable';
  await press(0, F.MODE, OFF);
  assert.ok(store.data.pendingStops['0']);
  delete lennox.fail['POST /Messages/Publish'];
  lennox.state.serial = 'KL21J00002';
  lennox.queue = undefined;
  lennox.requests.length = 0;
  app.session.connected = false;
  await advance(app.interval + SECOND, 100);
  assert.equal(publishes(lennox).length, 0);
  assert.deepEqual(store.data.pendingStops, {});
  assert.equal(store.data.serial, 'kl21j00002');
  assert.match(message(gladys).en, /Not read any more/);
  assert.ok(gladys.fake.discoveredDevices.some((d) => d.external_id.includes('kl21j00002')));
});

test('a change answered with silence: "sent, without confirmation", then read again', async (t) => {
  const { lennox, press, app } = await setup(t, { config: ALLOWED });
  lennox.fail['POST /Messages/Publish'] = 'drop';
  const ack = await press(0, F.HEAT_SETPOINT, 70);
  assert.match(ack.error, /sans confirmation/);
  assert.ok(app.memory.guards['0'], 'guarded until a read shows it');
  assert.match((await press(0, F.HEAT_SETPOINT, 72)).error, /pas encore visible/);
  lennox.fail['POST /Messages/Publish'] = 400;
  delete app.memory.guards['0'];
  const refused = await press(0, F.HEAT_SETPOINT, 71);
  assert.match(refused.error, /Refusé par le thermostat \(HTTP 400\)/);
});

test('never read sooner than the interval: button, reconnection, unchanged save', async (t) => {
  const { gladys, lennox, app, advance } = await setup(t);
  lennox.requests.length = 0;
  const ack = await gladys.fake.action(ACTIONS.TEST_CONNECTION);
  assert.match(ack.data.message.en, /at most once per interval/);
  await app.configUpdated(CONFIG);
  await app.connectedVia(async () => CONFIG);
  await advance(5 * SECOND);
  assert.equal(lennox.requests.length, 0);
  await advance(app.interval);
  assert.deepEqual(lennox.routes(), ['GET /Messages/gladys/Retrieve']);
});

test('commands off: refused on arrival, the thermostat not even read', async (t) => {
  const { lennox, press } = await setup(t);
  lennox.requests.length = 0;
  assert.equal((await press(0, F.FAN_MODE, 'on')).success, false);
  assert.equal(lennox.requests.length, 0);
});

test('the option turned off while a command reads: checked again right before the bytes go', async (t) => {
  const { lennox, send, advance, app } = await setup(t, { config: ALLOWED });
  lennox.latency = 400;
  const ack = send(0, F.HEAT_SETPOINT, 72);
  await advance(200, 50);
  await app.configUpdated(CONFIG);
  await advance(5 * SECOND, 50);
  const result = await ack;
  assert.match(result.error, /désactivées/);
  assert.equal(publishes(lennox).length, 0);
});

test('a mode clicked just before an Off never leaves after it', async (t) => {
  const { lennox, send, advance } = await setup(t, { config: ALLOWED });
  lennox.latency = 300;
  const cool = send(0, F.MODE, THERMOSTAT_MODE.COOLING);
  await advance(100, 20);
  const off = send(0, F.MODE, OFF);
  await advance(5 * SECOND, 50);
  const [a, b] = await Promise.all([cool, off]);
  assert.equal(a.success, false);
  assert.equal(b.success, true, b.error);
  assert.ok(publishes(lennox).every((p) => periodOf(p)?.systemMode !== 'cool'));
  assert.equal(lennox.state.zones[0].period.systemMode, 'off');
});

test('a setpoint during an Off kept: refused on arrival, and again right before the bytes go', async (t) => {
  const { lennox, press, send, advance, app } = await setup(t, { config: ALLOWED });
  lennox.ignorePublish = true;
  await press(1, F.MODE, OFF);
  lennox.requests.length = 0;
  assert.match((await press(1, F.COOL_SETPOINT, 80)).error, /arrêt de cette zone est en cours/);
  // Only the Off sent again (contradicted by its check reads): the command itself sent nothing.
  assert.ok(publishes(lennox).every((p) => periodOf(p)?.systemMode === 'off'));
  // An Off kept appearing while a setpoint of another zone reads (from /data, a
  // restart of the stop sender): that setpoint is refused before its bytes.
  lennox.latency = 300;
  const ack = send(0, F.HEAT_SETPOINT, 71);
  await advance(100, 20);
  app.memory.pendingStops[0] = { ...app.memory.pendingStops[1], state: 'awaiting' };
  await advance(5 * SECOND, 50);
  assert.match((await ack).error, /arrêt de cette zone est en cours/);
  assert.ok(publishes(lennox).every((p) => periodOf(p)?.hsp === undefined));
});

test('commands off: the option is the first answer, even during an Off kept', async (t) => {
  const { lennox, press } = await setup(t);
  lennox.ignorePublish = true;
  await press(0, F.MODE, OFF);
  assert.match((await press(0, F.HEAT_SETPOINT, 70)).error, /désactivées/);
});

test('two setpoints of a zone during an Off kept: both refused for the Off', async (t) => {
  const { lennox, press, send, advance } = await setup(t, { config: ALLOWED });
  lennox.ignorePublish = true;
  await press(0, F.MODE, OFF);
  const acks = [send(0, F.HEAT_SETPOINT, 70), send(0, F.HEAT_SETPOINT, 71)];
  await advance(5 * SECOND, 50);
  for (const ack of await Promise.all(acks)) {
    assert.match(ack.error, /arrêt de cette zone est en cours/);
  }
});

test('a mode waiting behind another Off never leaves after the Off of its zone', async (t) => {
  const { lennox, send, advance } = await setup(t, { config: ALLOWED });
  lennox.latency = 300;
  const off1 = send(1, F.MODE, OFF);
  await advance(50, 10);
  const cool = send(0, F.MODE, THERMOSTAT_MODE.COOLING);
  await advance(50, 10);
  const off0 = send(0, F.MODE, OFF);
  await advance(8 * SECOND, 50);
  const [a, b, c] = await Promise.all([off1, cool, off0]);
  assert.equal(b.success, false, JSON.stringify(b));
  assert.ok(publishes(lennox).every((p) => periodOf(p)?.systemMode !== 'cool'));
  assert.equal(lennox.state.zones[0].period.systemMode, 'off');
  assert.ok(a && c);
});

test('a mode equal to the period but not on the manual schedule: success only once read after it', async (t) => {
  const { lennox, press, app } = await setup(t, { config: ALLOWED });
  lennox.state.zones[1].scheduleId = 1;
  lennox.push({ zones: [{ id: 1, config: { scheduleId: 1 } }] });
  await app.tick({ followUp: true });
  lennox.ignorePublish = true;
  const ack = await press(1, F.MODE, THERMOSTAT_MODE.COOLING);
  assert.equal(ack.success, false);
  assert.equal(publishes(lennox).length, 2);
});

test('an old reading right after an accepted Off is no contradiction (5 s grace)', async (t) => {
  const { lennox, send, advance } = await setup(t);
  lennox.applyDelay = 2000;
  const sent = send(0, F.MODE, OFF);
  await advance(200, 50);
  lennox.change(0, { systemMode: 'heat' });
  await advance(8 * SECOND, 100);
  assert.equal((await sent).success, true);
  assert.equal(publishes(lennox).length, 1);
  assert.equal(lennox.state.zones[0].period.systemMode, 'off');
});

test('an Off not reached at once is tried again within the budget of the click', async (t) => {
  const { lennox, press } = await setup(t);
  lennox.fail['POST /Messages/Publish'] = 'unreachable-once';
  const ack = await press(0, F.MODE, OFF);
  assert.equal(ack.success, true, ack.error);
});

test('an Off kept is never ended by an old reading of the zone off', async (t) => {
  const { lennox, press, app, store } = await setup(t);
  lennox.change(0, { systemMode: 'off' });
  await app.tick({ followUp: true });
  // The zone turned on at the wall, not read yet; the Off cannot be sent.
  lennox.fail['POST /Messages/Publish'] = 'unreachable';
  await press(0, F.MODE, OFF);
  lennox.push({ system: { status: { outdoorTemperature: 40 } } });
  await app.tick({ followUp: true });
  assert.ok(store.data.pendingStops['0'], 'still kept');
});

test('/data holding an Off of another serial: dropped, never sent', async (t) => {
  const { NOW } = await import('./helpers/fakeLennox.js');
  const store = memoryStore({
    target: '192.168.1.60',
    serial: SERIAL_ID,
    pin: FP,
    pendingStops: { 0: { serial: 'other1234', at: NOW - 1000, state: 'unsent' } },
  });
  const { lennox, advance } = await setup(t, { store });
  await advance(2 * SECOND, 100);
  assert.equal(publishes(lennox).length, 0);
  assert.deepEqual(store.data.pendingStops, {});
});

test('the mode read again during an Off kept: sent anyway, it ends the Off', async (t) => {
  const { lennox, press, store } = await setup(t, { config: ALLOWED });
  lennox.ignorePublish = true;
  await press(0, F.MODE, OFF);
  lennox.ignorePublish = false;
  const before = publishes(lennox).length;
  const heat = await press(0, F.MODE, THERMOSTAT_MODE.HEATING);
  assert.equal(publishes(lennox).length, before + 1, heat.error);
  assert.deepEqual(store.data.pendingStops, {});
});
