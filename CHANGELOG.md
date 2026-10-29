# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- First version: a Lennox S30, E30 or M30 read over its local API (HTTPS,
  certificate pinned at the first contact, no credential): one device per
  zone (temperature, humidity, mode, heating and cooling setpoints, running
  state, fan) and one for the system (outdoor temperature, alerts).
- The mode Off always available, kept in /data and sent again until the
  thermostat reads off; the other modes, the setpoints and the fan mode
  behind an option, off by default.
- "Test the connection" and "Trust the new certificate" buttons.
- An Off accepted is checked by its own reads (pause or not) and sent again
  when the zone still runs; a start at the thermostat after it is never
  fought; it follows the thermostat to a new address.

[Unreleased]: https://github.com/LM1LC3N7/gladys-lennox-s30/commits/main
