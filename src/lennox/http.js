// -----------------------------------------------------------------------------
// The only network access of the integration: one HTTPS request on its own
// TLS connection, opened, checked, used once and closed. The app runs one
// request at a time, so the thermostat never sees two connections of the
// integration at once.
//
// TLS: the thermostat serves a self-signed certificate, so no authority can
// vouch for it. The connection resolves once the handshake is done, with the
// SHA-256 fingerprint of the certificate; NOTHING is written before the
// caller checked it against the pin (`trust`, src/app.js): no change ever
// reaches another device, and no byte of an answer is read before (an
// impostor writing first is never parsed). `rejectUnauthorized: false` is
// safe only with that check. TLS 1.2 at least; the cipher list at security
// level 1 for older embedded TLS (the pin, not an authority, vouches for the
// thermostat).
//
// Bounded: the time of the whole exchange, the size of the status line and
// the headers (8 KB), of the body (2 MB). The answer is parsed in one pass
// over the bytes as they come; chunked bodies are supported. No redirect is
// ever followed. Every failure is a LennoxError whose kind says whether the
// request may have reached the thermostat; its message never holds the address,
// a header nor any byte of the answer.
// -----------------------------------------------------------------------------

import { isIP } from 'node:net';
import tls from 'node:tls';
import { LIMITS } from '../constants.js';

/** The kinds of failure the rest of the code tells apart. */
export const ERROR_KINDS = Object.freeze({
  /** Nothing accepted the connection (TLS included). Nothing was sent. */
  UNREACHABLE: 'unreachable',
  /** Connected, then silent or cut: the request may have been received. */
  TIMEOUT: 'timeout',
  /** An HTTP status that is not handled more precisely (`status` holds it). */
  HTTP: 'http',
  /** 429 (`retryAfter` in ms when the thermostat gave one). */
  RATE_LIMITED: 'rate_limited',
  /** Too large, not HTTP, not JSON, not the expected shape. */
  PROTOCOL: 'protocol',
  /** The certificate is not the one pinned (`fingerprint` holds the new one). Nothing was sent. */
  CERTIFICATE: 'certificate_changed',
  /** Another thermostat answers at the address. Nothing was sent. */
  OTHER_DEVICE: 'other_device',
  /** The time a command was given ran out before its request: nothing was sent. */
  LATE: 'late',
  /** The connection was closed by us (a stop took the thermostat). */
  ABORTED: 'aborted',
  /** A change refused by the thermostat (a 4xx, or an answer other than code 1). */
  REJECTED: 'rejected',
  /** The session belongs to a configuration replaced meanwhile: given up, nothing written. */
  STALE: 'stale',
  /** The first pin could not be kept in /data: nothing is read nor sent. */
  STORAGE: 'storage',
});

export class LennoxError extends Error {
  constructor(kind, message, details = {}) {
    super(message);
    this.name = 'LennoxError';
    this.kind = kind;
    for (const [key, value] of Object.entries(details)) {
      this[key] = value;
    }
  }
}

/** Whether a failure says for sure that nothing reached the thermostat. */
export const notSent = (err) =>
  err?.notSent === true ||
  [
    ERROR_KINDS.UNREACHABLE,
    ERROR_KINDS.LATE,
    ERROR_KINDS.CERTIFICATE,
    ERROR_KINDS.OTHER_DEVICE,
    ERROR_KINDS.STALE,
    ERROR_KINDS.STORAGE,
  ].includes(err?.kind);

const CRLF = Buffer.from('\r\n\r\n');
const code = (err) => (/^[A-Z0-9_]{1,40}$/.test(String(err?.code ?? '')) ? err.code : 'error');

/** The fingerprint as Node prints it: "AB:CD:…", upper case. */
export const normalizeFingerprint = (value) =>
  typeof value === 'string' && /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/i.test(value.trim())
    ? value.trim().toUpperCase()
    : undefined;

/**
 * A parser of ONE HTTP/1.1 answer, fed with the chunks as they come. Linear:
 * the head is searched in at most 8 KB (kept in a buffer capped to that
 * size), the body bytes are copied once into a list of slices.
 */
