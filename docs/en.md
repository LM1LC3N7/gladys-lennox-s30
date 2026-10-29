# Lennox S30 for Gladys

This integration shows your **Lennox S30, E30 or M30** (iComfort) thermostat in Gladys through its **local
API**, without the Lennox cloud nor the Lennox app. It follows what the lennoxs30api library (the Home Assistant
integration) does, for its local part only.

> Never tested with a real thermostat: everything was checked against a simulated thermostat built from the
> lennoxs30api library and its captures. Not affiliated with Lennox.

## Prepare the thermostat

1. On the thermostat: **Settings**, **Advanced settings**, turn on **Home Automation** (the local API).
2. Give the thermostat a **fixed IP address** in your router.
3. In Gladys, enter that address in the configuration of the integration, save.
4. Add the devices from the **Discovery** tab.

The thermostat is reached over HTTPS. Its certificate is self-signed: it is **pinned at the first contact** (its
fingerprint is kept in `/data`) and checked at every connection, before anything is sent. If it changes (a
thermostat replaced or updated), nothing is sent any more and the status says so: the **Trust the new
certificate** button (two clicks, 3 to 60 s apart) pins exactly the fingerprint shown.

The local API takes no credential: the integration keeps none.

## Devices

- **A zone** (one per zone in use): temperature, humidity, mode (off, heating, cooling, both), heating setpoint,
  cooling setpoint, running (idle, heating, cooling), fan mode (automatic, on, circulate), fan running.
- **The system**: outdoor temperature, alert level, number of active alerts, text of the active alerts.

Temperatures are in the unit the thermostat shows (°F or °C) when the device is added. A reading in °F is
converted exactly to °C (then to a tenth). A reading the thermostat says is not available is not published. The
mode "emergency heat" shows as "heating".

## Commands

### The mode Off

The mode **Off** of a zone needs no option: it goes even with the commands option off. It writes "off" in the manual
schedule of the zone, then makes the zone follow that schedule (as lennoxs30api does): nothing starts in between.
It goes before a read or a command under way, and is sent during a pause asked by the thermostat, before the
first read after a restart, without a configuration read (from `/data`), even when `/data` cannot be written.

It is **refused** only:

- without an address of the thermostat (neither in the configuration nor in `/data`);
- when `/data` cannot be read (the pinned certificate is then unknown);
- for a device of another thermostat than the one answering at the address.

Until the thermostat reads off, the Off is **kept in `/data`** and sent again every 30 seconds (and at a
restart), with no time limit. It ends when a read shows the zone off, when another mode of the zone leaves
Gladys (a click with the option), or when another thermostat answers at the address. An unreachable thermostat
or a changed certificate does not count as a try. Refused three times in a row by the thermostat, or accepted
three times without ever reading off, it is given up, and the status, the badge of the device and the answer say
so. In away mode it targets the manual schedule, as lennoxs30api does (not checked on a real thermostat).

### The other commands (option "Allow the commands")

Off by default. On: the mode (heating, cooling, both), the heating and cooling setpoints and the fan mode.

- Decided on the queue of the thermostat emptied right after the click; refused when a value they need was not
  read, in away mode, in single setpoint mode, during an Off of the zone under way (but a mode, which ends it) and
  while the previous command of the zone is not seen yet (90 s at most).
- Setpoints are rounded to the step of the thermostat (1 °F, 0.5 °C), the other unit is computed exactly, and
  both values must stay within the limits of the zone read from the thermostat and ours (heating 40 to 90 °F,
  cooling 60 to 99 °F). When the heating setpoint would come within the deadband of the zone of the cooling
  setpoint, the other setpoint moves the safe way (cooling up, heating down), within its limits, otherwise the
  command is refused.
- A zone following a program gets an override (a copy of the current period, then held until the next period),
  as in the Lennox app. A change of mode makes the zone follow its manual schedule.
- A command leaves within 3.5 s of the click or is refused with nothing sent; it is a success only when a read
  after the send shows the value asked. Otherwise: "sent, without confirmation" and reads again at 5 and 20 s.

## Configuration

| Field                        | Role                                                                 |
| ---------------------------- | -------------------------------------------------------------------- |
| IP address of the thermostat | IPv4 or host name, port 443 by default.                              |
| Allow the commands           | Off by default (see above).                                          |
| Refresh interval             | 5 to 300 s (10 s by default): how often the queued changes are read. |
| Language                     | Feature names, status texts, errors.                                 |

Everything is asked again from the thermostat every 10 minutes. A thermostat asking to slow down (429) or
answering with a server error (5xx) pauses the reads and the commands (1 minute to 6 hours), not the Off.

## Known limits

- Not checked on a real thermostat; the behaviour in away mode, in central zoning mode and the wait of the queue
  (`LongPollingTimeout=1`) come from lennoxs30api.
- The S40 is not supported (its identity differs).
- No programs, humidification nor ventilation in this version.
