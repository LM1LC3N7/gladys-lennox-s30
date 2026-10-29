// -----------------------------------------------------------------------------
// The real transport (src/lennox/http.js) against real TLS servers on the
// loopback (test/kit): the pin checked before any byte, impostors, refused
// ports, silences, oversized answers, and the protocol answers.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ERROR_KINDS, LennoxError, exchange } from '../src/lennox/http.js';
import { checkPublished, messagesOf, publishBody } from '../src/lennox/protocol.js';
import { PATHS } from '../src/constants.js';
import { certs, httpsServer, impostorServer, refusePort, reply } from './kit/index.mjs';

const PIN = certs.device.fingerprint256;
const pinned =
  (pin = PIN) =>
  async (fingerprint) => {
    if (fingerprint !== pin) {
      throw new LennoxError(ERROR_KINDS.CERTIFICATE, 'changed', { notSent: true, fingerprint });
    }
  };

async function thermostat(t, routes = {}) {
  const srv = await httpsServer({
    routes: {
      'POST /Endpoints/gladys/Connect': reply(200, 'Success'),
      'GET /Messages/gladys/Retrieve': {
        messages: [{ SenderID: 'LCC', Data: { system: { config: { name: 'House' } } } }],
      },
      'POST /Messages/Publish': { code: 1, message: '', retry_after: 0 },
      ...routes,
    },
  });
  t.after(() => srv.close());
  return srv;
}

const ctx = (srv, trust = pinned()) => ({
  host: '127.0.0.1',
  port: srv.port,
  timeoutMs: 2_000,
  trust,
});

test('the queue read over pinned HTTPS, one connection per request, no credential', async (t) => {
  const srv = await thermostat(t);
  const answer = await exchange({ ...ctx(srv), method: 'GET', path: PATHS.retrieve });
  assert.equal(messagesOf(answer).length, 1);
  const [r] = srv.requests;
  assert.equal(r.query.LongPollingTimeout, '1');
  assert.equal(r.headers.connection, 'close');
  assert.equal(r.headers.authorization, undefined);
  assert.doesNotMatch(JSON.stringify(r.headers), /lx_ic3|mapp/i);
  const published = await exchange({
    ...ctx(srv),
    method: 'POST',
    path: PATHS.publish,
    body: publishBody({ schedules: [] }),
  });
  checkPublished(published);
  assert.equal(srv.requests[1].json.SenderID, 'gladys');
});

test('another certificate: refused before any byte is written', async (t) => {
  const srv = await thermostat(t);
  await assert.rejects(
    exchange({
      ...ctx(srv, pinned('AA:' + PIN.slice(3))),
      method: 'POST',
      path: PATHS.publish,
      body: '{}',
    }),
    (err) => err.kind === ERROR_KINDS.CERTIFICATE && err.notSent === true,
  );
  assert.equal(srv.requests.length, 0);
});

test('an impostor writing first: refused on its certificate, nothing written, nothing parsed', async (t) => {
  const imp = await impostorServer({ body: { messages: [{ SenderID: 'LCC', Data: {} }] } });
  t.after(() => imp.close());
  await assert.rejects(
    exchange({
      host: imp.host,
      port: imp.port,
      timeoutMs: 2_000,
      trust: pinned(),
      method: 'GET',
      path: PATHS.retrieve,
    }),
    (err) => err.kind === ERROR_KINDS.CERTIFICATE,
  );
  assert.equal(imp.received, 0);
});

test('a refused port is unreachable, nothing sent; a silent thermostat times out after sending', async (t) => {
  const port = await refusePort();
  await assert.rejects(
    exchange({
      host: '127.0.0.1',
      port,
      timeoutMs: 1_000,
      trust: pinned(),
      method: 'GET',
      path: '/',
    }),
    (err) => err.kind === ERROR_KINDS.UNREACHABLE,
  );
  const srv = await thermostat(t, { 'POST /Messages/Publish': 'silent' });
  await assert.rejects(
    exchange({ ...ctx(srv), timeoutMs: 300, method: 'POST', path: PATHS.publish, body: '{}' }),
    (err) => err.kind === ERROR_KINDS.TIMEOUT && !err.notSent,
  );
});

test('an answer above 2 MB is cut before it is read whole', async (t) => {
  const srv = await thermostat(t);
  srv.bigBody = 3 * 1024 * 1024;
  await assert.rejects(
    exchange({ ...ctx(srv), timeoutMs: 5_000, method: 'GET', path: PATHS.retrieve }),
    (err) => err.kind === ERROR_KINDS.PROTOCOL && /too large/.test(err.message),
  );
});

test('beforeSend refusing: nothing written, marked not sent', async (t) => {
  const srv = await thermostat(t);
  await assert.rejects(
    exchange({
      ...ctx(srv),
      method: 'POST',
      path: PATHS.publish,
      body: '{}',
      beforeSend: () => {
        throw new Error('option off');
      },
    }),
    (err) => err.notSent === true,
  );
  assert.equal(srv.requests.length, 0);
});

test('the answers: 204 is no message, code 1 only is accepted, 4xx/5xx/429 told apart', () => {
  assert.deepEqual(messagesOf({ status: 204, headers: {}, body: '' }), []);
  assert.throws(() => messagesOf({ status: 200, headers: {}, body: '<html>' }), /Not JSON/);
  assert.throws(() => messagesOf({ status: 200, headers: {}, body: '{"messages":3}' }));
  // Only messages that are objects; a sibling is read by the model (dropped there).
  assert.equal(
    messagesOf({ status: 200, headers: {}, body: '{"messages":[1,null,{}]}' }).length,
    1,
  );
  assert.throws(
    () => checkPublished({ status: 200, headers: {}, body: '{"code":0}' }),
    (err) => err.kind === ERROR_KINDS.REJECTED && err.status === 'code 0',
  );
  assert.throws(
    () => checkPublished({ status: 404, headers: {}, body: '' }),
    (err) => err.kind === ERROR_KINDS.REJECTED && err.status === 404,
  );
  assert.throws(
    () => checkPublished({ status: 429, headers: { 'retry-after': '120' }, body: '' }),
    (err) => err.kind === ERROR_KINDS.RATE_LIMITED && err.retryAfter === 120_000,
  );
  assert.throws(
    () => messagesOf({ status: 500, headers: {}, body: '' }),
    (err) => err.kind === ERROR_KINDS.HTTP,
  );
});
