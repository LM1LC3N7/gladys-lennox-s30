// -----------------------------------------------------------------------------
// The SDK handlers, wired to the app. Shared by index.js and the end-to-end
// tests, so the tests run the exact wiring of the container. Every handler is
// registered BEFORE connect().
// -----------------------------------------------------------------------------

import { ACTIONS } from './constants.js';

export function registerHandlers(gladys, app, logger) {
  // Discovery: the devices of the last read, never a request by itself.
  gladys.onScanRequest(() => app.scan());
  gladys.onDeviceCreated((device) => app.deviceCreated(device));
  gladys.onDeviceUpdated((device) => app.deviceCreated(device));
  gladys.onDeviceDeleted((device) => app.deviceDeleted(device));

  // Commands. A failure is logged here: the SDK only acks it to Gladys.
  gladys.onSetValue(async (device, feature, value) => {
    try {
      await app.setValue(device, feature, value);
    } catch (err) {
      logger?.warn(`Command ${feature?.external_id} refused: ${err.message}`);
      throw err;
    }
  });

  // Configuration screen buttons.
  gladys.onAction(ACTIONS.TEST_CONNECTION, () => app.testConnection());
  gladys.onAction(ACTIONS.TRUST_CERTIFICATE, () => app.trustCertificate());

  // Configuration saved by the user: applied one after the other, the last one wins.
  gladys.onConfigUpdated((config) => app.configUpdated(config));

  // Every connection (the first one and each reconnection). A failed
  // getConfig() is asked again without end (src/app.js connectedVia).
  gladys.on('connected', async () => {
    try {
      await app.connectedVia(() => gladys.getConfig());
    } catch (err) {
      logger?.error(`Start failed (${err?.name ?? 'Error'})`);
    }
  });
}
