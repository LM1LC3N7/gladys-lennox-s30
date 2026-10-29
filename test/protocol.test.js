// -----------------------------------------------------------------------------
// The model built from real messages of a Lennox S30 (fixtures of
// lennoxs30api, MIT, tests/messages): system, zones, alerts, identity; a
// sibling dropped; values of the wrong type unknown.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  applyMessage,
  awayOf,
  dataOf,
  emptyModel,
  holdPart,
  manualPart,
  periodPart,
  requestDataBody,
  valueOf,
  zonesOf,
} from '../src/lennox/protocol.js';

const fixture = (name) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));

function model() {
  const m = emptyModel();
  for (const name of [
    'system_04_furn_ac_zoning_config',
    'system_04_furn_ac_zoning_zones',
    'system_04_furn_ac_zoning_alerts',
    'device_response_lcc',
  ]) {
    applyMessage(m, { ...fixture(name), SenderID: 'LCC' }, 1);
  }
  return m;
}

test('a real thermostat: identity, unit, zones in use, periods, alerts', () => {
  const m = model();
  assert.equal(valueOf(m.system.serial), 'hd21212121');
  assert.equal(valueOf(m.system.unit), 'C');
  assert.equal(valueOf(m.system.alert), 'critical');
  // numberOfZones 3: the fourth zone is not in use.
  assert.deepEqual(
    zonesOf(m).map((z) => valueOf(z.config.name)),
    ['Main Floor', 'Upper Floor', 'Basement'],
  );
  const main = m.zones.get(0);
  assert.equal(valueOf(main.status.temperature), 68.875);
  assert.equal(valueOf(main.period.systemMode), 'heat and cool');
  assert.equal(valueOf(main.config.maxHsp), 86);
  // Only active alerts with a code; the cleared one (isStillActive false) is not listed.
  assert.deepEqual(
    valueOf(m.system.alerts).map((a) => a.code),
    [434, 19],
  );
  assert.equal(valueOf(m.system.alerts)[1].text, 'High Ambient Auxiliary Heat Lockout');
  assert.equal(valueOf(m.system.alertCount), 2);
});

test('a change of the manual schedule reaches the zone that follows it, not the others', () => {
  const m = model();
  applyMessage(m, { ...fixture('mut_sys1_zone1_cool_sched'), SenderId: 'LCC' }, 2);
  assert.equal(valueOf(m.zones.get(0).period.systemMode), 'cool');
  assert.equal(valueOf(m.schedules.get(16).systemMode), 'cool');
  m.zones.get(1).config.scheduleId.value = 3;
  applyMessage(
    m,
    { SenderID: 'LCC', Data: { schedules: [periodPart(17, { systemMode: 'off' })] } },
    3,
  );
  assert.equal(valueOf(m.zones.get(1).period.systemMode), 'heat and cool');
});

test('a sibling is dropped; wrong types are unknown, never a number', () => {
  const m = model();
  const seq = m.seq;
  assert.equal(
    applyMessage(
      m,
      { SenderID: 'KL21J00002', Data: { zones: [{ id: 0, status: { temperature: 1 } }] } },
      2,
    ),
    false,
  );
  assert.equal(m.seq, seq);
  applyMessage(
    m,
    {
      SenderID: 'LCC',
      Data: {
        zones: [
          {
            id: 0,
            status: { temperature: '', humidity: '50', period: { hsp: null, systemMode: 'turbo' } },
          },
          { id: 9, status: { temperature: 70 } },
          { id: '1', status: { temperature: 70 } },
          { id: 1, config: { name: 'x\u0000y'.repeat(40) } },
        ],
        __proto__: { polluted: true },
      },
    },
    3,
  );
  assert.equal(valueOf(m.zones.get(0).status.temperature), 68.875);
  assert.equal(valueOf(m.zones.get(0).status.humidity), 50);
  assert.equal(valueOf(m.zones.get(0).period.systemMode), 'heat and cool');
  assert.ok(!m.zones.has(9));
  assert.equal(valueOf(m.zones.get(1).config.name).length, 60);
  assert.ok(!valueOf(m.zones.get(1).config.name).includes('\u0000'));
  assert.equal({}.polluted, undefined);
});

test('away: unknown until read; manual or smart away in force', () => {
  const m = emptyModel();
  assert.equal(awayOf(m), undefined);
  applyMessage(m, { SenderID: 'LCC', Data: { occupancy: { manualAway: false } } }, 1);
  assert.equal(awayOf(m), false);
  applyMessage(
    m,
    {
      SenderID: 'LCC',
      Data: {
        occupancy: { smartAway: { config: { enabled: true }, status: { setpointState: 'away' } } },
      },
    },
    2,
  );
  assert.equal(awayOf(m), true);
});

test('the bodies: our application id, never the one of the Lennox app', () => {
  const body = JSON.parse(requestDataBody('id-1'));
  assert.equal(body.SenderID, 'gladys');
  assert.match(body.AdditionalParameters.JSONPath, /^1;\/system;\/zones/);
  assert.deepEqual(dataOf({ schedules: [], zones: [manualPart(1)] }), {
    zones: [{ id: 1, config: { scheduleId: 17 } }],
  });
  assert.equal(dataOf({}), undefined);
  assert.equal(holdPart(2).config.scheduleHold.scheduleId, 34);
});
