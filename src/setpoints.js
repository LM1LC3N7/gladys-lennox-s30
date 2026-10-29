// -----------------------------------------------------------------------------
// Setpoints (pure): the thermostat takes each setpoint twice, in whole °F
// (`hsp`, `csp`) and in half °C (`hspC`, `cspC`); lennoxs30api always sends
// both. A value asked in one unit is rounded to the step of that unit, the
// other one is converted EXACTLY from it then rounded to its own step, and
// BOTH are checked against the limits of the zone (read from the thermostat)
// and against ours (SETPOINT_BOUNDS): never a value outside either. The top of
// a range is rounded down, its bottom up.
//
// The heat setpoint stays below the cool setpoint by the deadband of the zone
// (3 °F / 1.5 °C by default). When a new setpoint would break it, the other
// setpoint moves out of the way, as the Lennox app does: the cool setpoint up
// (less cooling), the heat setpoint down (less heating), never the other way,
// and only within its own limits (otherwise the command is refused).
// -----------------------------------------------------------------------------

import { DEADBAND, SETPOINT_BOUNDS } from './constants.js';

export const toC = (f) => ((f - 32) * 5) / 9;
export const toF = (c) => (c * 9) / 5 + 32;
export const halfC = (c) => Math.round(c * 2) / 2;
export const wholeF = (f) => Math.round(f);
const EPS = 1e-9;

/** The value pair written for a setpoint asked in `unit` ('C' / 'F'). */
export function pairOf(asked, unit) {
  if (unit === 'C') {
    const C = halfC(asked);
    return { C, F: wholeF(toF(C)) };
  }
  const F = wholeF(asked);
  return { F, C: halfC(toC(F)) };
}

const v = (field) => field?.value;

/**
 * The limits of a setpoint of a zone (`kind`: 'heat' | 'cool'), in both
 * units: those of the zone within ours. Undefined when the zone did not give
 * all four (a command is then refused).
 */
export function limitsOf(zone, kind) {
  const c = zone?.config ?? {};
  const [minF, maxF, minC, maxC] =
    kind === 'heat'
      ? [v(c.minHsp), v(c.maxHsp), v(c.minHspC), v(c.maxHspC)]
      : [v(c.minCsp), v(c.maxCsp), v(c.minCspC), v(c.maxCspC)];
  if (![minF, maxF, minC, maxC].every(Number.isFinite)) {
    return undefined;
  }
  const ours = SETPOINT_BOUNDS[kind];
  const limits = {
    F: { min: Math.max(minF, ours.F.min), max: Math.min(maxF, ours.F.max) },
    C: { min: Math.max(minC, ours.C.min), max: Math.min(maxC, ours.C.max) },
  };
  if (limits.F.min > limits.F.max || limits.C.min > limits.C.max) {
    return undefined;
  }
  return limits;
}

export const within = (pair, limits) =>
  pair.F >= limits.F.min - EPS &&
  pair.F <= limits.F.max + EPS &&
  pair.C >= limits.C.min - EPS &&
  pair.C <= limits.C.max + EPS;

/**
 * The range offered in a unit: every value of it, once rounded and
 * converted, is within both limits (checked value by value, at the step).
 * Undefined when no value is.
 */
export function rangeOf(limits, unit) {
  const step = unit === 'C' ? 0.5 : 1;
  const low = unit === 'C' ? limits.C.min : limits.F.min;
  const high = unit === 'C' ? limits.C.max : limits.F.max;
  let min;
  let max;
  for (let x = Math.ceil(low / step - EPS) * step; x <= high + EPS; x += step) {
    if (within(pairOf(x, unit), limits)) {
      min ??= x;
      max = x;
    }
  }
  return min === undefined ? undefined : { min, max };
}

/** The range of a feature when the zone gave no limit: ours. */
export const defaultRange = (kind, unit) =>
  rangeOf(SETPOINT_BOUNDS[kind], unit) ?? SETPOINT_BOUNDS[kind][unit];

/** The deadband of a zone, in both units (bounded; the default when missing). */
export function deadbandOf(zone) {
  const f = v(zone?.config?.temperatureDeadband);
  const c = v(zone?.config?.temperatureDeadbandC);
  return {
    F: Number.isFinite(f) && f >= 0 && f <= 10 ? f : DEADBAND.F,
    C: Number.isFinite(c) && c >= 0 && c <= 5.5 ? c : DEADBAND.C,
  };
}

/** The setpoints of the zone now (both units), else undefined. */
export function currentOf(zone) {
  const p = zone?.period ?? {};
  const heat = { F: v(p.hsp), C: v(p.hspC) };
  const cool = { F: v(p.csp), C: v(p.cspC) };
  if (![heat.F, heat.C, cool.F, cool.C].every(Number.isFinite)) {
    return undefined;
  }
  return { heat, cool };
}

/**
 * The four values to write for a setpoint asked (`kind`, `asked` in `unit`),
 * or a refusal: `{ fields }` | `{ error, range? }` | `{ same: true }`.
 *   error: 'limits' (the zone gave none), 'missing' (setpoints not read),
 *   'range' (outside, `range` in the unit asked), 'deadband' (the other
 *   setpoint cannot move out of the way within its limits).
 */
export function planSetpoint(zone, kind, asked, unit) {
  const heatLimits = limitsOf(zone, 'heat');
  const coolLimits = limitsOf(zone, 'cool');
  if (!heatLimits || !coolLimits) {
    return { error: 'limits' };
  }
  const limits = kind === 'heat' ? heatLimits : coolLimits;
  const wanted = pairOf(asked, unit);
  if (!within(wanted, limits)) {
    return { error: 'range', range: rangeOf(limits, unit) };
  }
  const now = currentOf(zone);
  if (!now) {
    return { error: 'missing' };
  }
  const gap = deadbandOf(zone);
  let heat = now.heat;
  let cool = now.cool;
  if (kind === 'heat') {
    heat = wanted;
    if (cool.F < heat.F + gap.F || cool.C < heat.C + gap.C - EPS) {
      cool = { F: Math.max(cool.F, heat.F + gap.F), C: Math.max(cool.C, halfC(heat.C + gap.C)) };
      if (!within(cool, coolLimits)) return { error: 'deadband' };
    }
  } else {
    cool = wanted;
    if (cool.F < heat.F + gap.F || cool.C < heat.C + gap.C - EPS) {
      heat = { F: Math.min(heat.F, cool.F - gap.F), C: Math.min(heat.C, halfC(cool.C - gap.C)) };
      if (!within(heat, heatLimits)) return { error: 'deadband' };
    }
  }
  const fields = { hsp: heat.F, hspC: heat.C, csp: cool.F, cspC: cool.C };
  if (
    fields.hsp === now.heat.F &&
    fields.hspC === now.heat.C &&
    fields.csp === now.cool.F &&
    fields.cspC === now.cool.C
  ) {
    return { same: true, fields };
  }
  return { fields };
}
