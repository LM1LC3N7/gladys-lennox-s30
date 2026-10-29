// -----------------------------------------------------------------------------
// What must survive a restart, in /data (the only writable place of the
// container):
//   - the address read last, the serial number of the thermostat there (not
//     a secret: the id of its devices) and the SHA-256 fingerprint of its
//     certificate (the pin: public), plus the one last refused, for "Trust
//     the new certificate"; so that a stop kept goes after a restart before
//     any configuration or read;
//   - the end of a pause (429, 5xx), the time of the last read (written at
//     most once a minute): a restart never asks sooner;
//   - the stops not applied yet (sent again after a restart; they follow the
//     thermostat to a new address), those given up (said until a read shows
//     the zone off or a click), the guards of the commands sent and not seen
//     yet.
// The local API takes no credential: there is no secret to keep. The file is
// readable by the container user only (0600).
//
// Clocks: in memory every date is MONOTONIC, but a monotonic instant belongs
// to its process, so /data holds wall dates: `toDisk` turns them into wall
// dates with the offset of now, `fromDisk` back into monotonic dates of this
// process, bounded (a date "in the future" after a wall clock set back is
// never a longer wait than its maximum; a stop clicked "in the future" is
// invalid).
// -----------------------------------------------------------------------------

import { readFile, rename, writeFile } from 'node:fs/promises';
import { normalizeFingerprint } from './lennox/http.js';
import { FAN_MODES, SYSTEM_MODES, TIMINGS, ZONES } from './constants.js';

export const STATE_FILE = '/data/lennox-s30-state.json';

export function fileStore(path = STATE_FILE) {
  // One write at a time: two saves never share the temporary file.
  let chain = Promise.resolve();
  return {
    async load() {
      const text = await readFile(path, 'utf8').catch((err) => {
        if (err?.code === 'ENOENT') return null;
        throw err;
      });
      if (text === null) return null;
      if (text.length > 256 * 1024) throw new Error('state file too large');
      return JSON.parse(text);
    },
    save(data) {
      const text = JSON.stringify(data);
      const write = chain.then(async () => {
        const temporary = `${path}.tmp`;
        await writeFile(temporary, text, { mode: 0o600 });
        await rename(temporary, path);
      });
      chain = write.catch(() => {});
      return write;
    },
  };
}

/** For the tests: the same JSON round trip as the file. */
export function memoryStore(initial = null) {
  return {
    data: initial === null ? null : JSON.parse(JSON.stringify(initial)),
    saves: 0,
    failSave: false,
    failLoad: false,
    /** A promise the next saves wait for (a slow /data). */
    hold: undefined,
    async load() {
      if (this.failLoad) throw new Error('EIO');
      return this.data === null ? null : JSON.parse(JSON.stringify(this.data));
    },
    async save(data) {
      if (this.hold) await this.hold;
      if (this.failSave) throw Object.assign(new Error('read-only'), { code: 'EROFS' });
      this.data = JSON.parse(JSON.stringify(data));
      this.saves += 1;
    },
  };
}

const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const SERIAL = /^[a-z0-9]{4,32}$/;
const TARGET = /^[a-z0-9.-]{1,253}(?::\d{1,5})?$/;
const zoneKey = (z) => /^[0-9]$/.test(z) && Number(z) < ZONES.max;
const count = (v, max) => (Number.isInteger(v) && v >= 0 ? Math.min(v, max) : 0);
const statusText = (v) => (typeof v === 'string' && /^[A-Za-z0-9 ]{1,20}$/.test(v) ? v : undefined);

/** The empty state (monotonic dates). */
export const emptyMemory = () => ({
  target: null,
  serial: null,
  pin: null,
  refusedPin: null,
  pause: null,
  lastReadAt: -Infinity,
  /** zone -> { serial, at, state: 'unsent' | 'awaiting', accepted, refusal, notBefore, sentAt, sentSeq, clickSeq } */
  pendingStops: {},
  /** zone -> { serial, status } */
  stopGivenUp: {},
  /** zone -> true: a stop dropped because another thermostat answers (said until a click; memory only). */
  stopsDropped: {},
  /** zone -> true: a stop accepted before a restart, lifted for a change at the thermostat (said until a click; memory only). */
  stopsLifted: {},
  /** zone -> { expect, until, sentSeq } */
  guards: {},
});

