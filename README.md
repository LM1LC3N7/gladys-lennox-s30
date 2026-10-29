# gladys-lennox-s30

A [Gladys Assistant](https://gladysassistant.com) integration for **Lennox S30,
E30 and M30** thermostats, over their **local API** (option "Home Automation"
of the thermostat, HTTPS with the certificate pinned at the first contact),
without the Lennox cloud.

- One device per zone: temperature, humidity, mode, heating and cooling
  setpoints, running state, fan mode, fan running.
- One device for the system: outdoor temperature, alert level, active alerts.
- The mode **Off** needs no option (kept and sent again until the
  thermostat reads off); the other modes, the setpoints (within the limits of
  the zone, in °F and °C) and the fan mode behind an option, off by default.

**Never tested with a real thermostat**: built and tested against a simulated
thermostat only. Unofficial, not affiliated with Lennox.

User documentation: [English](docs/en.md), [français](docs/fr.md).

Ported from the local part of
[lennoxs30api](https://github.com/PeteRager/lennoxs30api) (MIT), see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Development

```bash
npm install
npm test
npm run lint
npm run format:check
```

Rules for contributors and coding assistants: [CLAUDE.md](CLAUDE.md). Plan,
decisions and what is left to check on a real thermostat: [TODO.md](TODO.md).

## License

Apache-2.0 (see [LICENSE](LICENSE)).
