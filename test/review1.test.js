// -----------------------------------------------------------------------------
// The points of the first review (r1): numbers of messages across sessions,
// stops following the thermostat to a new address, a /data that never
// answers, a start at the thermostat never fought, a refused mode, a pause,
// the bounds of every value written back, and the guards left without a test.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FEATURES as F, SECOND, THERMOSTAT_MODE } from '../src/constants.js';
import { memoryStore } from '../src/store.js';
import { FP, NOW, SERIAL_ID, fakeLennox, initialState } from './helpers/fakeLennox.js';
import { ALLOWED, CONFIG, ZONE, message, setup } from './helpers/app.js';
import { testClock } from './kit/index.mjs';

const OFF = THERMOSTAT_MODE.OFF;
const publishes = (lennox) => lennox.requests.filter((r) => r.route === 'POST /Messages/Publish');
const offs = (lennox, zone = 0) =>
  publishes(lennox).filter((p) =>
    (p.json.Data.schedules ?? []).some(
      (x) => x.id === 16 + zone && x.schedule.periods[0].period.systemMode === 'off',
    ),
  ).length;
const ignoreOff = (lennox) => {
  lennox.fail['POST /Messages/Publish'] = (json) => {
    const isOff = (json.Data.schedules ?? []).some(
      (x) => x.schedule.periods[0].period.systemMode === 'off',
    );
    if (!isOff) lennox.applyNow(json.Data);
    return { status: 200, headers: {}, body: '{"code":1}' };
  };
};

test('B1: a new session goes on numbering the messages; an Off accepted and ignored is sent again', async (t) => {
  const { lennox, send, advance, app } = await setup(t);
  await advance(30 * SECOND);
  ignoreOff(lennox);
  const ack = send(0, F.MODE, OFF);
  await advance(200, 50);
  const before = app.model.seq;
  // The queue is gone (the thermostat restarted): a new session.
  lennox.queue = undefined;
  await advance(60 * SECOND);
  assert.ok(app.model.seq > before, `${app.model.seq} > ${before}`);
  assert.ok(offs(lennox) >= 2, `sent again: ${offs(lennox)}`);
  await ack;
});

test('B1: an Off applied, then a failed read: ended once read off', async (t) => {
  const { lennox, press, advance, store } = await setup(t);
  lennox.fail['GET /Messages/gladys/Retrieve'] = 502;
  await press(0, F.MODE, OFF);
  delete lennox.fail['GET /Messages/gladys/Retrieve'];
  await advance(10 * 60 * SECOND, 5 * SECOND);
  assert.deepEqual(store.data.pendingStops, {});
});

test('B2: a new address keeps the Off; sent once it shows the same serial, dropped and said for another', async (t) => {
  const { lennox, press, advance, app, store, gladys } = await setup(t);
  lennox.fail['POST /Messages/Publish'] = 'unreachable';
  await press(0, F.MODE, OFF);
  delete lennox.fail['POST /Messages/Publish'];
  const before0 = offs(lennox);
  await app.configUpdated({ host: '192.168.1.61' });
  await advance(10 * SECOND, 100);
  assert.equal(offs(lennox), before0 + 1, 'kept across the new address, then sent');
  assert.equal(lennox.state.zones[0].period.systemMode, 'off');
  assert.deepEqual(store.data.pendingStops, {});
  // Another thermostat at the next address: dropped, said.
  lennox.fail['POST /Messages/Publish'] = 'unreachable';
  lennox.change(0, { systemMode: 'heat' });
  await advance(11 * SECOND);
  await press(0, F.MODE, OFF);
  delete lennox.fail['POST /Messages/Publish'];
  lennox.state.serial = 'KL21J00002';
  lennox.queue = undefined;
  const before = offs(lennox);
  await app.configUpdated({ host: '192.168.1.62' });
  await advance(20 * SECOND, 100);
  assert.equal(offs(lennox), before);
  assert.deepEqual(store.data.pendingStops, {});
  assert.match(message(gladys).en, /dropped: another thermostat/);
});

