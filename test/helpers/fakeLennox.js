// -----------------------------------------------------------------------------
// A fake Lennox S30 behind the injected `exchange` (no network): its message
// queue (Connect, RequestData, Retrieve), its changes (Publish), shaped as the
// fixtures and the simulator of lennoxs30api (MIT, tests/messages,
// simulator/main.py), and failures on demand. Delays run on the injected
// timers (the test clock).
//
// As lennoxs30api describes it: in manual mode a change reaches the manual
// schedule only (a `schedules` message), otherwise the period of the zone.
// -----------------------------------------------------------------------------

import { LennoxError, ERROR_KINDS } from '../../src/lennox/http.js';

export const HOST = '192.168.1.60';
export const SERIAL = 'HD20H10111';
export const SERIAL_ID = SERIAL.toLowerCase();
export const FP = Array.from({ length: 32 }, (_, i) => (i + 16).toString(16).toUpperCase()).join(
  ':',
);
export const OTHER_FP = Array.from({ length: 32 }, (_, i) =>
  (i + 100).toString(16).toUpperCase(),
).join(':');
export const NOW = Date.UTC(2026, 9, 28, 10, 0, 0);

const answer = (status, body = '', headers = {}) => ({
  status,
  headers: { 'content-type': 'application/json', ...headers },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

const zone = (id, name, period) => ({
  id,
  name,
  scheduleId: 16 + id,
  hold: { enabled: false, scheduleId: 32 + id },
  temperature: 68.875,
  temperatureC: 20.5,
  temperatureStatus: 'good',
  humidity: 45,
  humidityStatus: 'good',
  tempOperation: 'heating',
  fan: false,
  config: {
    heatingOption: true,
    coolingOption: true,
    emergencyHeatingOption: false,
    minHsp: 40,
    maxHsp: 90,
    minHspC: 4.5,
    maxHspC: 32,
    minCsp: 60,
    maxCsp: 99,
    minCspC: 15.5,
    maxCspC: 37,
    temperatureDeadband: 3,
    temperatureDeadbandC: 1.5,
  },
  period: {
    systemMode: 'heat',
    fanMode: 'auto',
    humidityMode: 'off',
    hsp: 68,
    hspC: 20,
    csp: 77,
    cspC: 25,
    sp: 73,
    spC: 22.5,
    husp: 40,
    desp: 50,
    startTime: 0,
    ...period,
  },
});

/** A thermostat of two zones (°F), as read from its queue. */
export function initialState() {
  return {
    serial: SERIAL,
    unit: 'F',
    name: 'House',
    zoningMode: 'zoned',
    numberOfZones: 2,
    outdoor: 41,
    outdoorC: 5,
    alert: 'none',
    alerts: [],
    manualAway: false,
    zones: [zone(0, 'Main Floor'), zone(1, 'Upstairs', { systemMode: 'cool' })],
    schedules: {},
  };
}

export function fakeLennox({ timers, state = initialState() } = {}) {
  const fake = {
    state,
    fingerprint: FP,
    /** Every request, in order: { route, body, json, at }. */
    requests: [],
    connections: [],
    queue: undefined,
    latency: 0,
    /** Routes that fail: route -> 'unreachable' | 'silent' | 'drop' | status number | (r) => answer. */
    fail: {},
    /** Publish answered but never applied. */
    ignorePublish: false,
    publishCode: 1,
    /** A change applied this long after its answer. */
    applyDelay: 0,
    routes() {
      return this.requests.map((r) => r.route);
    },
    count(route) {
      return this.requests.filter((r) => r.route === route).length;
    },
    push(data) {
      this.queue?.push({
        MessageId: 0,
        SenderID: 'LCC',
        TargetID: 'gladys',
        MessageType: 'PropertyChange',
        Data: data,
      });
    },
    snapshot() {
      return [
        { system: systemData(this.state) },
        { zones: this.state.zones.map(zoneData) },
        { schedules: schedulesData(this.state) },
        {
          occupancy: {
            manualAway: this.state.manualAway,
            smartAway: { config: { enabled: false } },
          },
        },
        { alerts: alertsData(this.state) },
        { devices: devicesData(this.state) },
      ];
    },
    /** A change of a zone made elsewhere (the thermostat, the Lennox app). */
    change(id, period) {
      const z = this.state.zones.find((x) => x.id === id);
      Object.assign(z.period, period);
      // The schedule the zone follows changes with it (a change at the thermostat).
      if (this.state.schedules[z.scheduleId])
        Object.assign(this.state.schedules[z.scheduleId], period);
      this.push(
        z.scheduleId === 16 + id
          ? { schedules: [{ id: 16 + id, schedule: { periods: [{ id: 0, period }] } }] }
          : { zones: [{ id, status: { period } }] },
      );
    },
    /** Applies a change at once (for a test answering Publish itself). */
    applyNow(data) {
      apply(this, data);
    },
    exchange: (opts) => handle(fake, opts, timers),
  };
  return fake;
}

const systemData = (s) => ({
  config: {
    name: s.name,
    temperatureUnit: s.unit,
    centralMode: false,
    options: { productType: 'S30' },
  },
  status: {
    outdoorTemperature: s.outdoor,
    outdoorTemperatureC: s.outdoorC,
    outdoorTemperatureStatus: 'good',
    alert: s.alert,
    zoningMode: s.zoningMode,
    numberOfZones: s.numberOfZones,
    singleSetpointMode: s.single ?? false,
  },
});

const zoneData = (z) => ({
  id: z.id,
  config: {
    name: z.name,
    scheduleId: z.scheduleId,
    scheduleHold: { enabled: z.hold.enabled, scheduleId: z.hold.scheduleId, exceptionType: 'hold' },
    ...z.config,
  },
  status: {
    temperature: z.temperature,
    temperatureC: z.temperatureC,
    temperatureStatus: z.temperatureStatus,
    humidity: z.humidity,
    humidityStatus: z.humidityStatus,
    tempOperation: z.tempOperation,
    fan: z.fan,
    period: { ...z.period },
  },
});

const schedulesData = (s) =>
  s.zones.flatMap((z) => [
    {
      id: 16 + z.id,
      schedule: {
        name: `manual zone ${z.id}`,
        periods: [{ id: 0, period: { ...(s.schedules[16 + z.id] ?? z.period) } }],
      },
    },
  ]);

const alertsData = (s) => ({
  active: s.alerts.map((a, id) => ({
    id,
    alert: { code: a.code, priority: a.priority, isStillActive: true },
  })),
  meta: { numActiveAlerts: s.alerts.length, numAlertsInActiveArray: s.alerts.length },
});

const devicesData = (s) => [
  {
    id: 0,
    device: {
      deviceType: 500,
      features: [
        { id: 0, feature: { fid: 8, values: [{ id: 0, value: '106151-01' }] } },
        { id: 1, feature: { fid: 9, values: [{ id: 0, value: s.serial }] } },
        { id: 3, feature: { fid: 11, values: [{ id: 0, value: '3.81.213' }] } },
      ],
    },
  },
];

/** Applies a Publish as the thermostat would. */
function apply(fake, data) {
  const s = fake.state;
  for (const sched of data.schedules ?? []) {
    const period = sched.schedule.periods[0].period;
    const z = s.zones.find(
      (x) => x.scheduleId === sched.id || 16 + x.id === sched.id || 32 + x.id === sched.id,
    );
    s.schedules[sched.id] = { ...(s.schedules[sched.id] ?? z?.period ?? {}), ...period };
    if (z && z.scheduleId === sched.id) {
      Object.assign(z.period, period);
      fake.push(
        sched.id === 16 + z.id
          ? { schedules: [{ id: sched.id, schedule: { periods: [{ id: 0, period }] } }] }
          : { zones: [{ id: z.id, status: { period } }] },
      );
    }
  }
  for (const zc of data.zones ?? []) {
    const z = s.zones.find((x) => x.id === zc.id);
    if (!z) continue;
    if (zc.config.scheduleId !== undefined) {
      z.scheduleId = zc.config.scheduleId;
      Object.assign(z.period, s.schedules[z.scheduleId] ?? {});
      fake.push({
        zones: [
          { id: z.id, config: { scheduleId: z.scheduleId }, status: { period: { ...z.period } } },
        ],
      });
    }
    if (zc.config.scheduleHold) {
      z.hold = { enabled: true, scheduleId: zc.config.scheduleHold.scheduleId };
      z.scheduleId = zc.config.scheduleHold.scheduleId;
      Object.assign(z.period, s.schedules[z.scheduleId] ?? {});
      fake.push({
        zones: [
          {
            id: z.id,
            config: {
              scheduleId: z.scheduleId,
              scheduleHold: { enabled: true, scheduleId: z.scheduleId },
            },
            status: { period: { ...z.period } },
          },
        ],
      });
    }
  }
}

function route(fake, method, path) {
  const bare = path.split('?')[0];
  return `${method} ${bare}`;
}

async function handle(fake, opts, timers) {
  const { method, path, body, trust, beforeSend, onOpen, timeoutMs } = opts;
  const r = route(fake, method, path);
  const connection = {
    closed: false,
    fingerprintChecked: false,
    close() {
      this.closed = true;
      this.onClose?.();
    },
  };
  fake.connections.push(connection);
  onOpen?.(connection);
  const failure = typeof fake.fail[r] === 'function' ? undefined : fake.fail[r];
  const wait = (ms) =>
    new Promise((resolve, reject) => {
      const t = timers.setTimeout(resolve, ms);
      connection.onClose = () => {
        timers.clearTimeout(t);
        reject(
          new LennoxError(ERROR_KINDS.ABORTED, 'Session given up', { notSent: !connection.sent }),
        );
      };
    });
  if (connection.closed) {
    throw new LennoxError(ERROR_KINDS.ABORTED, 'Session given up', { notSent: true });
  }
  if (failure === 'unreachable-once') {
    delete fake.fail[r];
    throw new LennoxError(ERROR_KINDS.UNREACHABLE, 'Unreachable: ECONNREFUSED');
  }
  if (failure === 'unreachable') {
    if (fake.latency) await wait(fake.latency);
    throw new LennoxError(ERROR_KINDS.UNREACHABLE, 'Unreachable: ECONNREFUSED');
  }
  await trust(fake.fingerprint);
  connection.fingerprintChecked = true;
  if (connection.closed)
    throw new LennoxError(ERROR_KINDS.ABORTED, 'Session given up', { notSent: true });
  try {
    beforeSend?.();
  } catch (err) {
    throw Object.assign(err, { notSent: true, beforeSend: true });
  }
  connection.sent = true;
  const json = body === undefined ? undefined : JSON.parse(body);
  fake.requests.push({ route: r, body, json, path });
  if (failure === 'silent') {
    await wait(timeoutMs);
    throw new LennoxError(ERROR_KINDS.TIMEOUT, 'Connected but silent: timeout');
  }
  if (failure === 'drop') {
    throw new LennoxError(ERROR_KINDS.TIMEOUT, 'Connection lost');
  }
  if (fake.latency) {
    if (fake.latency >= timeoutMs) {
      await wait(timeoutMs);
      throw new LennoxError(ERROR_KINDS.TIMEOUT, 'Connected but silent: timeout');
    }
    await wait(fake.latency);
  }
  if (typeof failure === 'number') {
    return answer(failure, '');
  }
  if (typeof fake.fail[r] === 'function') {
    return fake.fail[r](json);
  }
  switch (r) {
    case 'POST /Endpoints/gladys/Connect':
      fake.queue = [];
      return answer(200, 'Success');
    case 'POST /Messages/RequestData':
      if (!fake.queue) return answer(404, '');
      for (const data of fake.snapshot()) fake.push(data);
      return answer(200, 'Success');
    case 'GET /Messages/gladys/Retrieve': {
      if (!fake.queue) return answer(404, '');
      if (fake.queue.length === 0) return answer(204, '');
      return answer(200, { messages: fake.queue.splice(0, 10) });
    }
    case 'POST /Messages/Publish': {
      if (fake.publishCode !== 1)
        return answer(200, { code: fake.publishCode, message: 'refused' });
      if (!fake.ignorePublish) {
        if (fake.applyDelay > 0) timers.setTimeout(() => apply(fake, json.Data), fake.applyDelay);
        else apply(fake, json.Data);
      }
      return answer(200, { code: 1, message: '', retry_after: 0 });
    }
    default:
      return answer(404, '');
  }
}
