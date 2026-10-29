// -----------------------------------------------------------------------------
// The real clock, sped up 20 times, the real transport and a real HTTPS
// thermostat on the loopback: the reads come at the interval (never sooner,
// never one late), and an Off goes at once through the same pinned
// certificate.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { LennoxApp } from '../src/app.js';
import { memoryStore } from '../src/store.js';
import { httpsServer, measurePeriod, realClock, reply, spyOn } from './kit/index.mjs';
import { initialState } from './helpers/fakeLennox.js';

test('real clock x20: one read per interval, measured; Off at once', async (t) => {
  const state = initialState();
  let queue = [];
  const zone = state.zones[0];
  const srv = await httpsServer({
    routes: {
      'POST /Endpoints/gladys/Connect': () => {
        queue = [];
        return reply(200, 'Success');
      },
      'POST /Messages/RequestData': () => {
        queue.push({
          SenderID: 'LCC',
          Data: {
            system: { config: { name: 'House', temperatureUnit: 'F' } },
            occupancy: { manualAway: false },
            zones: [
              {
                id: 0,
                config: { name: zone.name, scheduleId: 16 },
                status: { temperature: 70, temperatureStatus: 'good', period: { ...zone.period } },
              },
            ],
            devices: [
              {
                device: {
                  deviceType: 500,
                  features: [{ feature: { fid: 9, values: [{ value: state.serial }] } }],
                },
              },
            ],
          },
        });
        return reply(200, 'Success');
      },
      'GET /Messages/gladys/Retrieve': () =>
        queue.length === 0 ? reply(204, '') : { messages: queue.splice(0, 10) },
      'POST /Messages/Publish': (r) => {
        const period = r.json.Data.schedules[0].schedule.periods[0].period;
        Object.assign(zone.period, period);
        queue.push({
          SenderID: 'LCC',
          Data: { schedules: [{ id: 16, schedule: { periods: [{ id: 0, period }] } }] },
        });
        return { code: 1 };
      },
    },
  });
  const clock = realClock({ speed: 20 });
  const gladys = createFakeGladys({ config: { host: `127.0.0.1:${srv.port}`, poll_interval: 30 } });
  const app = new LennoxApp({
    gladys,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    now: clock.now,
    monotonic: clock.monotonic,
    timers: clock.timers,
    store: memoryStore(),
  });
  t.after(async () => {
    app.halt();
    clock.close();
    await srv.close();
  });
  const spy = spyOn(app, 'markRead', clock);
  await app.connected(gladys.fake.config);
  const gaps = await measurePeriod(spy, { count: 4, period: 30_000 });
  assert.equal(gaps.length, 3);
  assert.equal(srv.count('POST /Endpoints/gladys/Connect'), 1);
  const device = gladys.fake.discoveredDevices.find((d) => d.external_id.endsWith('-zone0'));
  const mode = device.features.find((f) => f.external_id.endsWith(':mode'));
  await app.setValue(device, mode, 0);
  assert.equal(zone.period.systemMode, 'off');
});