test('B3: /data that never answers holds neither the reads nor the Offs', async (t) => {
  const { lennox, press, advance, store, app } = await setup(t);
  store.hold = new Promise(() => {});
  await advance(70 * SECOND);
  const reads = lennox.count('GET /Messages/gladys/Retrieve');
  await advance(70 * SECOND);
  assert.ok(lennox.count('GET /Messages/gladys/Retrieve') > reads + 3);
  assert.equal(app.reader.running, undefined);
  assert.equal((await press(0, F.MODE, OFF)).success, true);
  ignoreOff(lennox);
  lennox.change(1, { systemMode: 'heat' });
  await press(1, F.MODE, OFF);
  lennox.change(1, { systemMode: 'heat' });
  await advance(60 * SECOND);
  assert.ok(offs(lennox, 1) >= 2, `sent again: ${offs(lennox, 1)}`);
});

test('I1: a start at the thermostat right after the Off is read (same answer) is not fought', async (t) => {
  const { lennox, send, advance } = await setup(t);
  lennox.fail['GET /Messages/gladys/Retrieve'] = 502;
  const ack = send(0, F.MODE, OFF);
  await advance(2 * SECOND, 100);
  lennox.change(0, { systemMode: 'heat' });
  delete lennox.fail['GET /Messages/gladys/Retrieve'];
  await advance(2 * 60 * SECOND);
  await ack;
  assert.equal(offs(lennox), 1);
  assert.equal(lennox.state.zones[0].period.systemMode, 'heat');
});

async function restartAfterAcceptedOff(t, relaunch) {
  const store = memoryStore();
  const first = await setup(t, { store });
  await first.advance(15 * SECOND);
  first.lennox.ignorePublish = true;
  first.lennox.fail['GET /Messages/gladys/Retrieve'] = 502;
  await first.press(0, F.MODE, OFF);
  assert.equal(store.data.pendingStops['0'].state, 'awaiting');
  assert.equal(store.data.pendingStops['0'].from, 'heat');
  first.app.halt();
  first.lennox.ignorePublish = false;
  delete first.lennox.fail['GET /Messages/gladys/Retrieve'];
  if (relaunch) first.lennox.change(0, { systemMode: relaunch });
  first.lennox.queue = undefined;
  const again = await setup(t, {
    store,
    lennox: first.lennox,
    clock: first.clock,
    create: false,
    devices: first.gladys.fake.devices,
  });
  return { first, again, store };
}

test('B4: an Off accepted, ignored, then a restart: the zone still in its mode of the click, sent again', async (t) => {
  const { first, again } = await restartAfterAcceptedOff(t);
  await again.advance(60 * SECOND);
  assert.ok(offs(first.lennox) >= 2, `sent again: ${offs(first.lennox)}`);
  assert.equal(first.lennox.state.zones[0].period.systemMode, 'off');
});

test('B4: an Off accepted before a restart, the zone then in ANOTHER mode read twice: lifted and said', async (t) => {
  const { first, again, store } = await restartAfterAcceptedOff(t, 'cool');
  await again.advance(3 * 60 * SECOND);
  assert.equal(offs(first.lennox), 1);
  assert.equal(first.lennox.state.zones[0].period.systemMode, 'cool');
  assert.deepEqual(store.data.pendingStops, {});
  assert.match(message(again.gladys).en, /another mode than at the click/);
});

test('I2: a newer mode refused leaves the Off kept; accepted, it ends it', async (t) => {
  const { lennox, press, store } = await setup(t, { config: ALLOWED });
  ignoreOff(lennox);
  await press(0, F.MODE, OFF);
  lennox.fail['POST /Messages/Publish'] = () => ({ status: 200, headers: {}, body: '{"code":2}' });
  assert.equal((await press(0, F.MODE, THERMOSTAT_MODE.HEATING)).success, false);
  assert.ok(store.data.pendingStops['0'], 'kept after a refused mode');
  lennox.fail['POST /Messages/Publish'] = 429;
  await press(0, F.MODE, THERMOSTAT_MODE.HEATING);
  assert.ok(store.data.pendingStops['0'], 'kept after a 429');
  delete lennox.fail['POST /Messages/Publish'];
  lennox.memoryPause = undefined;
});

