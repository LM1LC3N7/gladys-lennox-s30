// -----------------------------------------------------------------------------
// The integration: the Lennox S30 / E30 / M30 typed in the configuration (one
// address), its message queue read every poll interval, its Gladys devices
// (one per zone in use, one for the system) and states, the transport badge,
// the "Test the connection" and "Trust the new certificate" buttons, and the
// commands (mode, heat and cool setpoints, fan mode). index.js only wires the
// SDK handlers to it.
//
// One request at a time on the thermostat (the link): each on its own TLS
// connection whose certificate is checked against the pin first. A command
// takes the link from a read; a stop takes it from anything (the request
// given up is closed at once, its answer never applied).
//
// The model: everything asked (RequestData) arrives once in the queue, then
// each change (src/lennox/protocol.js). A new session (Connect) starts from
// an empty model: no value, no identity, until the thermostat sent them
// again. Everything is asked again every 10 minutes (a change lost is never
// kept for long). "A fresh read" is the queue emptied after the click: the
// thermostat queued every change before it.
//
// Clocks: every decision runs on the MONOTONIC clock (`this.mono`), read
// once per decision; the wall clock only dates what /data keeps.
//
// Commands:
//   - "Off" (the mode Off of a zone) is protective: no option, never held back
//     (not by a read or a command under way, a pause, a configuration not
//     read yet, a guard, a /data that cannot be written), no read before it.
//     It writes `systemMode: off` in the manual schedule of the zone, then
//     makes the zone follow that schedule (lennoxs30api setHVACMode, in the
//     order that never starts anything in between). Not applied, it is kept
//     in /data and sent again every 30 s, never dropped by the time: only a
//     read showing the zone off, a newer mode sent from Gladys (a click with
//     the option), or another thermostat at the address end it. Accepted but
//     contradicted by the reads, it is sent again (3 accepted sends at most,
//     then given up and said); refused 3 times in a row, given up and said.
//   - The other modes, the setpoints and the fan mode stay behind an option
//     (off by default), checked on arrival and again right before the bytes
//     go; decided on the queue emptied after the click; refused while a stop
//     of the zone is under way (but a mode, which ends it), in away mode, and
//     when a value they need is missing; setpoints within the limits of the
//     zone and ours, in both units (src/setpoints.js).
//   - Sent within 3.5 s of the click or refused unsent; answered by 4.3 s;
//     a success only once a read after the send shows the value asked.
//   - Commands arriving together (a scene) go in one round: one read, one
//     change for all their zones.
// -----------------------------------------------------------------------------

import { DEVICE_TRANSPORTS, createLogger } from '@gladysassistant/integration-sdk';
import { ERROR_KINDS, LennoxError, exchange as httpsExchange, notSent } from './lennox/http.js';
import {
  applyMessage,
  awayOf,
  checkAccepted,
  checkPublished,
  dataOf,
  emptyModel,
  holdPart,
  manualPart,
  messagesOf,
  periodPart,
  publishBody,
  requestDataBody,
  valueOf,
  zoneInUse,
  zonesOf,
} from './lennox/protocol.js';
import { addressKey, addressOfKey, normalizeConfig, targetKey } from './config.js';
import { LIMITS, PATHS, SCHEDULE, SECOND, SYSTEM_MODES, TIMINGS, ZONES } from './constants.js';
import {
  apiUnitOf,
  buildSystemDevice,
  buildZoneDevice,
  commandValue,
  offers,
  parseDeviceId,
  parseFeatureId,
  systemIds,
  systemStates,
  zoneIds,
  zoneStates,
} from './devices.js';
import { planSetpoint } from './setpoints.js';
import { ERRORS, T, age, word } from './i18n.js';
import { StatePublisher } from './publisher.js';
import { emptyMemory, fileStore, fromDisk, toDisk } from './store.js';

const both = (en, fr) => ({ en, fr });
const join = (a, b) => both(`${a.en} ${b.en}`, `${a.fr} ${b.fr}`);
const sleep = (timers, ms) => new Promise((resolve) => timers.setTimeout(resolve, ms));

/** The kinds of holders of the link, by priority. */
const KIND = { POLL: 'poll', COMMAND: 'command', STOP: 'stop' };

/** A read showing the zone not off this long after an accepted stop contradicts it. */
const STOP_GRACE = 5 * SECOND;

/** Every field of a period an override copies (lennoxs30api _execute_setpoints). */
const OVERRIDE_FIELDS = [
  'desp',
  'hsp',
  'cspC',
  'sp',
  'husp',
  'humidityMode',
  'systemMode',
  'spC',
  'hspC',
  'csp',
  'startTime',
  'fanMode',
];

const newSession = () => ({ connected: false, serial: undefined, subscribedAt: -Infinity });