export class AnswerParser {
  constructor({ maxBytes = LIMITS.responseBytes, headerBytes = LIMITS.headerBytes } = {}) {
    this.maxBytes = maxBytes;
    this.headerBytes = headerBytes;
    this.head = Buffer.alloc(0);
    this.phase = 'head';
    this.status = 0;
    this.headers = {};
    this.parts = [];
    this.size = 0;
    this.remaining = 0;
    this.chunkLine = '';
    this.untilClose = false;
    this.done = false;
    this.keepAlive = true;
  }

  fail(message) {
    throw new LennoxError(ERROR_KINDS.PROTOCOL, message);
  }

  /** Feeds bytes; returns true once the answer is complete. */
  push(chunk) {
    let offset = 0;
    if (this.phase === 'head') {
      // Only the bytes that may hold the head are joined (8 KB at most).
      const room = this.headerBytes - this.head.length;
      const take = chunk.subarray(0, Math.max(0, room));
      const joined = Buffer.concat([this.head, take]);
      const end = joined.indexOf(CRLF);
      if (end === -1) {
        if (joined.length >= this.headerBytes) this.fail('Head too large');
        this.head = joined;
        return false;
      }
      offset = end + 4 - this.head.length;
      this.head = Buffer.alloc(0);
      if (this.parseHead(joined.subarray(0, end).toString('latin1')) === 'interim') {
        // A 1xx answer (100 Continue…) is not the answer: skipped, 4 at most.
        this.interims = (this.interims ?? 0) + 1;
        if (this.interims > 4) this.fail('Too many interim answers');
        return this.push(chunk.subarray(offset));
      }
    }
    this.feed(chunk, offset);
    return this.done;
  }

  parseHead(text) {
    const lines = text.split('\r\n');
    const status = /^HTTP\/1\.[01] (\d{3})(?: .*)?$/.exec(lines[0]);
    if (!status) this.fail('Not HTTP');
    this.status = Number(status[1]);
    const headers = Object.create(null);
    for (const line of lines.slice(1)) {
      const at = line.indexOf(':');
      if (at <= 0) this.fail('Bad header');
      const name = line.slice(0, at).trim().toLowerCase();
      if (!/^[a-z0-9-]{1,64}$/.test(name)) this.fail('Bad header');
      headers[name] = line.slice(at + 1).trim();
    }
    if (this.status >= 100 && this.status < 200 && this.status !== 101) {
      this.status = 0;
      return 'interim';
    }
    this.headers = headers;
    const connection = String(headers.connection ?? '').toLowerCase();
    this.keepAlive = connection !== 'close';
    const encoding = String(headers['transfer-encoding'] ?? '').toLowerCase();
    if (this.status === 204 || this.status === 304 || (this.status >= 100 && this.status < 200)) {
      this.phase = 'body';
      this.remaining = 0;
      this.done = true;
      return;
    }
    if (encoding.includes('chunked')) {
      this.phase = 'size';
      return;
    }
    if (headers['content-length'] !== undefined) {
      if (!/^\d{1,9}$/.test(headers['content-length'])) this.fail('Bad length');
      this.remaining = Number(headers['content-length']);
      if (this.remaining > this.maxBytes) this.fail('Answer too large');
      this.phase = 'body';
      this.done = this.remaining === 0;
      return;
    }
    // Neither: the body ends with the connection.
    this.phase = 'body';
    this.untilClose = true;
    this.keepAlive = false;
  }

  take(slice) {
    this.size += slice.length;
    if (this.size > this.maxBytes) this.fail('Answer too large');
    this.parts.push(slice);
  }