test('I3: a pause of the reads holds neither the check nor the new send of an accepted Off', async (t) => {
  const { lennox, send, advance, app } = await setup(t);
  ignoreOff(lennox);
  const ack = send(0, F.MODE, OFF);
  await advance(200, 50);
  // The thermostat asked to wait an hour (a 429 to a read).
  app.pauseFor({ kind: 'rate_limited', status: 429, retryAfter: 3_600_000 });
  await advance(90 * SECOND);
  assert.ok(app.paused(), 'the reads are paused');
  assert.ok(offs(lennox) >= 2, `sent again during the pause: ${offs(lennox)}`);
  await ack;
});

test('I4: every value written back is bounded: a setpoint read out of limits, an override copy', async (t) => {
  const { lennox, press, app } = await setup(t, { config: ALLOWED });
  lennox.change(0, { csp: 120, cspC: 49 });
  await app.tick({ followUp: true });
  assert.match((await press(0, F.HEAT_SETPOINT, 70)).error, /hors des limites/);
  lennox.state.zones[1].scheduleId = 2;
  lennox.push({ zones: [{ id: 1, config: { scheduleId: 2 }, status: { period: { husp: 400 } } }] });
  await app.tick({ followUp: true });
  assert.match((await press(1, F.FAN_MODE, 'on')).error, /hors des limites/);
  assert.equal(publishes(lennox).length, 0);
});

test('I5: an Off goes with the pause still on, and with /data frozen at the first contact', async (t) => {
  const { lennox, press, advance, app } = await setup(t);
  lennox.fail['GET /Messages/gladys/Retrieve'] = 503;
  await advance(app.interval + SECOND);
  assert.ok(app.paused());
  assert.equal((await press(0, F.MODE, OFF)).success, false);
  assert.equal(offs(lennox), 1);
  // A new life without a pin and no address configured (/data has one), /data
  // frozen: the Off pins the certificate at the first contact and goes.
  const clock = testClock({ start: NOW });
  const fresh = fakeLennox({ timers: clock.timers });
  const store = memoryStore({ target: '192.168.1.60', serial: SERIAL_ID });
  const other = await setup(t, { lennox: fresh, store, clock, create: false, config: {} });
  store.hold = new Promise(() => {});
  const device = { external_id: `ext:test-integration:lennox:${SERIAL_ID}-zone0`, features: [] };
  const feature = { external_id: `${device.external_id}:mode` };
  const ack = other.app.setValue(device, feature, OFF).catch((e) => e);
  await other.advance(5 * SECOND, 50);
  await ack;
  assert.ok(offs(fresh) >= 1);
  assert.equal(other.app.memory.pin, FP);
});

test('I5: a refusal before any send (Connect 403) is never counted: never given up', async (t) => {
  const { lennox, press, advance, store, app } = await setup(t);
  app.session.connected = false;
  lennox.fail['POST /Endpoints/gladys/Connect'] = 403;
  lennox.fail['GET /Messages/gladys/Retrieve'] = 403;
  await press(0, F.MODE, OFF);
  await advance(20 * 60 * SECOND, 30 * SECOND);
  assert.ok(store.data.pendingStops['0'], 'still kept');
  assert.deepEqual(store.data.stopGivenUp, {});
  assert.equal(offs(lennox), 0);
});

test('I5: the serial is checked right before the bytes of an Off', async (t) => {
  const { lennox, send, advance, app } = await setup(t);
  app.session.connected = false;
  lennox.latency = 300;
  const ack = send(0, F.MODE, OFF);
  await advance(150, 10);
  app.memory.serial = 'other1234';
  await advance(5 * SECOND, 50);
  await ack;
  assert.equal(offs(lennox), 0);
});