export class LennoxApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'lennox-s30' }),
    exchange = httpsExchange,
    now = Date.now,
    monotonic = () => performance.now(),
    timers = globalThis,
    store = fileStore(),
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.exchange = exchange;
    this.now = now;
    this.mono = monotonic;
    this.timers = timers;
    this.store = store;
    this.publisher = new StatePublisher({ gladys, logger, monotonic, timers });
    /** undefined until a configuration was read from Gladys. */
    this.config = undefined;
    this.memory = emptyMemory();
    this.loaded = false;
    this.storageBroken = false;
    this.savedKey = undefined;
    this.generation = 0;
    this.started = false;
    this.model = emptyModel();
    this.session = newSession();
    this.reader = this.freshReader();
    this.lastReadAt = -Infinity;
    /** The holder of the link: { kind, connection, aborted, done, release }. */
    this.holder = undefined;
    /** zone -> the non-protective command of the zone under way. */
    this.inFlight = new Map();
    this.queue = [];
    this.roundRunning = undefined;
    /** zone -> a number moved by each stop clicked (what was emitted before gives way). */
    this.stopEpochs = new Map();
    /** zone -> [{ resolve }] waiting for a read showing the zone off. */
    this.stopWaiters = new Map();
    this.stopsRunning = undefined;
    this.stopsAgain = false;
    this.stopsKick = undefined;
    this.stopTimer = undefined;
    this.published = undefined;
    this.badge = undefined;
    this.lastStatus = undefined;
    this.pendingTrust = undefined;
    this.lifecycle = Promise.resolve();
    this.configAttempt = 0;
    this.configFailures = 0;
    this.configTimer = undefined;
    this.configRetryWait = undefined;
  }

  freshReader() {
    return {
      online: undefined,
      failures: 0,
      wait: undefined,
      error: undefined,
      errorReason: undefined,
      timer: undefined,
      running: undefined,
      followUps: new Set(),
    };
  }

  /** The three clocks read once, for /data. */
  clock() {
    return { mono: this.mono(), now: this.now() };
  }

  // --- Lifecycle -------------------------------------------------------------

  serialize(job) {
    const run = this.lifecycle.then(job, job);
    this.lifecycle = run.catch(() => {});
    return run;
  }

  /**
   * `connected` (the first connection and each reconnection). First, the
   * stops kept in /data go, from /data alone (address, pin and serial of the
   * last thermostat read): no configuration needed. Then the configuration
   * is asked from Gladys, again and again while it fails (5 s, 15 s, 30 s,
   * then every minute, without end).
   */
  async connectedVia(getConfig) {
    this.cancelConfigRetry();
    const attempt = ++this.configAttempt;
    if (!this.config) {
      await this.bootFromDisk();
    }
    let raw;
    try {
      raw = await getConfig();
    } catch (err) {
      if (attempt !== this.configAttempt) return;
      const wait =
        TIMINGS.configRetry[Math.min(this.configFailures, TIMINGS.configRetry.length - 1)];
      this.configFailures += 1;
      this.logger.warn(
        `Lennox: reading the configuration from Gladys failed (${err?.name ?? 'Error'}); again in ${Math.round(wait / 1000)} s`,
      );
      this.configRetryWait = wait;
      this.lastStatus = undefined;
      await this.updateStatus();
      this.configTimer = this.timers.setTimeout(() => {
        this.configTimer = undefined;
        if (attempt === this.configAttempt) {
          this.connectedVia(getConfig).catch(() => this.logger.error('Lennox: start failed'));
        }
      }, wait);
      return;
    }
    if (attempt !== this.configAttempt) return;
    this.configFailures = 0;
    this.configRetryWait = undefined;
    await this.connected(raw);
  }

  /** Before any configuration: /data read, the stops it keeps armed. */
  async bootFromDisk() {
    if (!(await this.ensureLoaded())) return;
    if (this.hasUnsentStops() && !this.stopTimer && this.address()) {
      this.armStopTimer(0);
    }
  }

  cancelConfigRetry() {
    if (this.configTimer !== undefined) {
      this.timers.clearTimeout(this.configTimer);
      this.configTimer = undefined;
    }
  }

  /**
   * Connected to Gladys. The first time, start; after a reconnection, resend
   * what Gladys keeps in memory only (status, Discovery list, badge) and the
   * recent states. Pauses, pins and stops kept stay; nothing is read sooner
   * than the interval.
   */
  connected(raw = {}) {
    return this.serialize(async () => {
      if (!this.started || !this.config) {
        this.started = true;
        await this.doStart(raw);
        return;
      }
      if (await this.applyChange(raw)) {
        return;
      }
      this.published = undefined;
      this.badge = undefined;
      this.lastStatus = undefined;
      this.gladys.forgetPublishedStates?.();
      await this.publishAll();
    });
  }

  /** A configuration saved: applied one after the other, the last one wins. */
  configUpdated(raw = {}) {
    this.configAttempt += 1;
    this.cancelConfigRetry();
    this.configRetryWait = undefined;
    return this.serialize(async () => {
      if (!this.config) {
        this.started = true;
        await this.doStart(raw);
        return;
      }
      const previous = this.config;
      if (await this.applyChange(raw)) {
        return;
      }
      if (this.config.allowCommands !== previous.allowCommands) {
        this.logger.info(`Lennox: commands ${this.config.allowCommands ? 'allowed' : 'disabled'}`);
      }
      if (this.config.language !== previous.language) {
        this.published = undefined;
      }
      await this.publishAll();
    });
  }

  /** Only a new address restarts (true); the rest applies at once. */
  async applyChange(raw) {
    const next = normalizeConfig(raw);
    const c = this.config;
    if (
      JSON.stringify(next.address ?? null) !== JSON.stringify(c.address ?? null) ||
      next.invalidHost !== c.invalidHost
    ) {
      await this.doStart(raw);
      return true;
    }
    this.config = next;
    if (next.pollInterval !== c.pollInterval && this.readable && !this.reader.running) {
      this.schedule();
    }
    return false;
  }

  async doStart(raw = {}) {
    this.halt();
    await this.reader.running?.catch(() => {});
    this.config = normalizeConfig(raw);
    await this.ensureLoaded();
    this.reader = this.freshReader();
    this.session = newSession();
    this.model = emptyModel(this.model.seq);
    this.pendingTrust = undefined;
    this.published = undefined;
    this.badge = undefined;
    this.lastStatus = undefined;
    this.publisher.start();
    if (!this.readable) {
      await this.publishAll();
      return;
    }
    await this.setStatus(false, this.status()[1]);
    if (this.hasUnsentStops()) {
      this.armStopTimer(0);
    }
    await this.tick();
  }

  /**
   * /data read once per process; unreadable is NOT empty: nothing is pinned
   * nor sent, it is read again at the next tick. Then the target of the
   * configuration: another address forgets the identity, the pin, the stops
   * and the last read of the old one.
   */
  async ensureLoaded() {
    if (!this.loaded) {
      let raw;
      try {
        raw = await this.store.load();
      } catch (err) {
        if (!this.storageBroken) {
          this.logger.warn(`Lennox: /data cannot be read (${err?.code ?? 'error'})`);
        }
        this.storageBroken = true;
        return false;
      }
      this.memory = fromDisk(raw, this.clock());
      this.loaded = true;
      this.storageBroken = false;
      this.savedKey = undefined;
      if (Number.isFinite(this.memory.lastReadAt)) {
        this.lastReadAt = Math.min(this.mono(), this.memory.lastReadAt + TIMINGS.lastReadSave);
      }
    }
    const target = this.config ? (targetKey(this.config) ?? null) : null;
    if (target && this.memory.target !== target) {
      const old = this.memory;
      this.memory = { ...emptyMemory(), target };
      if (old.target) {
        this.logger.info(
          'Lennox: another address, the identity and the pin of the old one are forgotten',
        );
      }
      this.lastReadAt = -Infinity;
      await this.saveMemory();
    }
    return true;
  }

  /** An address: the thermostat can be read. */
  get readable() {
    return Boolean(this.config?.address);
  }

  /** The address of the thermostat: the configured one, or (no configuration yet) the one of /data. */
  address() {
    if (this.config) return this.config.address;
    return this.loaded ? addressOfKey(this.memory.target) : undefined;
  }

  /** Stops the timers and gives up the request under way (a restart, a shutdown). */
  halt() {
    this.generation += 1;
    this.clearTimer();
    if (this.stopTimer) {
      this.timers.clearTimeout(this.stopTimer);
      this.stopTimer = undefined;
    }
    this.clearFollowUps();
    if (this.holder) {
      this.abort(this.holder);
    }
    this.publisher.stop();
  }

  async shutdown() {
    this.configAttempt += 1;
    this.cancelConfigRetry();
    this.halt();
    await this.saveMemory();
  }

  clearTimer() {
    if (this.reader.timer) {
      this.timers.clearTimeout(this.reader.timer);
      this.reader.timer = undefined;
    }
  }

  clearFollowUps() {
    for (const handle of this.reader.followUps) {
      this.timers.clearTimeout(handle);
    }
    this.reader.followUps.clear();
  }

  async setStatus(connected, message) {
    const key = JSON.stringify([connected, message ?? null]);
    if (key === this.lastStatus) {
      return;
    }
    this.lastStatus = key;
    await this.gladys
      .setConnectionStatus(connected, message)
      .catch((err) => this.logger.warn(`setConnectionStatus failed: ${err.message}`));
  }

  /**
   * Writes /data when something changed, or when the wall clock moved by a
   * minute or more against the monotonic one. Never over a file that could
   * not be read. Resolves false when the write failed.
   */
  async saveMemory() {
    if (!this.loaded) {
      return false;
    }
    const clock = this.clock();
    const key = JSON.stringify([this.memory, Math.round((clock.now - clock.mono) / 60_000)]);
    if (key === this.savedKey) {
      return true;
    }
    try {
      await this.store.save(toDisk(this.memory, clock));
      this.savedKey = key;
      return true;
    } catch (err) {
      this.logger.warn(`Saving the state to /data failed: ${err?.code ?? 'error'}`);
      return false;
    }
  }

  /** A save never waited for (the stop path): its failure is only logged. */
  saveLater() {
    this.saveMemory().catch(() => {});
  }

  // --- Certificate --------------------------------------------------------------

  /**
   * The certificate of a new connection, checked BEFORE anything is written:
   * the pin of the address, or, at the first contact, pinned now (kept in
   * /data before anything is read; a stop does not wait for /data). Another
   * one is refused and kept for "Trust the new certificate".
   */
  async trust(fingerprint, { target, generation, protective }) {
    const stale = () =>
      new LennoxError(ERROR_KINDS.STALE, 'The configuration changed', { notSent: true });
    if (generation !== this.generation || this.memory.target !== target || !this.loaded) {
      throw stale();
    }
    const pin = this.memory.pin;
    if (pin && pin !== fingerprint) {
      if (this.memory.refusedPin !== fingerprint) {
        this.memory.refusedPin = fingerprint;
        this.logger.warn('Lennox: the certificate of the thermostat changed, nothing sent to it');
        this.saveLater();
      }
      throw new LennoxError(ERROR_KINDS.CERTIFICATE, 'The certificate changed', {
        notSent: true,
        fingerprint,
      });
    }
    if (this.memory.refusedPin) {
      this.memory.refusedPin = null;
      this.pendingTrust = undefined;
      this.saveLater();
    }
    if (!pin) {
      this.memory.pin = fingerprint;
      if (protective) {
        this.saveLater();
      } else if (!(await this.saveMemory())) {
        if (this.memory.pin === fingerprint) this.memory.pin = null;
        throw new LennoxError(ERROR_KINDS.STORAGE, '/data not writable', { notSent: true });
      }
      this.logger.info('Lennox: certificate of the thermostat pinned (first contact)');
    }
    if (generation !== this.generation || this.memory.target !== target) {
      throw stale();
    }
  }

  // --- The link --------------------------------------------------------------------

  abort(holder) {
    holder.aborted = true;
    holder.connection?.close();
  }

  /** The link is held (a holder given up does not hold it: its connection is closed). */
  get busy() {
    return Boolean(this.holder) && !this.holder.aborted;
  }

  /**
   * Takes the link. A stop takes it from anything but a stop, a command from
   * a read; otherwise the holder is waited for until `by` (monotonic), then
   * refused.
   */
  async take(kind, by) {
    for (let i = 0; i < 5; i += 1) {
      const current = this.holder;
      if (!current || current.aborted) {
        let release;
        const holder = {
          kind,
          connection: undefined,
          aborted: false,
          done: new Promise((resolve) => {
            release = resolve;
          }),
        };
        holder.release = () => {
          if (this.holder === holder) this.holder = undefined;
          release();
        };
        this.holder = holder;
        return holder;
      }
      const preempt =
        (kind === KIND.STOP && current.kind !== KIND.STOP) ||
        (kind === KIND.COMMAND && current.kind === KIND.POLL);
      if (preempt) {
        this.abort(current);
        continue;
      }
      const limit = Math.max(0, by - this.mono());
      if (limit <= 0) break;
      let timer;
      await Promise.race([
        current.done,
        new Promise((resolve) => {
          timer = this.timers.setTimeout(resolve, limit);
        }),
      ]);
      this.timers.clearTimeout(timer);
    }
    throw this.refusal(ERRORS.stillRunning);
  }

  /**
   * One request on the link, on its own connection: the address and the pin
   * of now; bounded by `by` (monotonic) and the read timeout.
   */
  async request(holder, { method, path, body, by, beforeSend, protective = false }) {
    const generation = this.generation;
    if (holder.aborted) {
      throw new LennoxError(ERROR_KINDS.ABORTED, 'Given up', { notSent: true });
    }
    const address = this.address();
    if (!address) {
      throw new LennoxError(ERROR_KINDS.STALE, 'No address', { notSent: true });
    }
    const left = Math.min(TIMINGS.readTimeout, by - this.mono());
    if (left <= 0) {
      throw new LennoxError(ERROR_KINDS.LATE, 'No time left', { notSent: true });
    }
    const target = this.memory.target;
    const answer = await this.exchange({
      host: address.host,
      port: address.port,
      timeoutMs: left,
      trust: (fingerprint) => this.trust(fingerprint, { target, generation, protective }),
      onOpen: (connection) => {
        holder.connection = connection;
        if (holder.aborted) connection.close();
      },
      method,
      path,
      body,
      beforeSend: () => {
        if (holder.aborted) {
          throw new LennoxError(ERROR_KINDS.ABORTED, 'Given up');
        }
        if (generation !== this.generation) {
          throw new LennoxError(ERROR_KINDS.STALE, 'The configuration changed');
        }
        beforeSend?.();
      },
    });
    if (generation !== this.generation) {
      throw new LennoxError(ERROR_KINDS.STALE, 'The configuration changed', { answered: true });
    }
    return answer;
  }

  /** A new queue on the thermostat: everything read before is forgotten (identity included). */
  async connectSession(holder, by, protective = false) {
    const answer = await this.request(holder, {
      method: 'POST',
      path: PATHS.connect,
      by,
      protective,
    });
    checkAccepted(answer);
    this.session = { connected: true, serial: undefined, subscribedAt: -Infinity };
    this.model = emptyModel(this.model.seq);
  }

  /** Connect when needed, RequestData when due, then the queue emptied. */
  async readCycle(holder, by) {
    if (!this.session.connected) {
      await this.connectSession(holder, by);
    }
    if (this.mono() - this.session.subscribedAt >= TIMINGS.resync) {
      const answer = await this.request(holder, {
        method: 'POST',
        path: PATHS.requestData,
        body: requestDataBody(),
        by,
      });
      checkAccepted(answer);
      this.session.subscribedAt = this.mono();
    }
    await this.drain(holder, by);
  }

  /**
   * Empties the queue (10 messages an answer, LIMITS.rounds answers at most),
   * applying each message. `until(answered)`: stops early once true.
   */
  async drain(holder, by, until) {
    for (let round = 0; round < LIMITS.rounds; round += 1) {
      let answer;
      try {
        answer = await this.request(holder, { method: 'GET', path: PATHS.retrieve, by });
      } catch (err) {
        if (err.kind === ERROR_KINDS.ABORTED || err.kind === ERROR_KINDS.TIMEOUT) {
          // Messages may have left the queue unread: everything is asked again.
          this.session.subscribedAt = -Infinity;
        }
        throw err;
      }
      let messages;
      try {
        messages = messagesOf(answer);
      } catch (err) {
        if (err.kind === ERROR_KINDS.REJECTED) {
          // The queue is gone (the thermostat restarted): a new session.
          this.session.connected = false;
        }
        throw err;
      }
      this.applyMessages(messages);
      if (messages.length < 10 || until?.()) {
        return;
      }
    }
  }

  /**
   * The reads that may show a change just sent, until `done()` or the answer
   * time; given up at once for a stop or a command waiting for the link.
   * Never thrown: the change left, its answer is "sent" whatever happens.
   */
  async confirmReads(holder, answerBy, done) {
    while (!done() && !this.stopsAgain && this.queue.length === 0) {
      if (answerBy - this.mono() < TIMINGS.confirmReadMin) return;
      try {
        await this.drain(holder, answerBy, done);
      } catch {
        return;
      }
      if (done() || answerBy - this.mono() < TIMINGS.confirmReadMin + TIMINGS.confirmGap) return;
      await sleep(this.timers, TIMINGS.confirmGap);
    }
  }

  // --- Messages ----------------------------------------------------------------------

  applyMessages(messages) {
    if (messages.length === 0) {
      return;
    }
    const at = this.mono();
    for (const message of messages) {
      applyMessage(this.model, message, at);
    }
    const serial = valueOf(this.model.system.serial);
    if (serial && this.session.serial !== serial) {
      if (this.session.serial) {
        this.logger.warn('Lennox: another thermostat answers at this address');
      }
      this.session.serial = serial;
    }
    if (serial && this.memory.serial !== serial) {
      if (this.memory.serial) {
        // Another thermostat at the address: the stops of the old one are not for this one.
        this.memory.pendingStops = {};
        this.memory.stopGivenUp = {};
        this.memory.guards = {};
      }
      this.memory.serial = serial;
      this.saveLater();
    }
    this.watchStops();
    this.watchGuards();
    this.publishAll().catch((err) => this.logger.warn(`Publishing failed: ${err.message}`));
  }

  // --- Polling ---------------------------------------------------------------

  get interval() {
    return (this.config?.pollInterval ?? 10) * SECOND;
  }

  get readDue() {
    return this.lastReadAt + this.interval;
  }

  async markRead(mono) {
    this.lastReadAt = mono;
    if (!(mono - this.memory.lastReadAt < TIMINGS.lastReadSave)) {
      this.memory.lastReadAt = mono;
      await this.saveMemory();
    }
  }

  paused(mono = this.mono()) {
    return Boolean(this.memory.pause) && mono < this.memory.pause.until;
  }

  schedule(delay) {
    const r = this.reader;
    this.clearTimer();
    const mono = this.mono();
    let wait = this.paused(mono)
      ? Math.max(this.memory.pause.until - mono, this.interval)
      : (delay ?? (r.online === false ? r.wait : this.interval));
    wait = Math.max(wait ?? this.interval, this.readDue - mono);
    const generation = this.generation;
    r.timer = this.timers.setTimeout(
      () => {
        r.timer = undefined;
        if (generation === this.generation) {
          this.tick().catch(() => this.logger.error('Lennox refresh failed'));
        }
      },
      Math.max(0, wait),
    );
  }

  /** One read at a time: a tick during a read joins it. */
  tick({ followUp = false } = {}) {
    const r = this.reader;
    if (!r.running) {
      r.running = this.run({ followUp }).finally(() => {
        if (this.reader === r) r.running = undefined;
      });
    }
    return r.running;
  }

  async run({ followUp = false } = {}) {
    const generation = this.generation;
    const r = this.reader;
    if (!this.readable) {
      await this.publishAll();
      return;
    }
    if (!(await this.ensureLoaded())) {
      await this.publishAll();
      if (generation === this.generation) this.schedule(this.interval);
      return;
    }
    if (this.hasUnsentStops()) {
      // The stops kept go before the read (never held back by it).
      this.runStops().catch(() => {});
    }
    const mono = this.mono();
    if (this.paused(mono)) {
      await this.publishAll();
      this.schedule();
      return;
    }
    if ((!followUp && mono < this.readDue) || this.busy) {
      await this.publishAll();
      this.schedule(this.busy ? this.interval : this.readDue - mono);
      return;
    }
    await this.markRead(mono);
    if (generation !== this.generation) return;
    let delay;
    let holder;
    try {
      holder = await this.take(KIND.POLL, this.mono());
      await this.readCycle(holder, this.mono() + 4 * TIMINGS.readTimeout);
      if (generation !== this.generation) return;
      r.online = true;
      r.failures = 0;
      r.wait = undefined;
      r.error = undefined;
      if (!this.session.serial) {
        r.error = 'no_id';
      }
    } catch (err) {
      if (generation !== this.generation) return;
      if (err.kind === ERROR_KINDS.ABORTED || err.refusal) {
        // A command or a stop took the link: not a failure.
        delay = this.interval;
      } else {
        delay = await this.failed(err);
      }
    } finally {
      holder?.release();
    }
    await this.publishAll();
    if (generation === this.generation) {
      this.schedule(delay);
    }
  }

  /** A failed read: the delay before the next one. */
  async failed(err) {
    const r = this.reader;
    const reason = reasonOf(err);
    r.online = false;
    if (err.kind !== ERROR_KINDS.CERTIFICATE && err.kind !== ERROR_KINDS.STORAGE) {
      // The thermostat may have restarted: a new session at the next read.
      this.session.connected = false;
    }
    if (err.kind === ERROR_KINDS.CERTIFICATE || err.kind === ERROR_KINDS.STORAGE) {
      r.error = err.kind;
      r.wait = this.interval;
      return r.wait;
    }
    if (
      err.kind === ERROR_KINDS.RATE_LIMITED ||
      (err.kind === ERROR_KINDS.HTTP && err.status >= 500)
    ) {
      r.online = true;
      await this.pauseFor(err);
      this.logger.warn(`Lennox: ${reason}, pause`);
      return undefined;
    }
    const wait = Math.max(
      this.interval,
      TIMINGS.backoff[Math.min(r.failures, TIMINGS.backoff.length - 1)],
    );
    r.failures += 1;
    r.wait = wait;
    r.error = err.kind;
    r.errorReason = reason;
    this.logger.warn(`Lennox: ${reason}; next try in ${Math.round(wait / 1000)} s`);
    return wait;
  }

  /** A 429 or a 5xx: every path waits but the stops, kept in /data. */
  async pauseFor(err) {
    const wait = Math.min(
      TIMINGS.rateLimitMax,
      Math.max(TIMINGS.rateLimitMin, err.retryAfter ?? TIMINGS.rateLimitDefault),
    );
    this.memory.pause = {
      until: Math.max(this.memory.pause?.until ?? -Infinity, this.mono() + wait),
      reason: err.kind === ERROR_KINDS.RATE_LIMITED && err.status === 429 ? '429' : '5xx',
    };
    await this.saveMemory();
  }

  /** Spaced reads after a change: its effect, then a check. */
  followUp() {
    const generation = this.generation;
    const r = this.reader;
    this.clearFollowUps();
    for (const delay of TIMINGS.followUps) {
      const handle = this.timers.setTimeout(() => {
        r.followUps.delete(handle);
        if (generation !== this.generation) return;
        Promise.resolve(r.running)
          .catch(() => {})
          .then(() => this.tick({ followUp: true }))
          .catch(() => this.logger.error('Lennox refresh failed'));
      }, delay);
      r.followUps.add(handle);
    }
  }

  // --- Status --------------------------------------------------------------------

  summary() {
    const system = this.model.system;
    const zones = zonesOf(this.model);
    const name = valueOf(system.name) ?? 'Lennox';
    const level = valueOf(system.alert);
    return T.summary(name.slice(0, 60), zones.length, level);
  }

  /** The text of the stops kept or given up, if any. */
  stopsText() {
    const pending = Object.keys(this.memory.pendingStops);
    const givenUp = Object.entries(this.memory.stopGivenUp);
    const parts = [];
    if (pending.length > 0) {
      parts.push(T.pendingStop(pending.map((z) => this.zoneName(Number(z))).join(', ')));
    }
    for (const [z, g] of givenUp) {
      parts.push(T.stopGivenUp(this.zoneName(Number(z)), g.status));
    }
    return parts.reduce((a, b) => (a ? join(a, b) : b), undefined);
  }

  zoneName(zone) {
    const named = valueOf(this.model.zones.get(zone)?.config.name);
    return named ? `${named} (${zone + 1})` : `${zone + 1}`;
  }

  /** `[connected, message, plain]`. */
  status() {
    const r = this.reader;
    const config = this.config;
    if (!config) {
      return [false, T.connecting];
    }
    if (!config.address) {
      return [false, config.invalidHost ? T.invalidHost(config.invalidHost) : T.noHost];
    }
    if (this.storageBroken) {
      return [false, T.storageUnreadable];
    }
    const kept = this.stopsText();
    const withKept = (text) => (kept ? join(text, kept) : text);
    const mono = this.mono();
    if (this.paused(mono)) {
      const wait = age(this.memory.pause.until - mono);
      return [
        false,
        withKept(this.memory.pause.reason === '429' ? T.rateLimited(wait) : T.serverError(wait)),
      ];
    }
    if (r.online === false) {
      const wait = age(r.wait ?? this.interval);
      if (r.error === ERROR_KINDS.CERTIFICATE) {
        return [false, withKept(T.certificateChanged(this.memory.refusedPin))];
      }
      if (r.error === ERROR_KINDS.STORAGE) {
        return [false, withKept(T.storage)];
      }
      if ([ERROR_KINDS.UNREACHABLE, ERROR_KINDS.TIMEOUT, ERROR_KINDS.LATE].includes(r.error)) {
        return [false, withKept(T.unreachable(addressKey(config.address), wait))];
      }
      return [false, withKept(T.failing(r.errorReason ?? 'error', wait))];
    }
    if (r.online === undefined) {
      return [false, withKept(T.connecting)];
    }
    if (!this.session.serial) {
      return [false, withKept(T.noIdentity)];
    }
    let summary = this.summary();
    if (kept) summary = join(summary, kept);
    return [true, T.connected(summary), summary];
  }

  async updateStatus() {
    if (this.configRetryWait !== undefined) {
      const [, message] = this.status();
      const retry = T.configRetry(age(this.configRetryWait));
      await this.setStatus(false, this.config ? join(retry, message) : retry);
      return;
    }
    const [connected, message, plain] = this.status();
    const orphans = this.session.serial ? this.orphans() : [];
    if (orphans.length === 0) {
      await this.setStatus(connected, message);
      return;
    }
    const names = orphans
      .map((d) =>
        typeof d.name === 'string' && d.name !== '' ? d.name.slice(0, 60) : d.external_id,
      )
      .slice(0, 10)
      .join(', ');
    await this.setStatus(false, join(plain ?? message, T.notRead(names)));
  }

  // --- Gladys ----------------------------------------------------------------

  createdFeatures() {
    const map = new Map();
    for (const d of this.gladys.devices ?? []) {
      for (const f of d.features ?? []) map.set(f.external_id, f);
    }
    return map;
  }

  /** The devices created in Gladys that the thermostat read is not (another serial). */
  orphans() {
    const serial = this.session.serial;
    if (!serial) return [];
    return (this.gladys.devices ?? []).filter((d) => {
      const id = parseDeviceId(d?.external_id);
      return id && id.serial !== serial;
    });
  }

  /** Whether a value may be published: read in this session, within 2 hours. */
  freshField(field, mono = this.mono()) {
    return field !== undefined && mono - field.at <= TIMINGS.stale;
  }

  async publishAll() {
    await this.publishDevices();
    this.queueStates();
    await this.flush();
    await this.publishBadge();
    await this.updateStatus();
  }

  async flush() {
    await this.publisher
      .flush()
      .catch((err) => this.logger.warn(`Sending to Gladys failed: ${err.message}`));
  }

  /** The devices of the thermostat read (its identity and unit known), else none. */
  buildDevices() {
    const serial = this.session.serial;
    if (!serial || !valueOf(this.model.system.unit)) {
      return [];
    }
    const language = this.config?.language ?? 'fr';
    const byId = new Map((this.gladys.devices ?? []).map((d) => [d.external_id, d]));
    const devices = zonesOf(this.model)
      .filter(
        (zone) => zone.status.temperature !== undefined || zone.status.temperatureC !== undefined,
      )
      .map((zone) =>
        buildZoneDevice(this.gladys, serial, this.model, zone, {
          language,
          created: byId.get(zoneIds(this.gladys, serial, zone.id).device),
        }),
      );
    devices.push(
      buildSystemDevice(this.gladys, serial, this.model, {
        language,
        created: byId.get(systemIds(this.gladys, serial).device),
      }),
    );
    return devices;
  }

  async publishDevices() {
    const devices = this.buildDevices();
    if (devices.length === 0) return;
    const json = JSON.stringify(devices);
    if (json === this.published) return;
    try {
      await this.gladys.publishDiscoveredDevices(devices);
      this.published = json;
    } catch (err) {
      this.logger.warn(`Publishing the discovered devices failed: ${err.message}`);
    }
  }

  queueStates(created = this.createdFeatures()) {
    const serial = this.session.serial;
    if (!serial || this.reader.online !== true) {
      // Nothing read now: nothing published (never an old value as a new one).
      return;
    }
    const mono = this.mono();
    const fresh = (field) => this.freshField(field, mono);
    const unitOf = (id) => apiUnitOf(created.get(id)?.unit);
    const push = (states) => {
      for (const { device_feature_external_id: id, ...value } of states) {
        if (created.has(id)) this.publisher.push(id, value);
      }
    };
    for (const zone of zonesOf(this.model)) {
      push(zoneStates(zoneIds(this.gladys, serial, zone.id), zone, { fresh, unitOf }));
    }
    push(
      systemStates(systemIds(this.gladys, serial), this.model.system, {
        fresh,
        unitOf,
        language: this.config?.language ?? 'fr',
      }),
    );
  }

  async publishBadge() {
    const serial = this.session.serial ?? this.memory.serial;
    const entries = [];
    for (const device of this.gladys.devices ?? []) {
      const id = parseDeviceId(device?.external_id);
      if (!id) continue;
      if (id.serial !== serial) {
        entries.push({ external_id: device.external_id, transport: DEVICE_TRANSPORTS.UNREACHABLE });
        continue;
      }
      const givenUp = id.zone === undefined ? undefined : this.memory.stopGivenUp[id.zone];
      entries.push({
        external_id: device.external_id,
        transport:
          this.reader.online === true ? DEVICE_TRANSPORTS.LOCAL : DEVICE_TRANSPORTS.UNREACHABLE,
        ...(givenUp ? { degraded: true, message: T.badgeStopGivenUp(givenUp.status) } : {}),
      });
    }
    const json = JSON.stringify(entries);
    if (entries.length === 0 || json === this.badge) return;
    try {
      await this.gladys.publishTransports(entries);
      this.badge = json;
    } catch (err) {
      this.logger.warn(`Transport badge failed: ${err.message}`);
    }
  }

  async deviceCreated(device) {
    this.badge = undefined;
    const created = this.createdFeatures();
    for (const f of device?.features ?? []) created.set(f.external_id, f);
    this.queueStates(created);
    await this.flush();
    await this.publishBadge();
  }

  async deviceDeleted(device) {
    this.badge = undefined;
    if (typeof device?.external_id === 'string') {
      this.publisher.forget(device.external_id);
    }
  }

  async scan() {
    this.published = undefined;
    await this.publishDevices();
  }

  // --- Buttons -----------------------------------------------------------------------

  lastMessage() {
    return JSON.parse(this.lastStatus ?? '[false,null]')[1];
  }

  /** Reads the thermostat now, if a read is due (never sooner than the interval). */
  async testConnection() {
    const mono = this.mono();
    if (!this.readable || this.paused(mono) || this.storageBroken) {
      return this.status()[1];
    }
    if (mono < this.readDue || this.busy) {
      const last = this.lastMessage();
      const notDue = T.notDue(age(Math.max(SECOND, this.readDue - mono)));
      return last ? join(notDue, last) : notDue;
    }
    await this.tick();
    return this.lastMessage() ?? T.connecting;
  }

  secondClick(pending, mono) {
    return (
      pending !== undefined &&
      mono - pending.at >= TIMINGS.confirmAfter &&
      mono - pending.at <= TIMINGS.confirmWithin
    );
  }

  /**
   * "Trust the new certificate", two clicks: the first one shows the whole
   * fingerprint refused and pins nothing; a second one 3 to 60 s later pins
   * exactly that one, then reads and sends the stops kept.
   */
  async trustCertificate() {
    const refused = this.memory.refusedPin;
    if (!refused || !this.readable || !this.loaded) {
      this.pendingTrust = undefined;
      return T.trust.nothing;
    }
    const pending = this.pendingTrust;
    const mono = this.mono();
    if (!this.secondClick(pending, mono) || pending.fingerprint !== refused) {
      this.pendingTrust = { fingerprint: refused, at: mono };
      return T.trust.confirm(refused);
    }
    this.pendingTrust = undefined;
    this.memory.pin = refused;
    this.memory.refusedPin = null;
    this.memory.lastReadAt = -Infinity;
    this.lastReadAt = -Infinity;
    this.reader.error = undefined;
    this.session = newSession();
    await this.saveMemory();
    this.logger.info('Lennox: the new certificate of the thermostat was trusted by the user');
    // The stops kept for the certificate go now.
    for (const p of Object.values(this.memory.pendingStops)) {
      if (p.state === 'unsent' && !p.refusal) p.notBefore = -Infinity;
    }
    if (this.hasUnsentStops()) this.armStopTimer(0);
    await this.reader.running?.catch(() => {});
    await this.tick();
    const last = this.lastMessage();
    return last ? join(T.trust.done(refused), last) : T.trust.done(refused);
  }

  // --- Commands ------------------------------------------------------------------------

  refusal(text) {
    return Object.assign(new Error(word(text, this.config?.language)), { refusal: true });
  }

  /**
   * Whether a command of the thermostat `serial` goes to the address: the one
   * read in this session; before it (a restart, a first read under way), a
   * stop goes to the last one read at this address (/data), or to a device
   * created in Gladys when /data knows none.
   */
  isTarget(serial, isStop) {
    if (this.session.serial !== undefined) {
      return this.session.serial === serial;
    }
    if (!isStop) return false;
    if (this.memory.serial) return this.memory.serial === serial;
    return (this.gladys.devices ?? []).some(
      (d) => parseDeviceId(d?.external_id)?.serial === serial,
    );
  }

  async setValue(_device, feature, value) {
    const received = this.mono();
    const target = parseFeatureId(feature?.external_id);
    if (!target || target.zone === undefined) {
      throw this.refusal(ERRORS.readOnly);
    }
    const change = commandValue(target.key, value);
    if (!change) {
      throw this.refusal(target.key === undefined ? ERRORS.readOnly : ERRORS.badValue);
    }
    const isStop = change.mode === SYSTEM_MODES.OFF;
    if (!isStop) {
      if (!this.config) throw this.refusal(ERRORS.noConfig);
      if (!this.config.allowCommands) throw this.refusal(ERRORS.disabled);
    }
    if (!this.address()) {
      throw this.refusal(ERRORS.noAddress);
    }
    if (!(await this.ensureLoaded())) {
      throw this.refusal(ERRORS.storageUnreadable);
    }
    if (!this.isTarget(target.serial, isStop)) {
      throw this.refusal(
        !isStop && this.session.serial === undefined ? ERRORS.notReadYet : ERRORS.otherThermostat,
      );
    }
    if (isStop) {
      return this.stopZone(target.serial, target.zone, received);
    }
    return this.command({ ...target, change, received, feature });
  }

  // --- Off ----------------------------------------------------------------------------

  hasUnsentStops() {
    return Object.values(this.memory.pendingStops).some((p) => p.state === 'unsent');
  }

  /**
   * A stop clicked: kept in /data at once (never waited for), the commands of
   * the zone not sent yet given up, then sent with the others due. The answer:
   * a success once a read shows the zone off, else why not (yet).
   */
  async stopZone(serial, zone, received) {
    const mono = this.mono();
    this.stopEpochs.set(zone, (this.stopEpochs.get(zone) ?? 0) + 1);
    // Queued commands of the zone (not sent): given up, never after the stop.
    for (const entry of [...this.queue]) {
      if (entry.zone === zone) {
        this.queue.splice(this.queue.indexOf(entry), 1);
        entry.reject(this.refusal(ERRORS.stopMeanwhile));
      }
    }
    this.guardsDelete(zone);
    delete this.memory.stopGivenUp[zone];
    this.memory.pendingStops[zone] = {
      serial,
      at: mono,
      state: 'unsent',
      accepted: 0,
      refusal: null,
      notBefore: -Infinity,
      sentAt: -Infinity,
      sentSeq: this.model.seq,
      clickSeq: this.model.seq,
      clicked: received,
    };
    this.badge = undefined;
    this.saveLater();
    const outcome = this.waitStop(zone, received + TIMINGS.commandAnswerBy);
    if (!this.stopsKick) {
      // The next turn: stops clicked together (a scene) go in one change.
      this.stopsKick = sleep(this.timers, 0).then(() => {
        this.stopsKick = undefined;
        return this.runStops();
      });
      this.stopsKick.catch(() => {});
    }
    const result = await outcome;
    if (result === 'applied') return;
    throw this.refusal(result);
  }

  /** Waits for the zone read off, or the answer time: the text of why not, else 'applied'. */
  waitStop(zone, answerBy) {
    return new Promise((resolve) => {
      const waiter = {};
      const done = (value) => {
        this.timers.clearTimeout(waiter.timer);
        const list = this.stopWaiters.get(zone) ?? [];
        const i = list.indexOf(waiter);
        if (i >= 0) list.splice(i, 1);
        resolve(value);
      };
      waiter.resolve = done;
      waiter.timer = this.timers.setTimeout(
        () => {
          const pending = this.memory.pendingStops[zone];
          if (!pending) {
            const givenUp = this.memory.stopGivenUp[zone];
            done(givenUp ? ERRORS.stopGivenUp(givenUp.status) : ERRORS.stopEnded);
          } else if (pending.state === 'awaiting') {
            done(ERRORS.stopSentUnconfirmed);
          } else {
            done(ERRORS.stopKept(pending.lastReason ?? 'not sent yet'));
          }
        },
        Math.max(0, answerBy - this.mono()),
      );
      if (!this.stopWaiters.has(zone)) this.stopWaiters.set(zone, []);
      this.stopWaiters.get(zone).push(waiter);
    });
  }

  /** The stop of a zone is done: kept no more, its waiters answered. */
  stopDone(zone) {
    delete this.memory.pendingStops[zone];
    delete this.memory.stopGivenUp[zone];
    this.badge = undefined;
    this.saveLater();
    for (const waiter of [...(this.stopWaiters.get(zone) ?? [])]) waiter.resolve('applied');
  }

  /** The stops due, sent together (a scene stopping every zone: one change). */
  runStops() {
    if (this.stopsRunning) {
      this.stopsAgain = true;
      return this.stopsRunning;
    }
    this.stopsRunning = (async () => {
      try {
        do {
          this.stopsAgain = false;
          await this.sendDueStops();
        } while (this.stopsAgain);
      } finally {
        this.stopsRunning = undefined;
        this.rearmStops();
      }
    })();
    return this.stopsRunning;
  }

  /** The timer of the stops kept: their own rhythm, whatever the reads do. */
  armStopTimer(delay = TIMINGS.pendingStopRetry) {
    if (this.stopTimer) this.timers.clearTimeout(this.stopTimer);
    const generation = this.generation;
    this.stopTimer = this.timers.setTimeout(
      () => {
        this.stopTimer = undefined;
        if (generation !== this.generation) return;
        this.runStops().catch(() => this.logger.error('Lennox: sending the stops kept failed'));
      },
      Math.max(0, delay),
    );
  }

  rearmStops() {
    const mono = this.mono();
    const unsent = Object.values(this.memory.pendingStops).filter((p) => p.state === 'unsent');
    if (unsent.length === 0) return;
    const next = Math.min(...unsent.map((p) => p.notBefore));
    this.armStopTimer(
      Number.isFinite(next) && next > mono
        ? Math.max(TIMINGS.stopRetryGap, next - mono)
        : TIMINGS.pendingStopRetry,
    );
  }

  /**
   * Sends every stop due in one change (and, for the zones not known to
   * follow their manual schedule, a second one), on the link taken from
   * anything but a stop. Not sent because the thermostat could not be
   * reached, tried again within the budget of a click (250 ms apart).
   */
  async sendDueStops() {
    const generation = this.generation;
    const mono = this.mono();
    const serial = this.session.serial ?? this.memory.serial;
    const due = Object.entries(this.memory.pendingStops)
      .filter(([, p]) => p.state === 'unsent' && (p.clicked !== undefined || mono >= p.notBefore))
      .map(([z, p]) => [Number(z), p]);
    // Stops of another thermostat (read meanwhile) are not sent: dropped.
    for (const [zone, p] of due) {
      if (serial && p.serial !== serial) delete this.memory.pendingStops[zone];
    }
    const zones = due.filter(([, p]) => !serial || p.serial === serial).map(([z]) => z);
    if (zones.length === 0 || !this.address()) return;
    const clicks = zones
      .map((z) => this.memory.pendingStops[z].clicked)
      .filter((c) => c !== undefined);
    const clickBy = clicks.length > 0 ? Math.min(...clicks) + TIMINGS.commandSendBy : undefined;
    const by = clickBy ?? mono + 3 * TIMINGS.readTimeout;
    const answerBy = (clickBy ?? by) + (TIMINGS.commandAnswerBy - TIMINGS.commandSendBy);
    for (const zone of zones) delete this.memory.pendingStops[zone].clicked;
    for (;;) {
      let sent = false;
      let holder;
      try {
        holder = await this.take(KIND.STOP, by);
        if (!this.session.connected) {
          await this.connectSession(holder, by, true);
        }
        const beforeSend = () => {
          for (const zone of zones) {
            const p = this.memory.pendingStops[zone];
            if (!p || !this.isTarget(p.serial, true)) {
              throw this.refusal(ERRORS.otherThermostat);
            }
          }
        };
        const offData = dataOf({
          schedules: zones.map((z) =>
            periodPart(SCHEDULE.manual(z), { systemMode: SYSTEM_MODES.OFF }),
          ),
        });
        let answer = await this.request(holder, {
          method: 'POST',
          path: PATHS.publish,
          body: publishBody(offData),
          by,
          protective: true,
          beforeSend: () => {
            beforeSend();
            sent = true;
            this.markStopsSent(zones);
            this.logger.info(`Lennox: off, zone(s) ${zones.map((z) => z + 1).join(', ')}`);
          },
        });
        checkPublished(answer);
        const notManual = zones.filter(
          (z) => valueOf(this.model.zones.get(z)?.config.scheduleId) !== SCHEDULE.manual(z),
        );
        if (notManual.length > 0) {
          answer = await this.request(holder, {
            method: 'POST',
            path: PATHS.publish,
            body: publishBody(dataOf({ zones: notManual.map((z) => manualPart(z)) })),
            by: Math.max(by, this.mono() + TIMINGS.readTimeout),
            protective: true,
            beforeSend,
          });
          checkPublished(answer);
        }
        const accepted = this.mono();
        for (const zone of zones) {
          const p = this.memory.pendingStops[zone];
          if (!p) continue;
          p.state = 'awaiting';
          p.accepted += 1;
          p.refusal = null;
          p.sentAt = accepted;
          p.lastReason = undefined;
        }
        this.saveLater();
        this.followUp();
        // The read that may show it, if time allows and no other stop waits.
        await this.confirmReads(holder, answerBy, () =>
          zones.every((z) => !this.memory.pendingStops[z]),
        );
        return;
      } catch (err) {
        if (generation !== this.generation) return;
        const retry =
          !sent &&
          (err.kind === ERROR_KINDS.UNREACHABLE || err.kind === ERROR_KINDS.ABORTED) &&
          this.mono() + TIMINGS.stopRetryGap + TIMINGS.commandMinSend < by;
        if (retry) {
          holder?.release();
          holder = undefined;
          await sleep(this.timers, TIMINGS.stopRetryGap);
          continue;
        }
        this.stopsFailed(zones, err, sent);
        return;
      } finally {
        holder?.release();
      }
    }
  }

  /** The bookkeeping of a stop the moment it leaves (synchronous). */
  markStopsSent(zones) {
    for (const zone of zones) {
      const p = this.memory.pendingStops[zone];
      if (p) p.sentSeq = this.model.seq;
    }
  }

  /**
   * A stop that failed: kept (not sent, a cut, a silence, a 429/5xx: no
   * count), or refused by the thermostat (a 4xx, a code other than 1):
   * counted, given up after 3 identical refusals in a row (said in the
   * status, the badge and the answer of a click).
   */
  stopsFailed(zones, err, sent) {
    const reason = reasonOf(err);
    const mono = this.mono();
    const answered =
      err.kind === ERROR_KINDS.RATE_LIMITED || (err.kind === ERROR_KINDS.HTTP && err.status >= 500);
    if (answered) {
      this.pauseFor(err).catch(() => {});
    }
    for (const zone of zones) {
      const p = this.memory.pendingStops[zone];
      if (!p) continue;
      p.state = 'unsent';
      p.lastReason = reason;
      if (sent && err.kind === ERROR_KINDS.REJECTED) {
        const status = String(err.status ?? 'refused').slice(0, 20);
        const count = p.refusal?.status === status ? p.refusal.count + 1 : 1;
        if (count >= TIMINGS.stopRefusalsMax) {
          delete this.memory.pendingStops[zone];
          this.memory.stopGivenUp[zone] = { serial: p.serial, status };
          this.logger.warn(
            `Lennox: off of zone ${zone + 1} refused ${count} times (${reason}), given up`,
          );
          continue;
        }
        p.refusal = { status, count };
        p.notBefore = mono + TIMINGS.pendingStopWaitMax;
      } else if (answered) {
        p.notBefore =
          mono +
          Math.min(
            TIMINGS.pendingStopWaitMax,
            Math.max(TIMINGS.pendingStopRetry, err.retryAfter ?? TIMINGS.pendingStopRetry),
          );
      } else {
        p.notBefore = mono + TIMINGS.pendingStopRetry;
      }
    }
    if (
      [ERROR_KINDS.UNREACHABLE, ERROR_KINDS.TIMEOUT, ERROR_KINDS.LATE].includes(err.kind) &&
      this.reader.online !== false
    ) {
      this.reader.online = false;
      this.reader.error = ERROR_KINDS.UNREACHABLE;
      this.reader.wait = this.reader.wait ?? this.interval;
      this.session.connected = false;
    }
    this.logger.warn(`Lennox: off not applied (${reason}), kept to be sent again`);
    this.badge = undefined;
    this.saveLater();
    this.publishAll().catch(() => {});
  }

  /**
   * The reads seen by the stops kept: the zone read off after the click is
   * done; a stop accepted then read not off (5 s after it at least) is sent
   * again, 3 accepted sends at most, then given up.
   */
  watchStops() {
    const serial = this.session.serial;
    const mono = this.mono();
    let again = false;
    for (const [z, p] of Object.entries(this.memory.pendingStops)) {
      const zone = Number(z);
      if (serial && p.serial !== serial) continue;
      const mode = this.model.zones.get(zone)?.period.systemMode;
      if (!mode) continue;
      if (mode.value === SYSTEM_MODES.OFF && mode.seq > Math.min(p.clickSeq, p.sentSeq)) {
        this.logger.info(`Lennox: zone ${zone + 1} reads off`);
        this.stopDone(zone);
        continue;
      }
      if (
        p.state === 'awaiting' &&
        mode.value !== SYSTEM_MODES.OFF &&
        mode.seq > p.sentSeq &&
        mono - p.sentAt >= STOP_GRACE
      ) {
        if (p.accepted >= TIMINGS.stopRefusalsMax) {
          delete this.memory.pendingStops[zone];
          this.memory.stopGivenUp[zone] = { serial: p.serial, status: 'not applied' };
          this.logger.warn(
            `Lennox: off of zone ${zone + 1} accepted ${p.accepted} times, never read off: given up`,
          );
          this.badge = undefined;
          for (const waiter of [...(this.stopWaiters.get(zone) ?? [])]) {
            waiter.resolve(ERRORS.stopGivenUp('not applied'));
          }
          continue;
        }
        this.logger.warn(`Lennox: zone ${zone + 1} not off after an accepted off, sent again`);
        p.state = 'unsent';
        p.notBefore = -Infinity;
        again = true;
      }
    }
    this.saveLater();
    if (again) {
      this.runStops().catch(() => {});
    }
  }

  // --- Other commands ------------------------------------------------------------------

  /**
   * A command of a zone: one at a time per zone, then in the next round with
   * the others arrived meanwhile.
   */
  async command(entry) {
    const { zone, change } = entry;
    if (this.inFlight.has(zone)) {
      throw this.refusal(ERRORS.stillRunning);
    }
    const isMode = change.mode !== undefined;
    if (this.memory.pendingStops[zone] && !isMode) {
      throw this.refusal(ERRORS.stopInProgress);
    }
    if (this.guardActive(zone)) {
      throw this.refusal(ERRORS.notSeenYet);
    }
    entry.epoch = this.stopEpochs.get(zone) ?? 0;
    entry.promise = new Promise((resolve, reject) => {
      entry.resolve = resolve;
      entry.reject = reject;
    });
    this.inFlight.set(zone, entry);
    this.queue.push(entry);
    if (!this.roundRunning) {
      // The next turn: commands clicked together (a scene) share the round.
      this.roundRunning = sleep(this.timers, 0)
        .then(() => this.runRounds())
        .finally(() => {
          this.roundRunning = undefined;
        });
    }
    try {
      return await entry.promise;
    } finally {
      if (this.inFlight.get(zone) === entry) this.inFlight.delete(zone);
    }
  }

  async runRounds() {
    while (this.queue.length > 0) {
      const entries = this.queue.splice(0);
      await this.round(entries).catch((err) => {
        for (const e of entries) e.reject(err);
      });
    }
  }

  /** The checks right before the bytes go (and on arrival). */
  checkCommand(entry, generation) {
    if (generation !== this.generation) throw this.refusal(ERRORS.configChanged);
    if (!this.config?.allowCommands) throw this.refusal(ERRORS.disabled);
    if ((this.stopEpochs.get(entry.zone) ?? 0) !== entry.epoch) {
      throw this.refusal(ERRORS.stopMeanwhile);
    }
    if (this.memory.pendingStops[entry.zone] && entry.change.mode === undefined) {
      throw this.refusal(ERRORS.stopInProgress);
    }
    if (this.session.serial !== entry.serial) throw this.refusal(ERRORS.otherThermostat);
    const mono = this.mono();
    if (this.paused(mono)) throw this.refusal(ERRORS.paused(age(this.memory.pause.until - mono)));
    if (mono > entry.received + TIMINGS.commandSendBy) throw this.refusal(ERRORS.tooSlow);
  }

  /**
   * The schedule the changes of a zone go to, and the parts to write:
   * manual schedule followed -> it; an override held -> it; else a new
   * override copied from the period read, then held (lennoxs30api).
   */
  targetParts(zone, fields) {
    const z = zone.id;
    const scheduleId = valueOf(zone.config.scheduleId);
    if (scheduleId === undefined) return { error: ERRORS.missing };
    if (scheduleId === SCHEDULE.manual(z)) {
      return { schedules: [periodPart(SCHEDULE.manual(z), fields)], zones: [] };
    }
    const held =
      scheduleId === SCHEDULE.override(z) ||
      (valueOf(zone.config.holdEnabled) === true &&
        valueOf(zone.config.holdScheduleId) === SCHEDULE.override(z));
    if (held) {
      return { schedules: [periodPart(SCHEDULE.override(z), fields)], zones: [] };
    }
    const full = {};
    for (const key of OVERRIDE_FIELDS) {
      const value = valueOf(zone.period[key]);
      if (value === undefined) return { error: ERRORS.missing };
      full[key] = value;
    }
    return {
      schedules: [periodPart(SCHEDULE.override(z), { ...full, ...fields })],
      zones: [holdPart(z)],
    };
  }

  /**
   * What a command writes, from the queue emptied after its click:
   * `{ schedules, zones, expect }`, `{ same: true }`, or a refusal thrown.
   */
  plan(entry) {
    const { zone: z, change } = entry;
    const zone = this.model.zones.get(z);
    if (!zone || !zoneInUse(this.model, z) || !valueOf(zone.config.name)) {
      throw this.refusal(ERRORS.unknownZone);
    }
    const away = awayOf(this.model);
    if (away === undefined) throw this.refusal(ERRORS.missing);
    if (away) throw this.refusal(ERRORS.away);
    if (change.mode !== undefined) {
      const can = offers(zone);
      const key = { heat: 'heat', cool: 'cool', 'heat and cool': 'auto' }[change.mode];
      if (!can[key]) throw this.refusal(ERRORS.modeNotOffered);
      const now = valueOf(zone.period.systemMode);
      if (now === undefined) throw this.refusal(ERRORS.missing);
      const manual = valueOf(zone.config.scheduleId) === SCHEDULE.manual(z);
      // Already so, unless an Off of the zone is kept: this newer mode must leave to end it.
      if (now === change.mode && manual && !this.memory.pendingStops[z]) return { same: true };
      return {
        schedules: [periodPart(SCHEDULE.manual(z), { systemMode: change.mode })],
        zones: manual ? [] : [manualPart(z)],
        expect: { systemMode: change.mode },
      };
    }
    if (change.fan !== undefined) {
      const now = valueOf(zone.period.fanMode);
      if (now === undefined) throw this.refusal(ERRORS.missing);
      if (now === change.fan) return { same: true };
      const parts = this.targetParts(zone, { fanMode: change.fan });
      if (parts.error) throw this.refusal(parts.error);
      return { ...parts, expect: { fanMode: change.fan } };
    }
    // A setpoint.
    if (valueOf(this.model.system.singleSetpoint) === true) {
      throw this.refusal(ERRORS.singleSetpoint);
    }
    const created = this.createdFeatures().get(entry.feature?.external_id);
    const unit = apiUnitOf(created?.unit ?? entry.feature?.unit) ?? valueOf(this.model.system.unit);
    if (!unit) throw this.refusal(ERRORS.missing);
    const planned = planSetpoint(zone, change.setpoint, change.asked, unit);
    if (planned.error === 'range') {
      throw this.refusal(
        planned.range
          ? ERRORS.outOfRange(planned.range.min, planned.range.max, unit)
          : ERRORS.missing,
      );
    }
    if (planned.error === 'deadband') throw this.refusal(ERRORS.deadband);
    if (planned.error) throw this.refusal(ERRORS.missing);
    if (planned.same) return { same: true };
    const parts = this.targetParts(zone, planned.fields);
    if (parts.error) throw this.refusal(parts.error);
    return { ...parts, expect: planned.fields };
  }

  /**
   * One round: the link (taken from a read), the queue emptied after every
   * click of the round, the plans, the guards kept in /data BEFORE the first
   * byte, one change for all (a second one for the zones that must follow
   * their manual schedule or hold their override), then the reads that show
   * them.
   */
  async round(entries) {
    const generation = this.generation;
    const first = Math.min(...entries.map((e) => e.received));
    const sendBy = first + TIMINGS.commandSendBy;
    const answerBy = first + TIMINGS.commandAnswerBy;
    let holder;
    let live = [];
    try {
      // Each command checked on its own: one refused never holds back the others.
      entries = entries.filter((e) => {
        try {
          this.checkCommand(e, generation);
          return true;
        } catch (err) {
          e.reject(err);
          return false;
        }
      });
      if (entries.length === 0) return;
      holder = await this.take(KIND.COMMAND, sendBy - TIMINGS.commandMinSend);
      if (!this.session.connected || this.session.serial === undefined) {
        throw this.refusal(ERRORS.notReadYet);
      }
      await this.drain(holder, sendBy - TIMINGS.commandMinSend);
      for (const e of entries) {
        try {
          this.checkCommand(e, generation);
          const plan = this.plan(e);
          if (plan.same) {
            e.resolve();
            continue;
          }
          e.plan = plan;
          live.push(e);
        } catch (err) {
          e.reject(err.refusal ? err : this.refusal(ERRORS.unknownState(reasonOf(err))));
        }
      }
      if (live.length === 0) return;
      // The guards of the zones, in /data before the first byte.
      const until = this.mono() + TIMINGS.guard;
      for (const e of live) {
        this.memory.guards[e.zone] = { expect: e.plan.expect, until, sentSeq: this.model.seq };
      }
      if (!(await this.saveMemory())) {
        for (const e of live) delete this.memory.guards[e.zone];
        throw this.refusal(ERRORS.storageWrite);
      }
      const check = () => {
        for (const e of live) this.checkCommand(e, generation);
      };
      const schedules = live.flatMap((e) => e.plan.schedules);
      const zones = live.flatMap((e) => e.plan.zones);
      for (const [index, data] of [dataOf({ schedules }), dataOf({ zones })].entries()) {
        if (!data) continue;
        const answer = await this.request(holder, {
          method: 'POST',
          path: PATHS.publish,
          body: publishBody(data),
          by: index === 0 ? sendBy : answerBy,
          beforeSend: () => {
            check();
            if (index === 0) this.markCommandsSent(live);
          },
        });
        checkPublished(answer);
      }
      const confirmed = () => live.every((e) => this.shows(e));
      await this.confirmReads(holder, answerBy, confirmed);
      for (const e of live) {
        if (this.shows(e)) {
          delete this.memory.guards[e.zone];
          e.resolve();
        } else {
          e.reject(this.refusal(this.before(e) ? ERRORS.notYetApplied : ERRORS.sentUnconfirmed));
        }
      }
      this.saveLater();
      this.followUp();
    } catch (err) {
      for (const e of live.length > 0 ? live : entries) {
        const sent = e.sentAt !== undefined;
        if (!sent) delete this.memory.guards[e.zone];
        if (err.refusal) {
          e.reject(err);
        } else if (!sent || notSent(err)) {
          e.reject(
            this.refusal(
              err.kind === ERROR_KINDS.ABORTED
                ? ERRORS.stopMeanwhile
                : ERRORS.notSent(reasonOf(err)),
            ),
          );
        } else if (err.kind === ERROR_KINDS.REJECTED) {
          delete this.memory.guards[e.zone];
          e.reject(this.refusal(ERRORS.refused(reasonOf(err))));
        } else {
          e.reject(this.refusal(ERRORS.sentUnconfirmed));
        }
      }
      if (
        err.kind === ERROR_KINDS.RATE_LIMITED ||
        (err.kind === ERROR_KINDS.HTTP && err.status >= 500)
      ) {
        await this.pauseFor(err);
      }
      if (live.some((e) => e.sentAt !== undefined)) this.followUp();
      this.saveLater();
    } finally {
      holder?.release();
    }
  }

  /** The bookkeeping of a change the moment it leaves (synchronous: nothing awaited). */
  markCommandsSent(live) {
    const mono = this.mono();
    for (const e of live) {
      e.sentAt = mono;
      e.sentSeq = this.model.seq;
      const guard = this.memory.guards[e.zone];
      if (guard) guard.sentSeq = e.sentSeq;
      if (e.change.mode !== undefined && this.memory.pendingStops[e.zone]) {
        // A newer mode that left Gladys (a click with the option) ends the stop kept.
        delete this.memory.pendingStops[e.zone];
        for (const waiter of [...(this.stopWaiters.get(e.zone) ?? [])]) {
          waiter.resolve(ERRORS.stopEnded);
        }
      }
    }
    this.saveLater();
  }

  /** The zone shows what the command asked, read after it left. */
  shows(e) {
    const period = this.model.zones.get(e.zone)?.period ?? {};
    return Object.entries(e.plan.expect).every(
      ([key, value]) => period[key]?.value === value && period[key].seq > e.sentSeq,
    );
  }

  /** Read after it left, still the value before. */
  before(e) {
    const period = this.model.zones.get(e.zone)?.period ?? {};
    return Object.keys(e.plan.expect).some((key) => period[key]?.seq > e.sentSeq);
  }

  guardActive(zone) {
    const guard = this.memory.guards[zone];
    if (!guard) return false;
    if (this.mono() >= guard.until) {
      this.guardsDelete(zone);
      return false;
    }
    return true;
  }

  guardsDelete(zone) {
    if (this.memory.guards[zone]) {
      delete this.memory.guards[zone];
      this.saveLater();
    }
  }

  /** A guard is lifted by a read (after its send) showing every value asked. */
  watchGuards() {
    for (const [z, guard] of Object.entries(this.memory.guards)) {
      const zone = Number(z);
      if (this.inFlight.has(zone)) continue;
      const period = this.model.zones.get(zone)?.period ?? {};
      const seen = Object.entries(guard.expect ?? {}).every(
        ([key, value]) => period[key]?.value === value && period[key].seq > guard.sentSeq,
      );
      if (seen || this.mono() >= guard.until) this.guardsDelete(zone);
    }
  }
}

/** A short reason of a failure, without any byte of an answer. */
export function reasonOf(err) {
  if (!err) return 'error';
  if (err.refusal) return 'refused';
  switch (err.kind) {
    case ERROR_KINDS.UNREACHABLE:
      return 'unreachable';
    case ERROR_KINDS.TIMEOUT:
      return 'no answer';
    case ERROR_KINDS.LATE:
      return 'too late';
    case ERROR_KINDS.CERTIFICATE:
      return 'certificate changed';
    case ERROR_KINDS.STORAGE:
      return '/data not writable';
    case ERROR_KINDS.ABORTED:
      return 'given up';
    case ERROR_KINDS.STALE:
      return 'configuration changed';
    case ERROR_KINDS.HTTP:
    case ERROR_KINDS.REJECTED:
    case ERROR_KINDS.RATE_LIMITED:
      return typeof err.status === 'number'
        ? `HTTP ${err.status}`
        : String(err.status ?? 'refused');
    case ERROR_KINDS.PROTOCOL:
      return 'unexpected answer';
    default:
      return 'error';
  }
}

export { ZONES };
