# Third-party notices

This integration is licensed under the Apache License 2.0 (see `LICENSE`).

## lennoxs30api

The local API of the thermostat as this integration speaks it (the routes
Connect, RequestData, Retrieve and Publish, the JSON paths asked, the shapes
of the messages, the schedules of a zone: manual 16+n, away 24+n, hold 32+n,
the system modes, the fan modes, the change of a setpoint through the manual
or the override schedule and its hold, the order of `systemMode` and
`scheduleId` of a mode, the units of the setpoints) and the texts of the alert
codes (`src/lennox/alerts.js`) are a JavaScript port of parts of
**lennoxs30api** (<https://github.com/PeteRager/lennoxs30api>, version 0.2.24,
commit 19ebd51 of 2026-10-24), the Python library of the Home Assistant
integration for the Lennox S30. Only its local (LAN) part is ported: nothing
of its cloud mode (the User-Agent and the application id of the Lennox app,
the certificate of the app) is used; the integration uses its own application
id, `gladys`. The test fixtures `test/fixtures/*.json` are messages from its
`tests/messages` directory. No Python code runs here and lennoxs30api is not a
dependency. Its license:

```
MIT License

Copyright (c) 2018 Jacob Southard

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## gladys-testkit

`test/kit/` holds parts of gladys-testkit (fake servers on the loopback,
virtual and real clocks, the two test certificates), commit f8f5301, Apache
License 2.0, the same text as `LICENSE`.

## Code of sibling Gladys integrations

The HTTPS transport with its pin (`src/lennox/http.js`), the state publisher
(`src/publisher.js`) and the shape of `src/store.js` and `src/app.js` come from
gladys-sma-ev-charger (Apache-2.0, same author).