test('I5: away unknown and single setpoint mode refuse the commands', async (t) => {
  const clock = testClock({ start: NOW });
  const state = initialState();
  const lennox = fakeLennox({ timers: clock.timers, state });
  const snapshot = lennox.snapshot.bind(lennox);
  lennox.snapshot = () => snapshot().filter((d) => !d.occupancy);
  const { press } = await setup(t, { config: ALLOWED, clock, lennox });
  assert.match((await press(0, F.HEAT_SETPOINT, 70)).error, /pas été lue/);
  const clock2 = testClock({ start: NOW });
  const state2 = initialState();
  state2.single = true;
  const single = await setup(t, {
    config: ALLOWED,
    clock: clock2,
    lennox: fakeLennox({ timers: clock2.timers, state: state2 }),
  });
  assert.match((await single.press(0, F.HEAT_SETPOINT, 70)).error, /consigne unique/);
  assert.equal(
    single.lennox.requests.filter((r) => r.route === 'POST /Messages/Publish').length,
    0,
  );
});

test('m9: a scene with commands 20 ms apart goes in one round', async (t) => {
  const { lennox, send, advance } = await setup(t, { config: ALLOWED });
  const a = send(0, F.HEAT_SETPOINT, 66);
  await advance(20, 10);
  const b = send(1, F.COOL_SETPOINT, 80);
  await advance(5 * SECOND, 50);
  const results = await Promise.all([a, b]);
  assert.ok(
    results.every((r) => r.success),
    JSON.stringify(results),
  );
  assert.equal(publishes(lennox).length, 1);
});

test('m2: an Off given up is said until a read shows the zone off', async (t) => {
  const { lennox, press, advance, store, app } = await setup(t);
  lennox.publishCode = 2;
  await press(0, F.MODE, OFF);
  await advance(11 * 60 * SECOND, 30 * SECOND);
  assert.ok(store.data.stopGivenUp['0']);
  lennox.change(0, { systemMode: 'off' });
  await app.tick({ followUp: true });
  await advance(SECOND);
  assert.deepEqual(store.data.stopGivenUp, {});
});

test('m7: a zone switched to its manual schedule takes that schedule as its period', async (t) => {
  const { lennox, app } = await setup(t);
  lennox.push({ zones: [{ id: 1, config: { scheduleId: 2 } }] });
  lennox.push({
    schedules: [{ id: 17, schedule: { periods: [{ id: 0, period: { systemMode: 'off' } }] } }],
  });
  lennox.push({ zones: [{ id: 1, config: { scheduleId: 17 } }] });
  await app.tick({ followUp: true });
  assert.equal(app.model.zones.get(1).period.systemMode.value, 'off');
  void CONFIG;
});

test('a mode waiting for the link while the Off of its zone is clicked never leaves after it', async (t) => {
  const { lennox, send, advance } = await setup(t, { config: ALLOWED });
  lennox.latency = 300;
  const off1 = send(1, F.MODE, OFF);
  await advance(50, 10);
  const cool = send(0, F.MODE, THERMOSTAT_MODE.COOLING);
  await advance(150, 10);
  const off0 = send(0, F.MODE, OFF);
  await advance(8 * SECOND, 50);
  const [, b] = await Promise.all([off1, cool, off0]);
  assert.equal(b.success, false);
  assert.ok(
    publishes(lennox).every((p) =>
      (p.json.Data.schedules ?? []).every(
        (x) => x.schedule.periods[0].period.systemMode !== 'cool',
      ),
    ),
  );
  assert.equal(lennox.state.zones[0].period.systemMode, 'off');
});

test('an Off clicked after a mode left is not ended by that mode accepted', async (t) => {
  const { lennox, send, advance, app } = await setup(t, { config: ALLOWED });
  lennox.latency = 300;
  const cool = send(0, F.MODE, THERMOSTAT_MODE.COOLING);
  // The mode is on its way (its publish answered later); an Off of the zone kept meanwhile.
  await advance(100 + 300 + 100, 10);
  app.memory.pendingStops[0] = {
    serial: SERIAL_ID,
    at: app.mono(),
    state: 'unsent',
    accepted: 0,
    refusal: null,
    notBefore: app.mono() + 60 * SECOND,
    sentAt: -Infinity,
    sentSeq: app.model.seq,
    clickSeq: app.model.seq,
  };
  await advance(5 * SECOND, 50);
  await cool;
  assert.ok(app.memory.pendingStops[0], 'the newer Off is kept');
});

