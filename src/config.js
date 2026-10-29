// -----------------------------------------------------------------------------
// The configuration: the manifest `config_schema` values, normalized so the
// rest of the code never deals with strings typed in a form. The local API of
// the thermostat takes no credential: there is no secret to keep.
// -----------------------------------------------------------------------------

import { isIP } from 'node:net';
import { DEFAULT_PORT, POLL_INTERVAL } from './constants.js';

/** Defaults, mirrored by the manifest (checked by test/manifest.test.js). */
export const DEFAULT_CONFIG = {
  host: '',
  allow_commands: false,
  poll_interval: POLL_INTERVAL.default,
  language: 'fr',
};

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/g;
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

/**
 * The address of the thermostat typed by the user: an IPv4 address or a host
 * name, with an optional port (a pasted URL is reduced to its host and port).
 * Never a broadcast, multicast or unspecified address, never credentials.
 * @returns {{ host: string, port: number } | undefined} undefined when invalid or empty.
 */
export function parseAddress(raw) {
  const text = String(raw ?? '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/[/?#].*$/, '')
    .toLowerCase();
  if (text === '' || text.length > 260 || text.includes('@')) {
    return undefined;
  }
  const match = text.match(/^([^:]+)(?::(\d{1,5}))?$/);
  if (!match) {
    return undefined;
  }
  const host = match[1];
  const port = match[2] === undefined ? DEFAULT_PORT : Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || host.length > 253) {
    return undefined;
  }
  if (isIP(host) === 4) {
    const [first, , , last] = host.split('.').map(Number);
    // 0.0.0.0/8, multicast and reserved (224+), and a .255 broadcast are not a thermostat.
    return first === 0 || first >= 224 || last === 255 ? undefined : { host, port };
  }
  if (/^[\d.]+$/.test(host)) {
    return undefined;
  }
  return host.split('.').every((label) => LABEL.test(label)) ? { host, port } : undefined;
}

export const addressKey = ({ host, port }) => (port === DEFAULT_PORT ? host : `${host}:${port}`);

/** The address key kept in /data, back to an address (undefined when invalid). */
export const addressOfKey = (key) => (typeof key === 'string' ? parseAddress(key) : undefined);

/** Only `true` (or the text "true") allows: anything else, missing included, refuses. */
const strictTrue = (value) => value === true || value === 'true';

export function normalizeConfig(raw = {}) {
  const c = { ...DEFAULT_CONFIG };
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (Object.hasOwn(DEFAULT_CONFIG, key) && value != null) {
      c[key] = value;
    }
  }
  const typed = String(c.host ?? '').trim();
  const address = parseAddress(typed);
  const interval = Number(c.poll_interval);
  return {
    address,
    /** The text typed when it is not an address (shown in the status, cut, without control characters). */
    // What precedes an "@" (credentials pasted in a URL) is never shown back.
    invalidHost:
      typed !== '' && !address
        ? typed.replace(/^.*@/s, '…@').replace(CONTROL, '').slice(0, 100)
        : undefined,
    allowCommands: strictTrue(c.allow_commands),
    pollInterval:
      Number.isFinite(interval) && String(c.poll_interval).trim() !== ''
        ? Math.min(POLL_INTERVAL.max, Math.max(POLL_INTERVAL.min, Math.round(interval)))
        : POLL_INTERVAL.default,
    language: c.language === 'en' ? 'en' : 'fr',
  };
}

/** The address as a key of /data (the pin of the certificate belongs to it). */
export const targetKey = (config) => (config?.address ? addressKey(config.address) : undefined);