/** The state as /data keeps it (`clock`: `{ mono, now }` read once). -Infinity is null. */
export function toDisk(memory, { mono, now }) {
  const wall = (m) => (finite(m) ? Math.round(now + (m - mono)) : null);
  const map = (obj, fn) => Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, fn(v)]));
  return {
    target: memory.target,
    serial: memory.serial,
    pin: memory.pin,
    refusedPin: memory.refusedPin,
    pause: memory.pause ? { until: wall(memory.pause.until), reason: memory.pause.reason } : null,
    lastReadAt: wall(memory.lastReadAt),
    pendingStops: map(memory.pendingStops, (p) => ({
      serial: p.serial,
      at: wall(p.at),
      state: p.state,
      accepted: p.accepted,
      refusal: p.refusal,
      notBefore: wall(p.notBefore),
      sentAt: wall(p.sentAt),
      ...(p.verify ? { verify: true } : {}),
      from: p.from ?? null,
    })),
    stopGivenUp: Object.fromEntries(
      Object.entries(memory.stopGivenUp).map(([z, g]) => [
        z,
        { serial: g.serial, status: g.status },
      ]),
    ),
    guards: map(memory.guards, (g) => ({ expect: g.expect, until: wall(g.until) })),
  };
}

const EXPECT = {
  systemMode: (v) => Object.values(SYSTEM_MODES).includes(v),
  fanMode: (v) => FAN_MODES.includes(v),
  hsp: finite,
  hspC: finite,
  csp: finite,
  cspC: finite,
};

/** The state read from /data, repaired, bounded and turned into monotonic dates of this process. */
export function fromDisk(raw, { mono, now }) {
  const data = plain(raw) ? raw : {};
  const memory = emptyMemory();
  const ahead = (w, max) => (finite(w) ? mono + Math.min(w - now, max) : -Infinity);
  const past = (w) => ahead(w, 0);
  const target = typeof data.target === 'string' && TARGET.test(data.target) ? data.target : null;
  memory.target = target;
  if (!target) {
    return memory;
  }
  memory.serial = typeof data.serial === 'string' && SERIAL.test(data.serial) ? data.serial : null;
  memory.pin = normalizeFingerprint(data.pin) ?? null;
  memory.refusedPin = normalizeFingerprint(data.refusedPin) ?? null;
  memory.lastReadAt = past(data.lastReadAt);
  const pause = plain(data.pause) ? data.pause : {};
  if (finite(pause.until) && pause.until > now) {
    memory.pause = {
      until: ahead(pause.until, TIMINGS.rateLimitMax),
      reason: pause.reason === '429' ? '429' : '5xx',
    };
  }
  // A stop is never dropped for its age; one clicked "in the future" (a wall
  // clock set back) is not valid. Sequence numbers belong to their process:
  // every read after a restart is after the click.
  for (const [z, p] of Object.entries(plain(data.pendingStops) ? data.pendingStops : {})) {
    if (!zoneKey(z) || !plain(p) || typeof p.serial !== 'string' || !SERIAL.test(p.serial))
      continue;
    if (!finite(p.at) || p.at > now) continue;
    memory.pendingStops[z] = {
      serial: p.serial,
      at: past(p.at),
      state: p.state === 'awaiting' ? 'awaiting' : 'unsent',
      accepted: count(p.accepted, TIMINGS.stopRefusalsMax),
      refusal:
        plain(p.refusal) && statusText(p.refusal.status)
          ? { status: p.refusal.status, count: count(p.refusal.count, TIMINGS.stopRefusalsMax) }
          : null,
      // A restart sends it at once, unless the thermostat refused it (its wait holds).
      notBefore: plain(p.refusal) ? ahead(p.notBefore, TIMINGS.pendingStopWaitMax) : -Infinity,
      sentAt: past(p.sentAt),
      sentSeq: 0,
      clickSeq: 0,
      // Accepted before the restart: what the thermostat showed since is unknown.
      ...(p.state === 'awaiting' ? { restored: true } : {}),
      // Kept from another address: sent once the address shows its serial.
      ...(p.verify === true ? { verify: true } : {}),
      /** The mode of the zone at the click (null: unknown, never "changed elsewhere"). */
      from: [
        SYSTEM_MODES.HEAT,
        SYSTEM_MODES.COOL,
        SYSTEM_MODES.AUTO,
        SYSTEM_MODES.EMERGENCY,
      ].includes(p.from)
        ? p.from
        : null,
    };
  }
  for (const [z, g] of Object.entries(plain(data.stopGivenUp) ? data.stopGivenUp : {})) {
    if (zoneKey(z) && plain(g) && typeof g.serial === 'string' && SERIAL.test(g.serial)) {
      memory.stopGivenUp[z] = { serial: g.serial, status: statusText(g.status) ?? 'refused' };
    }
  }
  for (const [z, g] of Object.entries(plain(data.guards) ? data.guards : {})) {
    if (!zoneKey(z) || !plain(g) || !plain(g.expect) || !finite(g.until) || g.until <= now)
      continue;
    const expect = Object.fromEntries(
      Object.entries(g.expect).filter(([k, v]) => Object.hasOwn(EXPECT, k) && EXPECT[k](v)),
    );
    if (Object.keys(expect).length === 0) continue;
    memory.guards[z] = { expect, until: ahead(g.until, TIMINGS.guard), sentSeq: 0 };
  }
  return memory;
}
