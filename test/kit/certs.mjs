// -----------------------------------------------------------------------------
// Self-signed X.509 certificates in plain Node (no openssl): the minimal DER
// of RFC 5280 (v3, no extension), signed with RSA-SHA256, like the
// certificate of a device on the LAN. Two are bundled (no key generation in
// a test): `certs.device` and `certs.impostor`.
// -----------------------------------------------------------------------------

import { X509Certificate, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';

const length = (n) => {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n >>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
};
const tlv = (tag, ...parts) => {
  const content = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), length(content.length), content]);
};
const seq = (...parts) => tlv(0x30, ...parts);
const oid = (text) => {
  const [a, b, ...rest] = text.split('.').map(Number);
  const bytes = [40 * a + b];
  for (const n of rest) {
    const chunk = [n & 0x7f];
    for (let v = n >> 7; v > 0; v >>= 7) chunk.unshift(0x80 | (v & 0x7f));
    bytes.push(...chunk);
  }
  return tlv(0x06, Buffer.from(bytes));
};
const name = (cn) => seq(tlv(0x31, seq(oid('2.5.4.3'), tlv(0x0c, Buffer.from(cn)))));
const time = (text) => tlv(0x17, Buffer.from(text));

/** { key, cert, fingerprint256 } in PEM, for a TLS server on loopback. */
export function selfSigned(cn = 'device') {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const algorithm = seq(oid('1.2.840.113549.1.1.11'), Buffer.from([0x05, 0x00]));
  const serial = randomBytes(8);
  serial[0] &= 0x7f;
  const tbs = seq(
    tlv(0xa0, tlv(0x02, Buffer.from([0x02]))),
    tlv(0x02, serial),
    algorithm,
    name(cn),
    seq(time('250101000000Z'), time('491231235959Z')),
    name(cn),
    publicKey.export({ type: 'spki', format: 'der' }),
  );
  const signature = sign('sha256', tbs, privateKey);
  const der = seq(tbs, algorithm, tlv(0x03, Buffer.from([0x00]), signature));
  const cert = `-----BEGIN CERTIFICATE-----\n${der
    .toString('base64')
    .match(/.{1,64}/g)
    .join('\n')}\n-----END CERTIFICATE-----\n`;
  return {
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    cert,
    fingerprint256: new X509Certificate(cert).fingerprint256,
  };
}

const load = (name) => {
  const read = (ext) => readFileSync(new URL(`./certs/${name}.${ext}`, import.meta.url), 'utf8');
  const cert = read('crt');
  return { key: read('key'), cert, fingerprint256: new X509Certificate(cert).fingerprint256 };
};

/** The bundled certificates: the device's, and another one for an impostor. */
export const certs = { device: load('device'), impostor: load('impostor') };