  feed(chunk, offset) {
    let i = offset;
    while (i < chunk.length && !this.done) {
      if (this.phase === 'body') {
        if (this.untilClose) {
          this.take(chunk.subarray(i));
          return;
        }
        const n = Math.min(this.remaining, chunk.length - i);
        this.take(chunk.subarray(i, i + n));
        this.remaining -= n;
        i += n;
        if (this.remaining === 0) this.done = true;
      } else if (this.phase === 'size' || this.phase === 'trailer' || this.phase === 'dataEnd') {
        // One line, byte by byte (bounded to 64 characters).
        const byte = chunk[i];
        i += 1;
        if (byte !== 0x0a) {
          this.chunkLine += String.fromCharCode(byte);
          if (this.chunkLine.length > 64) this.fail('Bad chunk');
          continue;
        }
        const line = this.chunkLine.replace(/\r$/, '');
        this.chunkLine = '';
        if (this.phase === 'dataEnd') {
          if (line !== '') this.fail('Bad chunk');
          this.phase = 'size';
        } else if (this.phase === 'trailer') {
          if (line === '') this.done = true;
        } else {
          const size = /^([0-9a-f]{1,8})(?:;.*)?$/i.exec(line);
          if (!size) this.fail('Bad chunk');
          const n = parseInt(size[1], 16);
          if (n === 0) {
            this.phase = 'trailer';
          } else {
            if (this.size + n > this.maxBytes) this.fail('Answer too large');
            this.remaining = n;
            this.phase = 'data';
          }
        }
      } else if (this.phase === 'data') {
        const n = Math.min(this.remaining, chunk.length - i);
        this.take(chunk.subarray(i, i + n));
        this.remaining -= n;
        i += n;
        if (this.remaining === 0) this.phase = 'dataEnd';
      }
    }
  }

  /** The connection ended: an answer read until the close is complete then. */
  end() {
    if (this.phase === 'body' && this.untilClose) {
      this.done = true;
    }
    return this.done;
  }

  result() {
    return {
      status: this.status,
      headers: this.headers,
      body: Buffer.concat(this.parts, this.size).toString('utf8'),
    };
  }
}

/**
 * Opens the TLS connection. Resolves `{ fingerprint, request, close, closed }`
 * once the handshake is done; nothing is written by this function, and no
 * byte the thermostat writes before a request is ever parsed.
 * @param {{ host: string, port: number, timeoutMs: number }} options
 */
export function openConnection({ host, port, timeoutMs, onSocket }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let socket;
    // Given up during the handshake (a stop): the socket destroyed at once.
    onSocket?.(
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const aborted = () =>
          reject(new LennoxError(ERROR_KINDS.ABORTED, 'Session given up', { notSent: true }));
        if (!socket || socket.destroyed) {
          aborted();
          return;
        }
        // Settled once the socket is really closed: the next connection opens after it.
        socket.once('close', aborted);
        socket.destroy();
      },
      () => socket,
    );
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket?.destroy();
      reject(new LennoxError(ERROR_KINDS.UNREACHABLE, 'Unreachable: timeout'));
    }, timeoutMs);
    try {
      socket = tls.connect({
        host,
        port,
        servername: isIP(host) ? undefined : host,
        rejectUnauthorized: false,
        minVersion: 'TLSv1.2',
        ciphers: 'DEFAULT@SECLEVEL=1',
      });
    } catch (err) {
      clearTimeout(timer);
      reject(new LennoxError(ERROR_KINDS.UNREACHABLE, `Unreachable: ${code(err)}`));
      return;
    }
    socket.once('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(new LennoxError(ERROR_KINDS.UNREACHABLE, `Unreachable: ${code(err)}`));
    });
    socket.once('secureConnect', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const fingerprint = normalizeFingerprint(socket.getPeerCertificate()?.fingerprint256);
      if (!fingerprint) {
        socket.destroy();
        reject(new LennoxError(ERROR_KINDS.CERTIFICATE, 'No certificate', { notSent: true }));
        return;
      }
      resolve(connectionOn(socket, host, fingerprint));
    });
  });
}

