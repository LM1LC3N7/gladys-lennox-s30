# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration**: a Node.js service (Node 22+, ESM,
no build step) that runs in its own sandboxed Docker container and talks to
Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js),
its only runtime dependency. It started from the official JavaScript template.

## Commands

```bash
npm install
npm test                                  # node --test (60 s per test at most)
node --test test/devices.test.js          # one file
node --test --test-name-pattern "stop"    # tests whose name matches
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run format                            # Prettier, fix in place
npx github:GladysAssistant/integration-store .   # store admission checks
```

The CI (`.github/workflows/ci.yml`) runs `format:check`, `lint` and `test` on
Node 22 and 24, and builds the Docker image: run the three commands before
pushing.

## Architecture

```
index.js                          SDK wiring only: handlers registered before connect()
src/handlers.js                   SDK handlers -> LennoxApp (shared with the tests)
src/app.js                        configuration, the link, reads, devices, states, status, commands, Off
src/devices.js                    devices and states of the zones and the system (pure); keys frozen
src/setpoints.js                  setpoints in °F and °C, limits, deadband (pure)
src/lennox/protocol.js            the local API: bodies, answers, the model built from the queue (pure)
src/lennox/alerts.js              texts of the alert codes (from lennoxs30api)
src/lennox/http.js                one HTTPS request on its own TLS connection, pin checked first
src/store.js                      /data: address, serial, pin, pause, Off kept, guards (no secret)
src/publisher.js                  states to Gladys within 300 per minute
src/config.js                     DEFAULT_CONFIG (mirrors the manifest defaults) + normalization
src/i18n.js                       English and French runtime texts
scripts/cover.mjs                 cover.png generator (plain Node, no dependency)
gladys-assistant-integration.json manifest: name, config_schema, actions, image...
docs/en.md, docs/fr.md            user documentation, re-hosted by Gladys (mandatory)
test/                             node --test, against the SDK's fake Gladys (integration-sdk/testing)
test/kit/                         parts of gladys-testkit: fake servers, clocks, test certificates
test/fixtures/                    messages of a real thermostat (lennoxs30api, MIT)
.github/scripts/release.mjs       release helpers (manifest bump, changelog), tested in test/
```

## Rules

- **External ids are forever.** Build them with
  `gladys.externalIds(type, platformId)`, `platformId` being the serial number
  of the thermostat (`<serial>-zone<n>` for a zone), never a label nor the IP. Gladys keys devices, their
  history, scenes and dashboards on them: changing one creates a new device
  and orphans the old one. The same goes for every key users store: manifest
  `config_schema`, `actions`, feature keys.
- **The container rootfs is read-only.** Write only under `/data`, the one
  writable volume. The local API takes no credential; never keep the body of
  an HTTP answer in an error.
- **Versions belong to the Release workflow** (Actions → Release). Never edit
  `version` in `package.json` or in the manifest, nor the `docker_image` tag,
  by hand — except on the README's hand-pushed tag path, which bumps all three
  together before tagging. `test/manifest.test.js` checks they agree.
- **Changelog.** Every user-visible change adds a line under `## [Unreleased]`
  in `CHANGELOG.md` (`### Added`, `Changed`, `Fixed`, `Removed`, `Security`).
  Never write a version heading: the Release workflow moves the section, and it
  becomes the notes of the GitHub Release.
- **Manifest.** Texts are multi-language objects `{ "en": ..., "fr": ... }`:
  `label`, `description` and `placeholder` alike, never a plain string. The
  catalog `description` holds 10 to 100 characters per language.
  `test/manifest.test.js` ties the manifest to the code: change both sides
  together.
- **User-facing text** is bilingual (English and French): action messages,
  manifest texts, and `docs/en.md` / `docs/fr.md`, kept in sync. Files are
  UTF-8 without BOM and without control bytes (`test/encoding.test.js`).
- **Style.** Prettier formats, ESLint catches mistakes. Comments explain why,
  in English. Tests never touch the network (the TLS tests use the loopback).
- **Clocks.** Every decision runs on the monotonic clock, read once per
  decision; the wall clock only dates /data. Tests use the virtual clock of `test/kit` (it
  moves at every read) and one real-clock test (x20).
- **Lennox S30.** Local API only (Connect, RequestData, Retrieve, Publish of
  lennoxs30api), our own application id `gladys`: nothing of the cloud mode of
  lennoxs30api, nothing that imitates the Lennox app (User-Agent, application
  id, certificate). One request at a time, each on its own connection whose
  certificate is checked against the pin BEFORE any byte is written (the first
  pin in /data before anything is read). A new session (Connect) forgets every
  value and the identity until the thermostat sends them again. The mode Off
  of a zone needs no option and is never held back (a read or a command under
  way, a pause, no configuration read, a guard, /data slow or read only: no
  wait on /data anywhere on its path nor in the reads); not sent, it is kept
  in /data and sent again every 30 s, never dropped by the time; accepted, it
  is checked by reads of its own (everything asked again, 6 s after, then
  every 30 s, pause or not) and sent again when one shows the zone running;
  it ends on a read showing the zone off after the click (message by
  message: a start at the thermostat right after is never fought), on a
  newer mode of the zone ACCEPTED by the thermostat, or when another
  thermostat answers; a new address keeps it until the serial is read there;
  3 refusals in a row or 3 accepted sends contradicted give it up, said in
  the status and the badge. A new session (Connect) only after a 4xx of the
  queue; the numbers of the messages never go back. The other modes, the setpoints and the fan mode are behind
  `allow_commands` (off), decided on the queue emptied after the click,
  checked again in `beforeSend`, guarded in /data before the first byte, a
  success only once a read after the send shows the value asked. Setpoints are
  written in both units, each within the limits of the zone and ours
  (`SETPOINT_BOUNDS`). Never a switch.
