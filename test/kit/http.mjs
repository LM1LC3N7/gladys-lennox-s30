// A fake HTTP(S) device on 127.0.0.1: routes, latency, a delayed effect of
// the writes, 5xx on demand, an oversized body; every request recorded. And
// an impostor: another certificate, an answer sent before any request.

import { createServer as createHttp } from 'node:http';
import { createServer as createHttps } from 'node:https';
import { createServer as createTls } from 'node:tls';
import { certs } from './certs.mjs';
import { HOST, closed, isAbort, listen, sleep, valueOf } from './util.mjs';

const REPLY = Symbol('reply');

/** An answer with a status, headers, a body (object -> JSON, string or Buffer as is). */
export const reply = (status, body = '', headers = {}) => ({
  [REPLY]: true,
  status,
  body,
  headers,
});

const parse = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/**
 * Options (all may be changed later on the returned object):
 * - routes: { 'GET /path' | '/path': value | (request, server) => value } where
 *   value is an object (JSON 200), reply(...), 'silent' (never answers),
 *   'drop' (socket destroyed) or undefined (404);
 * - latencyMs: number or (request) => number, before any answer;
 * - applyDelayMs: the delay of `server.apply(fn)` (the effect of a write, after its ack);
 * - status5xx: the next this many requests get a 503;
 * - bigBody: this many bytes of blanks before each answer body.
 */
export function httpServer(options = {}) {
  return start((handler) => createHttp(handler), options, 'http');
}

/**
 * As httpServer, over TLS: `cert` ({ key, cert }) defaults to certs.device.
 * `impostor: true` (or { body, cert }) gives an impostorServer instead.
 */
export function httpsServer({ cert = certs.device, impostor, ...options } = {}) {
  if (impostor)
    return impostorServer({ port: options.port, ...(impostor === true ? {} : impostor) });
  return start(
    (handler) => createHttps({ key: cert.key, cert: cert.cert }, handler),
    options,
    'https',
    cert,
  );
}

async function start(create, options, scheme, cert) {
  const abort = new AbortController();
  const srv = {
    routes: {},
    latencyMs: 0,
    applyDelayMs: 0,
    status5xx: 0,
    bigBody: 0,
    ...options,
    host: HOST,
    port: 0,
    url: '',
    cert,
    /** { at, method, url, path, query, headers, body (text), json }. */
    requests: [],
    /** Requests matching 'METHOD /path', '/path' or a RegExp on 'METHOD /path'. */
    count: (match) =>
      srv.requests.filter((r) =>
        match instanceof RegExp
          ? match.test(`${r.method} ${r.path}`)
          : [r.path, `${r.method} ${r.path}`].includes(match),
      ).length,
    /** Runs fn after applyDelayMs (a device that acks first, applies later). */
    apply(fn) {
      sleep(srv.applyDelayMs, abort.signal).then(fn, () => {});
    },
    async close() {
      abort.abort();
      server.closeAllConnections();
      await closed(server);
    },
  };

  const handle = async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString('utf8');
    const url = new URL(req.url, `${scheme}://${HOST}`);
    const request = {
      at: performance.now(),
      method: req.method,
      url: req.url,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: req.headers,
      body,
      json: parse(body),
    };
    srv.requests.push(request);
    await sleep(valueOf(srv.latencyMs, request), abort.signal);
    if (srv.status5xx > 0) {
      srv.status5xx -= 1;
      return send(res, reply(503, { error: 'unavailable' }));
    }
    const route = srv.routes[`${req.method} ${url.pathname}`] ?? srv.routes[url.pathname];
    const answer = typeof route === 'function' ? await route(request, srv) : route;
    if (answer === 'silent') return undefined;
    if (answer === 'drop') return req.socket.destroy();
    if (answer === undefined) return send(res, reply(404, 'not found'));
    return send(res, answer?.[REPLY] ? answer : reply(200, answer));
  };

  const send = (res, { status, body, headers }) => {
    const text = typeof body === 'string' || Buffer.isBuffer(body);
    const payload = Buffer.from(text ? body : JSON.stringify(body));
    const type = text ? 'text/plain' : 'application/json';
    res.writeHead(status, { 'content-type': type, ...headers });
    if (srv.bigBody > 0) res.write(Buffer.alloc(srv.bigBody, 0x20));
    res.end(payload);
  };

  const server = create((req, res) => {
    res.on('error', () => {});
    handle(req, res).catch((err) => {
      if (isAbort(err) || res.headersSent) return;
      res.writeHead(500).end(String(err));
    });
  });
  server.on('clientError', (err, socket) => socket.destroy());
  srv.port = await listen(server, options.port);
  srv.url = `${scheme}://${HOST}:${srv.port}`;
  return srv;
}

/**
 * A TLS impostor: another certificate (certs.impostor by default), and a
 * forged HTTP answer written right after the handshake, before any request.
 * `received` counts the bytes the client still sent to it.
 */
export async function impostorServer({
  cert = certs.impostor,
  body = { impostor: true },
  port,
} = {}) {
  const sockets = new Set();
  const forged = JSON.stringify(body);
  const imp = {
    host: HOST,
    port: 0,
    cert,
    connections: 0,
    received: 0,
    async close() {
      for (const socket of sockets) socket.destroy();
      await closed(server);
    },
  };
  const server = createTls({ key: cert.key, cert: cert.cert }, (socket) => {
    imp.connections += 1;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.on('data', (chunk) => {
      imp.received += chunk.length;
    });
    socket.write(
      `HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(forged)}\r\n\r\n${forged}`,
    );
  });
  server.on('tlsClientError', () => {});
  imp.port = await listen(server, port);
  return imp;
}