/** The ONE request of a connection, on the socket given (bytes read only once it is written). */
export function connectionOn(socket, host, fingerprint) {
  let closed = false;
  let current;
  let used = false;
  const onClose = () => {
    closed = true;
    current?.ended();
  };
  socket.on('close', onClose);
  socket.on('end', onClose);
  socket.on('error', () => {
    closed = true;
    current?.ended();
  });
  // What the thermostat writes before our request (an impostor) is dropped unread.
  socket.on('data', (chunk) => current?.data(chunk));

  return {
    fingerprint,
    get closed() {
      return closed;
    },
    /** Destroys the connection: a request under way fails (ABORTED). */
    close() {
      closed = true;
      current?.aborted();
      socket.destroy();
    },
    /**
     * The request. `beforeSend()` runs right before the bytes are written:
     * what it throws is rethrown marked `notSent`.
     * @returns {Promise<{ status: number, headers: object, body: string }>}
     */
    request({ method, path, headers = {}, body, contentType, timeoutMs, beforeSend }) {
      return new Promise((resolve, reject) => {
        if (used || closed) {
          reject(new LennoxError(ERROR_KINDS.ABORTED, 'Connection closed', { notSent: true }));
          return;
        }
        used = true;
        let sent = false;
        const parser = new AnswerParser();
        const finish = (error, value) => {
          if (current !== state) return;
          current = undefined;
          clearTimeout(timer);
          closed = true;
          socket.destroy();
          if (error) reject(error);
          else resolve(value);
        };
        const state = {
          data(chunk) {
            if (!sent) return;
            try {
              if (parser.push(chunk)) finish(null, parser.result());
            } catch (err) {
              finish(err);
            }
          },
          ended() {
            if (sent && parser.end()) finish(null, parser.result());
            else
              finish(
                sent
                  ? new LennoxError(ERROR_KINDS.TIMEOUT, 'Connection lost')
                  : new LennoxError(ERROR_KINDS.UNREACHABLE, 'Connection closed', {
                      notSent: true,
                    }),
              );
          },
          aborted() {
            finish(new LennoxError(ERROR_KINDS.ABORTED, 'Session given up', { notSent: !sent }));
          },
        };
        current = state;
        const timer = setTimeout(
          () =>
            finish(
              sent
                ? new LennoxError(ERROR_KINDS.TIMEOUT, 'Connected but silent: timeout')
                : new LennoxError(ERROR_KINDS.LATE, 'No time left', { notSent: true }),
            ),
          Math.max(1, timeoutMs),
        );
        try {
          beforeSend?.();
        } catch (err) {
          finish(Object.assign(err, { notSent: true, beforeSend: true }));
          return;
        }
        const payload = body === undefined ? undefined : Buffer.from(body, 'utf8');
        const lines = [
          `${method} ${path} HTTP/1.1`,
          `Host: ${host.includes(':') ? `[${host}]` : host}`,
          'Connection: close',
          'Accept: application/json',
          ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
          ...(payload
            ? [
                `Content-Type: ${contentType ?? 'application/json'}`,
                `Content-Length: ${payload.length}`,
              ]
            : ['Content-Length: 0']),
        ];
        if (lines.some((line) => /[\r\n]/.test(line))) {
          finish(new LennoxError(ERROR_KINDS.PROTOCOL, 'Bad header', { notSent: true }));
          return;
        }
        sent = true;
        const head = Buffer.from(`${lines.join('\r\n')}\r\n\r\n`, 'latin1');
        socket.write(payload ? Buffer.concat([head, payload]) : head);
      });
    },
  };
}

/**
 * One exchange: a new connection, the certificate checked by `trust` (it
 * throws to refuse it) BEFORE anything is written, one request, the
 * connection closed. `onOpen(connection)` lets the app give it up (a stop).
 * The whole exchange ends within `timeoutMs`.
 */
export async function exchange({ host, port, timeoutMs, trust, onOpen, ...request }) {
  const started = performance.now();
  const left = () => timeoutMs - (performance.now() - started);
  // The handle the app may close from the first moment (the TCP and TLS
  // handshake included): never a second connection while one is still opening.
  let abort;
  const handle = {
    closed: false,
    close() {
      if (handle.closed) return;
      handle.closed = true;
      abort?.();
    },
  };
  onOpen?.(handle);
  if (handle.closed) {
    throw new LennoxError(ERROR_KINDS.ABORTED, 'Session given up', { notSent: true });
  }
  const connection = await openConnection({
    host,
    port,
    timeoutMs: Math.max(1, left()),
    onSocket: (fn) => {
      abort = fn;
    },
  });
  abort = () => connection.close();
  try {
    if (handle.closed || connection.closed) {
      throw new LennoxError(ERROR_KINDS.ABORTED, 'Session given up', { notSent: true });
    }
    await trust(connection.fingerprint);
    if (connection.closed) {
      throw new LennoxError(ERROR_KINDS.ABORTED, 'Session given up', { notSent: true });
    }
    if (left() <= 0) {
      throw new LennoxError(ERROR_KINDS.LATE, 'No time left', { notSent: true });
    }
    return await connection.request({ ...request, timeoutMs: left() });
  } finally {
    connection.close();
  }
}
