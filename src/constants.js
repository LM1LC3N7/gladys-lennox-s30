// -----------------------------------------------------------------------------
// Lennox S30 / E30 / M30 constants, limits and timings.
//
// The local API of the thermostat (option "Home Automation" turned on in its
// settings), as lennoxs30api (MIT, PeteRager/lennoxs30api) speaks it on the
// LAN, over HTTPS (a self-signed certificate) and without any credential:
//   - `POST /Endpoints/<app_id>/Connect`: opens the message queue of our
//     application id ("gladys", ours: nothing of the mobile app is used);
//   - `POST /Messages/RequestData` {MessageType: "RequestData", SenderID,
//     MessageID, TargetID: "LCC", AdditionalParameters: {JSONPath}}: asks
//     the thermostat to queue the paths listed (then their changes);
//   - `GET /Messages/<app_id>/Retrieve?…`: the messages queued (JSON
//     {messages: [{SenderID: "LCC", Data: {...}}]}), 204 when none;
//   - `POST /Messages/Publish` {MessageType: "Command", …, Data}: a change
//     (answered {code: 1} when accepted);
//   - `POST /Endpoints/<app_id>/Disconnect`.
// The certificate is pinned at the first contact (its SHA-256 fingerprint in
// /data) and checked at every connection, BEFORE any byte is written.
// -----------------------------------------------------------------------------

export const DEFAULT_PORT = 443;

/** Our application id on the thermostat (never the one of the Lennox app). */
export const APP_ID = 'gladys';

/** The id of the thermostat itself on its local API (lennoxs30api: "LCC"). */
export const SYSTEM_ID = 'LCC';

/** What the integration subscribes to (a part of what lennoxs30api asks). */
export const JSON_PATH =
  '1;/system;/zones;/schedules;/occupancy;/alerts/active;/alerts/meta;/devices';

export const PATHS = {
  connect: `/Endpoints/${APP_ID}/Connect`,
  disconnect: `/Endpoints/${APP_ID}/Disconnect`,
  requestData: '/Messages/RequestData',
  // The queue, oldest first, 10 messages at most per answer, 1 s of long
  // polling at most (lennoxs30api waits 15 s; we keep the requests short so a
  // stop never waits behind one).
  retrieve: `/Messages/${APP_ID}/Retrieve?Direction=Oldest-to-Newest&MessageCount=10&StartTime=1&LongPollingTimeout=1`,
  publish: '/Messages/Publish',
};

/** The zones of a thermostat: 0 to 3 (lennoxs30api: manual schedules 16 to 19). */
export const ZONES = { max: 4 };

/** The schedules of a zone (lennoxs30api): manual, away and hold (override). */
export const SCHEDULE = {
  manual: (zone) => 16 + zone,
  away: (zone) => 24 + zone,
  override: (zone) => 32 + zone,
};

/** The system modes of a zone (lennoxs30api HVAC_MODES). */
export const SYSTEM_MODES = {
  OFF: 'off',
  HEAT: 'heat',
  COOL: 'cool',
  AUTO: 'heat and cool',
  EMERGENCY: 'emergency heat',
};

/** THERMOSTAT_MODE of the core (server/utils/constants.js). */
export const THERMOSTAT_MODE = { OFF: 0, HEATING: 1, COOLING: 2, AUTO: 3 };

/** THERMOSTAT_OPERATING_STATE of the core. */
export const OPERATING_STATE = { IDLE: 0, HEATING: 1, COOLING: 2 };

/** The fan modes (lennoxs30api FAN_MODES). */
export const FAN_MODES = ['auto', 'on', 'circulate'];

/** The alert levels of the system status (lennoxs30api), lowest first. */
export const ALERT_LEVELS = ['none', 'info', 'minor', 'moderate', 'critical'];

/**
 * The setpoints, within the limits of the zone read from the thermostat AND
 * these ones (the widest range of a Lennox S30: heat 40-90 °F, cool
 * 60-99 °F, lennoxs30api fixtures), in both units. The thermostat takes
 * whole °F and half °C; both are always sent, each checked.
 */
export const SETPOINT_BOUNDS = {
  heat: { F: { min: 40, max: 90 }, C: { min: 4.5, max: 32 } },
  cool: { F: { min: 60, max: 99 }, C: { min: 15.5, max: 37 } },
};

/** The smallest gap between the heat and the cool setpoints when the zone gives none. */
export const DEADBAND = { F: 3, C: 1.5 };

/** Feature keys (the last part of the feature external ids): frozen. */
export const FEATURES = {
  TEMPERATURE: 'temperature',
  HUMIDITY: 'humidity',
  MODE: 'mode',
  HEAT_SETPOINT: 'heat-setpoint',
  COOL_SETPOINT: 'cool-setpoint',
  OPERATING_STATE: 'operating-state',
  FAN_MODE: 'fan-mode',
  FAN_RUNNING: 'fan-running',
  OUTDOOR: 'outdoor-temperature',
  ALERT_LEVEL: 'alert-level',
  ALERT_COUNT: 'active-alerts',
  ALERTS: 'alerts',
};

