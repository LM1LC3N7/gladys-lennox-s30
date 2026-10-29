// -----------------------------------------------------------------------------
// Entry point: SDK wiring only (src/handlers.js registers every handler BEFORE
// connect(), and delegates to the LennoxApp of src/app.js).
//
// Environment variables provided by the Gladys supervisor, read by the SDK:
// GLADYS_HOST_API_URL, GLADYS_INTEGRATION_TOKEN, GLADYS_INTEGRATION_SELECTOR.
// -----------------------------------------------------------------------------

import { GladysIntegration, logger } from '@gladysassistant/integration-sdk';
import { LennoxApp } from './src/app.js';
import { registerHandlers } from './src/handlers.js';

const gladys = new GladysIntegration();
const app = new LennoxApp({ gladys });

registerHandlers(gladys, app, logger);
// The shutdown stops the timers and writes /data.
gladys.handleShutdown(() => app.shutdown());

logger.info('Starting the Lennox S30 integration...');
gladys.connect().catch((err) => {
  logger.error('Initial connection failed', err);
  process.exit(1);
});