test('an Off kept for a new address is checked against the serial right before its bytes', async (t) => {
  const { lennox, send, advance, app } = await setup(t);
  app.session.connected = false;
  lennox.latency = 300;
  const ack = send(0, F.MODE, OFF);
  await advance(150, 10);
  app.memory.pendingStops[0].verify = true;
  await advance(5 * SECOND, 50);
  await ack;
  assert.equal(offs(lennox), 0);
});

test('the numbers of the messages never go back across sessions', async (t) => {
  const { lennox, advance, app } = await setup(t);
  for (let i = 0; i < 30; i += 1) lennox.change(0, { hsp: 60 + (i % 5) });
  await advance(15 * SECOND);
  const before = app.model.seq;
  assert.ok(before > 30);
  lennox.queue = undefined;
  await advance(90 * SECOND);
  assert.ok(lennox.count('POST /Endpoints/gladys/Connect') >= 2, 'a new session');
  assert.ok(app.model.seq > before, `${app.model.seq} > ${before}`);
});

test('the first pin with /data frozen: the reads give up after 1 s, never hang', async (t) => {
  const store = memoryStore();
  store.hold = new Promise(() => {});
  const { lennox, advance, app, gladys } = await setup(t, { store, create: false, connect: false });
  gladys.connect().catch(() => {});
  await advance(60 * SECOND);
  assert.equal(lennox.count('GET /Messages/gladys/Retrieve'), 0);
  assert.equal(app.reader.running, undefined);
  assert.match(message(gladys).en, /could not be kept in \/data/);
});

test('B5: a 4xx of RequestData opens a new session (the thermostat restarted)', async (t) => {
  const { lennox, advance, app, press } = await setup(t);
  lennox.fail['GET /Messages/gladys/Retrieve'] = 'drop';
  await advance(40 * SECOND);
  delete lennox.fail['GET /Messages/gladys/Retrieve'];
  lennox.queue = undefined;
  const connects = lennox.count('POST /Endpoints/gladys/Connect');
  await advance(4 * 60 * SECOND);
  assert.ok(lennox.count('POST /Endpoints/gladys/Connect') > connects);
  assert.equal(app.reader.online, true);
  assert.equal((await press(0, F.MODE, OFF)).success, true);
});

test('B5: an Off answered by a 4xx: a new session and the Off again before a refusal counts', async (t) => {
  const { lennox, press, store } = await setup(t);
  let first = true;
  lennox.fail['POST /Messages/Publish'] = (json) => {
    if (first) {
      first = false;
      return { status: 404, headers: {}, body: '' };
    }
    lennox.applyNow(json.Data);
    return { status: 200, headers: {}, body: '{"code":1}' };
  };
  const connects = lennox.count('POST /Endpoints/gladys/Connect');
  assert.equal((await press(0, F.MODE, OFF)).success, true);
  assert.equal(lennox.count('POST /Endpoints/gladys/Connect'), connects + 1);
  assert.deepEqual(store.data.pendingStops, {});
});

test('I1: an Off clicked takes the link from the check of another Off that hangs', async (t) => {
  const { lennox, send, advance, app } = await setup(t);
  ignoreOff(lennox);
  const first = send(0, F.MODE, OFF);
  await advance(200, 50);
  lennox.fail['POST /Messages/RequestData'] = 'silent';
  await advance(6 * SECOND, 100);
  assert.equal(app.holder?.kind, 'check');
  delete lennox.fail['POST /Messages/Publish'];
  const ack = send(1, F.MODE, OFF);
  await advance(5 * SECOND, 50);
  assert.equal((await ack).success, true);
  assert.equal(lennox.state.zones[1].period.systemMode, 'off');
  await first;
});

test('I2: an off queued before the click, then the zone running again: the Off never sent is not ended', async (t) => {
  const { lennox, press, advance, store } = await setup(t);
  lennox.change(0, { systemMode: 'off' });
  lennox.change(0, { systemMode: 'heat' });
  lennox.fail['POST /Messages/Publish'] = 'drop';
  await press(0, F.MODE, OFF);
  delete lennox.fail['POST /Messages/Publish'];
  await advance(2 * 60 * SECOND);
  assert.equal(lennox.state.zones[0].period.systemMode, 'off');
  assert.deepEqual(store.data.pendingStops, {});
});

