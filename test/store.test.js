// -----------------------------------------------------------------------------
// /data: wall dates on disk, monotonic in memory, repaired and bounded; a stop
// clicked in the future is invalid, never dropped for its age; the file store
// writes 0600 in a temporary dir removed after.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emptyMemory, fileStore, fromDisk, toDisk } from '../src/store.js';
import { HOUR, TIMINGS } from '../src/constants.js';

const NOW = Date.UTC(2026, 9, 28, 10);
const clock = { mono: 1_000, now: NOW };

test('a round trip keeps the stops, the guards and the pin; dates turn monotonic', () => {
  const memory = {
    ...emptyMemory(),
    target: '192.168.1.60',
    serial: 'hd20h10111',
    pin: 'AA:'.repeat(31) + 'AA',
    pendingStops: {
      0: {
        serial: 'hd20h10111',
        at: 500,
        state: 'awaiting',
        accepted: 1,
        refusal: null,
        notBefore: -Infinity,
        sentAt: 600,
        sentSeq: 9,
        clickSeq: 3,
      },
    },
    guards: { 1: { expect: { hsp: 70, hspC: 21 }, until: 50_000, sentSeq: 4 } },
  };
  const disk = toDisk(memory, clock);
  assert.equal(disk.pendingStops['0'].at, NOW - 500);
  const back = fromDisk(JSON.parse(JSON.stringify(disk)), { mono: 10, now: NOW + 5 * HOUR });
  assert.equal(back.pendingStops['0'].state, 'awaiting');
  assert.equal(back.pendingStops['0'].sentSeq, 0);
  assert.equal(back.pin, memory.pin);
  // A guard over by now is gone; a stop never goes for its age.
  assert.deepEqual(back.guards, {});
  assert.ok(back.pendingStops['0'].at < 10);
});

test('a stop clicked in the future, a bad serial or zone, a pause too long: repaired', () => {
  const back = fromDisk(
    {
      target: '192.168.1.60',
      pendingStops: {
        0: { serial: 'hd20h10111', at: NOW + HOUR, state: 'unsent' },
        1: { serial: '../x', at: NOW - 1 },
        7: { serial: 'hd20h10111', at: NOW - 1 },
        2: {
          serial: 'hd20h10111',
          at: NOW - 1,
          refusal: { status: 'code 2', count: 99 },
          notBefore: NOW + 99 * HOUR,
        },
      },
      pause: { until: NOW + 99 * HOUR, reason: '429' },
      guards: { 0: { expect: { systemMode: 'turbo' }, until: NOW + 10_000 } },
    },
    clock,
  );
  assert.deepEqual(Object.keys(back.pendingStops), ['2']);
  assert.equal(back.pendingStops['2'].refusal.count, TIMINGS.stopRefusalsMax);
  assert.ok(back.pendingStops['2'].notBefore <= clock.mono + TIMINGS.pendingStopWaitMax);
  assert.ok(back.pause.until <= clock.mono + TIMINGS.rateLimitMax);
  assert.deepEqual(back.guards, {});
  assert.deepEqual(fromDisk('garbage', clock), emptyMemory());
});

test('the file store: 0600, a corrupt or huge file is an error (never empty)', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'lennox-store-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'state.json');
  const store = fileStore(path);
  assert.equal(await store.load(), null);
  await store.save({ target: 'x' });
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.deepEqual(await store.load(), { target: 'x' });
  await writeFile(path, '{');
  await assert.rejects(store.load());
  await writeFile(path, ' '.repeat(300 * 1024));
  await assert.rejects(store.load(), /too large/);
});