export const ZONE_FEATURES = [
  FEATURES.TEMPERATURE,
  FEATURES.HUMIDITY,
  FEATURES.MODE,
  FEATURES.HEAT_SETPOINT,
  FEATURES.COOL_SETPOINT,
  FEATURES.OPERATING_STATE,
  FEATURES.FAN_MODE,
  FEATURES.FAN_RUNNING,
];
export const SYSTEM_FEATURES = [
  FEATURES.OUTDOOR,
  FEATURES.ALERT_LEVEL,
  FEATURES.ALERT_COUNT,
  FEATURES.ALERTS,
];
export const COMMAND_FEATURES = [
  FEATURES.MODE,
  FEATURES.HEAT_SETPOINT,
  FEATURES.COOL_SETPOINT,
  FEATURES.FAN_MODE,
];

export const ACTIONS = {
  TEST_CONNECTION: 'test_connection',
  TRUST_CERTIFICATE: 'trust_certificate',
};

/** The poll interval of the configuration, in seconds (one short request per read). */
export const POLL_INTERVAL = { min: 5, max: 300, default: 10 };

export const LIMITS = {
  /** Gladys: 300 states per minute. */
  statesPerMinute: 300,
  statesPerRequest: 100,
  /** One answer: 10 messages, the first ones of a session are the biggest (devices, schedules). */
  responseBytes: 2 * 1024 * 1024,
  headerBytes: 8 * 1024,
  /** Elements read per message, at most (zones, schedules, alerts, devices, features). */
  items: 512,
  /** Retrieve rounds of one read (10 messages each). */
  rounds: 5,
  /** Longest text kept from an answer (names, model, firmware). */
  textLength: 60,
};

export const SECOND = 1_000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;

export const TIMINGS = {
  /** One request (its own TLS connection and handshake included). */
  readTimeout: 8 * SECOND,
  /** Failed reads: 30 s, 1, 2, then 5 minutes, never shorter than the interval. */
  backoff: [30 * SECOND, MINUTE, 2 * MINUTE, 5 * MINUTE],
  /** 429 or 5xx: a pause of 1 min .. 6 h (5 min without Retry-After), kept in /data. */
  rateLimitMin: MINUTE,
  rateLimitMax: 6 * HOUR,
  rateLimitDefault: 5 * MINUTE,
  /** Everything asked again (RequestData) this often: a change lost is never kept for long. */
  resync: 10 * MINUTE,
  /** A value not seen in a message for this long is no longer published. */
  stale: 2 * HOUR,
  /** The time of the last read is written to /data at most this often. */
  lastReadSave: MINUTE,
  flushInterval: SECOND,
  stateHeartbeat: 30 * MINUTE,
  /** The two clicks of "Trust the new certificate": 3 s to 1 min apart. */
  confirmAfter: 3 * SECOND,
  confirmWithin: MINUTE,
  /** getConfig() failed in `connected`: asked again after 5 s, 15 s, 30 s, then every minute. */
  configRetry: [5 * SECOND, 15 * SECOND, 30 * SECOND, MINUTE],
  /**
   * Commands (Gladys waits 5 s for the ack): sent by 3.5 s after the click
   * (the fresh read included) or refused unsent; the answer awaited until
   * 4.3 s, after which the command is "sent, without confirmation".
   */
  commandSendBy: 3_500,
  commandAnswerBy: 4_300,
  /** Time left to send after the fresh read, at least. */
  commandMinSend: 300,
  /** Time left for the read that confirms a write, at least. */
  confirmReadMin: 300,
  /** Between two of those reads. */
  confirmGap: 300,
  /** A stop not sent (unreachable, cut) is tried again within its budget, this far apart. */
  stopRetryGap: 250,
  /** A stop not applied is kept in /data and sent again this often, never dropped by the time. */
  pendingStopRetry: 30 * SECOND,
  /** A 429/5xx/refusal answered to a kept stop: next try after this (or Retry-After), at most. */
  pendingStopWaitMax: 5 * MINUTE,
  /** A stop refused by the same answer this many times in a row is given up (said in the status). */
  stopRefusalsMax: 3,
  /** Reads after a command, spaced: its effect, then a check. */
  followUps: [5 * SECOND, 20 * SECOND],
  /** A sent command keeps its guard until the thermostat shows it, or 90 s. */
  guard: 90 * SECOND,
  /** The first pin written to /data before a read: waited for this long at most. */
  saveWait: SECOND,
  /** A read of the zones of the stops accepted, this long after them, then at their rhythm (pause or not). */
  stopCheck: 6 * SECOND,
  /** Commands (and stops) clicked within this window go in one round (a scene). */
  gather: 100,
};