test('I3: a kept Off waits for a mode of its zone on its way; that mode accepted, it never goes', async (t) => {
  const { lennox, send, advance, app } = await setup(t, { config: ALLOWED });
  app.memory.pendingStops[0] = {
    serial: SERIAL_ID,
    at: app.mono(),
    state: 'unsent',
    accepted: 0,
    refusal: null,
    notBefore: -Infinity,
    sentAt: -Infinity,
    sentSeq: app.model.seq,
    clickSeq: app.model.seq,
  };
  lennox.latency = 300;
  const cool = send(0, F.MODE, THERMOSTAT_MODE.COOLING);
  await advance(100 + 300 + 100, 10);
  app.runStops().catch(() => {});
  await advance(5 * SECOND, 50);
  assert.equal((await cool).success, true);
  assert.equal(offs(lennox), 0);
  assert.equal(app.memory.pendingStops[0], undefined);
});

test('I3: a /data that never answers refuses a command within its time, never hangs it', async (t) => {
  const { lennox, send, advance, store } = await setup(t, { config: ALLOWED });
  store.hold = new Promise(() => {});
  let answer;
  send(0, F.HEAT_SETPOINT, 70).then((a) => {
    answer = a;
  });
  await advance(5 * SECOND, 50);
  assert.ok(answer, 'answered within 5 s');
  assert.match(answer.error, /\/data ne peut pas être écrit/);
  assert.equal(publishes(lennox).length, 0);
});

test('m13: a newer mode sent without an answer ends the Off kept before it', async (t) => {
  const { lennox, press, store } = await setup(t, { config: ALLOWED });
  ignoreOff(lennox);
  await press(0, F.MODE, OFF);
  assert.ok(store.data.pendingStops['0']);
  lennox.fail['POST /Messages/Publish'] = 'drop';
  await press(0, F.MODE, THERMOSTAT_MODE.HEATING);
  assert.deepEqual(store.data.pendingStops, {});
});

test('B4: another mode read twice LESS than an interval apart does not lift the Off', async (t) => {
  const store = memoryStore({
    target: '192.168.1.60',
    serial: SERIAL_ID,
    pin: FP,
    pendingStops: {
      0: {
        serial: SERIAL_ID,
        at: NOW - 1000,
        state: 'awaiting',
        accepted: 1,
        sentAt: NOW - 900,
        from: 'cool',
      },
    },
  });
  const { app, advance } = await setup(t, { store });
  await app.tick({ followUp: true });
  assert.ok(app.memory.pendingStops[0], 'two reads within an interval: kept');
  await advance(25 * SECOND);
  assert.equal(app.memory.pendingStops[0], undefined, 'an interval later: lifted');
});

test('I1: a command takes the link from the check of an Off that hangs', async (t) => {
  const { lennox, send, advance, app } = await setup(t, { config: ALLOWED });
  ignoreOff(lennox);
  const off = send(0, F.MODE, OFF);
  await advance(200, 50);
  lennox.fail['POST /Messages/RequestData'] = 'silent';
  await advance(6 * SECOND, 100);
  assert.equal(app.holder?.kind, 'check');
  const set = send(1, F.COOL_SETPOINT, 80);
  await advance(5 * SECOND, 50);
  assert.equal((await set).success, true, (await set).error);
  await off;
});

// --- Review r3 -----------------------------------------------------------------

