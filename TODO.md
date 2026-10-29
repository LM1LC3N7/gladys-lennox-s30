# TODO — Lennox S30 v1

Handoff document: what is done, what was decided, what comes next. Keep it
up to date at the end of every milestone.

## Status

- [x] **Milestone 1 — core** (2026-10-29, lot 18): one thermostat by address
      over its local API (HTTPS, certificate pinned at the first contact, no
      credential), one device per zone in use and one for the system; the
      mode Off always available (kept in /data and sent again until read
      off); the other modes, the setpoints (both units, within the limits of
      the zone and ours) and the fan mode behind `allow_commands` (off); test
      and trust buttons; docs en/fr, cover. Tested against a simulated
      thermostat only (a fake behind `exchange` shaped as the fixtures and
      the simulator of lennoxs30api, real TLS servers on the loopback).
- [ ] **Milestone 2 — real thermostat**: run against a real S30 or E30 (see
      "To check"), turn the messages (anonymized) into fixtures.
- [ ] **Milestone 3 — more**: humidity setpoints and modes, the schedules
      (select a program), away mode, ventilation, allergen defender, the S40.

## To check on a real thermostat

- What `LongPollingTimeout=1` does (lennoxs30api uses 15 locally, the cloud
  0): an answer within about 1 s when the queue is empty?
- Whether Publish needs the Connect of the same application id first (the
  Off connects first when no session is open), and the answer of a refused
  change (code other than 1? an HTTP 4xx?).
- Whether a RequestData repeated every 10 minutes sends everything again (as
  the simulator does) or only subscribes.
- That `systemMode: off` in the manual schedule, then `scheduleId` manual,
  stops a zone that follows a program; and what it does in away mode (the
  Off targets the manual schedule as lennoxs30api does; not verified).
- Whether a change of a zone in manual mode comes back as a `schedules`
  message only (as lennoxs30api says) or also in `status.period`.
- The serial number of an E30 and an M30 (device type 500, feature 9) and
  whether it stays the same across firmware updates; the certificate across
  firmware updates.
- Whether the thermostat accepts the override + hold of a setpoint as the
  Lennox app sends it, and how long the hold lasts.

## Decisions

- **Version 0.1.0 set by hand** in `package.json`, `package-lock.json`, the
  manifest and the `docker_image` tag
  (`ghcr.io/lm1lc3n7/gladys-lennox-s30:0.1.0`); the first patch release gives
  0.1.1. `test/manifest.test.js` checks the four agree. SDK `^0.16.0` (the
  latest published, checked on the registry on 2026-10-29).
- **Not in the manifest** (lot rules): `keywords` and `countries` (US, CA —
  to add when the store takes them). Category `climate` only (§3 of the
  catalog spec).
- **Reference**: lennoxs30api 0.2.24 (MIT, PeteRager, commit 19ebd51), license
  read in its `LICENSE` (MIT, "Copyright (c) 2018 Jacob Southard"): not GPL.
  Cloned read only in `~/code/ref/lot18/`. **Local part only**: nothing of its
  cloud mode, which imitates the Lennox app (its User-Agent
  `lx_ic3_mobile_appstore…`, its `APPLICATION_ID` `mapp…`, the certificate of
  the app); our application id is `gladys`. Notices in
  `THIRD_PARTY_NOTICES.md`, shipped in the image with `LICENSE` (Apache-2.0,
  no name).
- **Neighbour modules** (read only): gladys-venstar (local thermostat, units
  as created, features), gladys-nexia (thermostat zones), and the structure of
  gladys-sma-ev-charger (pinned HTTPS transport, /data, stops kept, lot 18
  lessons).
- **Model**: a new session (Connect) empties the model; values come from the
  messages of the queue, each with the number of the message that carried it;
  "a fresh read" is the queue emptied after the click (the thermostat queued
  every change before it). This merges the changes of one session by nature
  (the protocol sends changes only); everything is asked again every 10 min.
- **Devices**: one per zone in use (zone 0, and the others in zoned mode
  within `numberOfZones`), one for the system; ids by the control serial
  number, frozen. Units of the thermostat (°F or °C) at creation; readings
  from °F converted exactly. Emergency heat reads as heating (no such value
  in THERMOSTAT_MODE).
- **Off**: protective, as described in `CLAUDE.md` and the docs. Order:
  `systemMode: off` in the manual schedule first, then `scheduleId` manual
  (the reverse could start the manual setpoints in between). Stops clicked
  together go in one change. An Off accepted is not sent again by the time;
  only a read showing the zone not off 5 s after it (a contradiction) sends
  it again, 3 accepted sends at most. The "changed elsewhere, read twice"
  lift is not used: an Off never applied goes (in doubt, the Off goes).
- **Commands**: one round for the commands clicked together (one read, one
  change for all their zones, then a second one for the zones that must
  follow their manual schedule or hold an override). Refused in away mode and
  in single setpoint mode (not handled in this version). Setpoints: the other
  one moves the safe way within its limits (as the Lennox app does), else
  refused. A guard per zone (in /data before the first byte) refuses the next
  command of the zone until a read shows the previous one (90 s at most).
- **Poll**: 10 s by default (5 to 300 s), one short Retrieve per read.

## Open points (mutation testing, reviews)

- Milestone 1: 37 mutants on the guards (option, Off order and retries,
  epochs, guards, bounds, deadband, freshness, /data), all killed by a test.
- Confirmation: the reads right after a change are repeated (300 ms apart)
  until the answer time, given up at once for a stop or a command waiting.