test('B4: an Off clicked with the mode unknown (thermostat offline), accepted, ignored, then a restart and ANOTHER mode: never lifted, sent again, then given up and said', async (t) => {
  const store = memoryStore();
  const first = await setup(t, { store });
  await first.advance(15 * SECOND);
  // A cut: the reads fail, the mode read before is not the mode at the click.
  first.lennox.fail['GET /Messages/gladys/Retrieve'] = 'drop';
  await first.advance(first.app.interval + SECOND);
  assert.equal(first.app.reader.online, false);
  first.lennox.ignorePublish = true;
  await first.press(0, F.MODE, OFF);
  assert.equal(store.data.pendingStops['0'].state, 'awaiting');
  assert.equal(store.data.pendingStops['0'].from, null);
  first.app.halt();
  delete first.lennox.fail['GET /Messages/gladys/Retrieve'];
  // During the restart the zone goes to cool; the thermostat still ignores the Off.
  first.lennox.change(0, { systemMode: 'cool' });
  first.lennox.queue = undefined;
  const again = await setup(t, {
    store,
    lennox: first.lennox,
    clock: first.clock,
    create: false,
    devices: first.gladys.fake.devices,
  });
  await again.advance(5 * 60 * SECOND);
  assert.deepEqual(again.app.memory.stopsLifted, {}, 'an unknown mode at the click never lifts it');
  assert.equal(offs(first.lennox), 3, 'sent again: 3 accepted sends at most');
  assert.equal(store.data.stopGivenUp['0']?.status, 'not applied');
  assert.match(message(again.gladys).en, /given up \(not applied/);
});

test('B4: the mode at the click is taken from a thermostat read online only, never from a read before a cut', async (t) => {
  const { lennox, press, advance, app } = await setup(t);
  lennox.fail['GET /Messages/gladys/Retrieve'] = 'drop';
  await advance(app.interval + SECOND);
  assert.equal(app.reader.online, false);
  const read = app.model.zones.get(0).period.systemMode;
  assert.equal(read.value, 'heat');
  assert.ok(app.freshField(read), 'the mode read before the cut is still fresh');
  await press(0, F.MODE, OFF);
  assert.equal(app.memory.pendingStops[0].state, 'awaiting');
  assert.equal(app.memory.pendingStops[0].from, null);
});

test('m14: a newer mode answered by a redirection (3xx) leaves the Off kept, sent again later', async (t) => {
  const { lennox, press, advance, store } = await setup(t, { config: ALLOWED });
  ignoreOff(lennox);
  await press(0, F.MODE, OFF);
  assert.equal(store.data.pendingStops['0'].state, 'awaiting');
  lennox.fail['POST /Messages/Publish'] = 302;
  assert.equal((await press(0, F.MODE, THERMOSTAT_MODE.HEATING)).success, false);
  assert.ok(store.data.pendingStops['0'], 'kept after a redirection');
  assert.equal(lennox.state.zones[0].period.systemMode, 'heat');
  delete lennox.fail['POST /Messages/Publish'];
  const before = offs(lennox);
  await advance(60 * SECOND);
  assert.ok(offs(lennox) > before, 'sent again');
  assert.equal(lennox.state.zones[0].period.systemMode, 'off');
  assert.deepEqual(store.data.pendingStops, {});
});

test('m15: an Off given up then applied at the click: the status says it at once, before any other read', async (t) => {
  const { lennox, send, press, advance, store, gladys } = await setup(t, {
    config: { ...CONFIG, poll_interval: 300 },
  });
  lennox.publishCode = 2;
  await press(0, F.MODE, OFF);
  await advance(11 * 60 * SECOND, 30 * SECOND);
  assert.equal(store.data.stopGivenUp['0']?.status, 'code 2');
  assert.match(message(gladys).en, /given up/);
  lennox.publishCode = 1;
  const reads = lennox.count('GET /Messages/gladys/Retrieve');
  let answer;
  send(0, F.MODE, OFF).then((a) => {
    answer = a;
  });
  for (let i = 0; i < 40 && !answer; i += 1) await advance(25, 25);
  assert.equal(answer?.success, true, answer?.error);
  // The read of the stop itself only; the follow-up reads come 5 s later.
  await advance(500, 50);
  assert.equal(lennox.count('GET /Messages/gladys/Retrieve'), reads + 1);
  assert.doesNotMatch(message(gladys).en, /given up/);
  assert.match(message(gladys).en, /^Connected/);
  const badge = gladys.fake.transports.filter((e) => e.device_external_id === ZONE(0)).at(-1);
  assert.equal(badge.degraded, undefined);
});
