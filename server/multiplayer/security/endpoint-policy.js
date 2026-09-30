import { BlockList, isIP } from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';

import {
  assertModelEndpointProfile
} from '../contracts/billing-contracts.js';
import { DomainError } from '../domain/errors.js';

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'metadata',
  'metadata.google.internal'
]);
const BLOCKED_HOST_SUFFIXES = Object.freeze([
  '.localhost',
  '.local',
  '.internal',
  '.home.arpa'
]);

const blockedIPv4 = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4]
]) blockedIPv4.addSubnet(network, prefix, 'ipv4');

const blockedIPv6 = new BlockList();
for (const address of ['::', '::1']) blockedIPv6.addAddress(address, 'ipv6');
for (const [network, prefix] of [
  ['64:ff9b::', 96],
  ['100::', 64],
  ['2001::', 32],
  ['2001:10::', 28],
  ['2001:20::', 28],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8]
]) blockedIPv6.addSubnet(network, prefix, 'ipv6');

function fail(code, message, details = {}) {
  throw new DomainError(code, message, details);
}

function mappedIpv4(value) {
  const normalized = String(value).toLowerCase().replace(/^\[|\]$/gu, '');
  const dotted = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/u);
  if (dotted) return dotted[1];
  const hexadecimal = normalized.match(/^::ffff:([a-f0-9]{1,4}):([a-f0-9]{1,4})$/u);
  if (!hexadecimal) return null;
  const high = Number.parseInt(hexadecimal[1], 16);
  const low = Number.parseInt(hexadecimal[2], 16);
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
}

export function isPublicModelEndpointAddress(value) {
  const address = String(value || '').replace(/^\[|\]$/gu, '').toLowerCase();
  const mapped = mappedIpv4(address);
  if (mapped) return !blockedIPv4.check(mapped, 'ipv4');
  const family = isIP(address);
  if (family === 4) return !blockedIPv4.check(address, 'ipv4');
  if (family === 6) return !blockedIPv6.check(address, 'ipv6');
  return false;
}

function isFakeIpAddress(value) {
  const mapped = mappedIpv4(value);
  const address = mapped ?? String(value || '').replace(/^\[|\]$/gu, '').toLowerCase();
  if (isIP(address) !== 4) return false;
  const [first, second] = address.split('.').map(Number);
  return first === 198 && (second === 18 || second === 19);
}

function assertPublicHostname(hostname) {
  const normalized = String(hostname || '').replace(/^\[|\]$/gu, '').toLowerCase();
  if (!normalized
    || BLOCKED_HOSTNAMES.has(normalized)
    || BLOCKED_HOST_SUFFIXES.some(suffix => normalized.endsWith(suffix))) {
    fail('MODEL_ENDPOINT_FORBIDDEN', 'model endpoint hostname is reserved or local');
  }
  if (isIP(normalized) && !isPublicModelEndpointAddress(normalized)) {
    fail('MODEL_ENDPOINT_FORBIDDEN', 'model endpoint address is not public');
  }
  return normalized;
}

function assertPortAllowed(parsed, { allowPrivilegedPorts = [] } = {}) {
  const port = parsed.port ? Number(parsed.port) : 443;
  const explicitPrivileged = new Set(allowPrivilegedPorts.map(Number));
  if (!Number.isSafeInteger(port)
    || port < 1
    || port > 65_535
    || (port < 1_024 && port !== 443 && !explicitPrivileged.has(port))) {
    fail('MODEL_ENDPOINT_PORT_FORBIDDEN', 'model endpoint port is not allowed', { port });
  }
  return port;
}

/** Normalizes player input before it is persisted as a profile revision. */
export function normalizeModelEndpointBaseUrl(value, options = {}) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail('MODEL_ENDPOINT_INVALID', 'model endpoint must be a valid URL');
  }
  if (parsed.protocol !== 'https:') {
    fail('MODEL_ENDPOINT_FORBIDDEN', 'production model endpoints must use HTTPS');
  }
  if (parsed.username || parsed.password) {
    fail('MODEL_ENDPOINT_FORBIDDEN', 'model endpoint must not contain URL userinfo');
  }
  if (parsed.hash) fail('MODEL_ENDPOINT_FORBIDDEN', 'model endpoint must not contain a fragment');
  if (parsed.search) fail('MODEL_ENDPOINT_FORBIDDEN', 'model endpoint must not contain query parameters');
  assertPublicHostname(parsed.hostname);
  assertPortAllowed(parsed, options);
  const path = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/+$/u, '');
  return Object.freeze({
    normalized_base_url: `${parsed.origin}${path}`,
    normalized_origin: parsed.origin,
    hostname: parsed.hostname.toLowerCase(),
    port: parsed.port ? Number(parsed.port) : 443
  });
}

function normalizeLookupResults(results) {
  const list = Array.isArray(results) ? results : [results];
  const normalized = [];
  const seen = new Set();
  for (const result of list) {
    const address = typeof result === 'string' ? result : result?.address;
    const family = typeof result === 'object' && result !== null
      ? Number(result.family || isIP(address))
      : isIP(address);
    if (![4, 6].includes(family) || isIP(address) !== family) {
      fail('MODEL_ENDPOINT_DNS_INVALID', 'model endpoint DNS returned an invalid address');
    }
    const canonical = String(address).toLowerCase();
    if (!seen.has(`${family}:${canonical}`)) {
      normalized.push(Object.freeze({ address: canonical, family }));
      seen.add(`${family}:${canonical}`);
    }
  }
  if (!normalized.length) fail('MODEL_ENDPOINT_DNS_INVALID', 'model endpoint DNS returned no addresses');
  return normalized;
}

/**
 * Re-resolves and validates every A/AAAA answer immediately before an outbound
 * call. The returned addresses must be pinned by the transport.
 */
export async function validateModelEndpointNetwork(value, {
  lookup = dnsLookup,
  signal,
  allowPrivilegedPorts = [],
  allowFakeIpDns = false
} = {}) {
  const endpoint = normalizeModelEndpointBaseUrl(value, { allowPrivilegedPorts });
  if (signal?.aborted) fail('MODEL_ENDPOINT_VALIDATION_ABORTED', 'endpoint validation was aborted');
  let results;
  try {
    results = await lookup(endpoint.hostname, { all: true, verbatim: true, signal });
  } catch (error) {
    if (signal?.aborted || error?.name === 'AbortError') {
      fail('MODEL_ENDPOINT_VALIDATION_ABORTED', 'endpoint validation was aborted');
    }
    fail('MODEL_ENDPOINT_DNS_FAILED', 'model endpoint hostname could not be resolved');
  }
  const addresses = normalizeLookupResults(results);
  for (const { address } of addresses) {
    if (!isPublicModelEndpointAddress(address)
      && !(allowFakeIpDns && isFakeIpAddress(address))) {
      fail('MODEL_ENDPOINT_FORBIDDEN', 'model endpoint DNS resolved to a non-public address');
    }
  }
  return Object.freeze({
    normalized_base_url: endpoint.normalized_base_url,
    normalized_origin: endpoint.normalized_origin,
    hostname: endpoint.hostname,
    port: endpoint.port,
    addresses: Object.freeze(addresses)
  });
}

/** Creates an https.request-compatible lookup callback pinned to validated IPs. */
export function createPinnedEndpointLookup(validation) {
  const expectedHostname = validation?.hostname;
  const addresses = Array.isArray(validation?.addresses) ? validation.addresses : [];
  if (!expectedHostname || !addresses.length) {
    fail('MODEL_ENDPOINT_PIN_INVALID', 'endpoint pin requires validated DNS addresses');
  }
  const copies = addresses.map(item => ({ address: item.address, family: item.family }));
  return function pinnedLookup(hostname, options, callback) {
    const normalizedHostname = String(hostname || '').replace(/^\[|\]$/gu, '').toLowerCase();
    if (normalizedHostname !== expectedHostname) {
      const error = new DomainError('MODEL_ENDPOINT_PIN_MISMATCH', 'outbound hostname differs from validated host');
      callback(error);
      return;
    }
    const settings = typeof options === 'number' ? { family: options } : (options ?? {});
    const candidates = settings.family
      ? copies.filter(item => item.family === Number(settings.family))
      : copies;
    if (!candidates.length) {
      const error = new DomainError('MODEL_ENDPOINT_PIN_MISMATCH', 'no validated address matches requested family');
      callback(error);
      return;
    }
    if (settings.all) {
      callback(null, candidates.map(item => ({ ...item })));
      return;
    }
    callback(null, candidates[0].address, candidates[0].family);
  };
}

export function assertPinnedRemoteAddress(validation, remoteAddress) {
  const normalized = String(remoteAddress || '').replace(/^\[|\]$/gu, '').toLowerCase();
  const mapped = mappedIpv4(normalized);
  const candidates = new Set(validation.addresses.map(item => item.address.toLowerCase()));
  const matches = candidates.has(normalized)
    || (mapped !== null && candidates.has(mapped))
    || [...candidates].some(candidate => mappedIpv4(candidate) === normalized);
  if (!matches || !isPublicModelEndpointAddress(normalized)) {
    fail('MODEL_ENDPOINT_PIN_MISMATCH', 'connected socket address was not validated');
  }
  return true;
}

const AUTH_SCHEMES_BY_ADAPTER = Object.freeze({
  openai_compatible: Object.freeze(['bearer', 'x-api-key', 'api-key', 'none']),
  anthropic: Object.freeze(['x-api-key', 'none'])
});

/** Builds only adapter-owned headers; callers cannot supply arbitrary headers. */
export function buildModelAuthenticationHeaders(profileValue, secret = null) {
  const profile = assertModelEndpointProfile(profileValue);
  const allowed = AUTH_SCHEMES_BY_ADAPTER[profile.adapter] ?? [];
  if (!allowed.includes(profile.auth_scheme)) {
    fail('MODEL_AUTH_SCHEME_FORBIDDEN', 'auth scheme is not implemented for this adapter');
  }
  if (profile.auth_scheme === 'none') {
    if (secret !== null && secret !== undefined) {
      fail('MODEL_AUTH_SECRET_FORBIDDEN', 'auth_scheme none must not receive credential material');
    }
    return Object.freeze({});
  }
  if (!(typeof secret === 'string' || Buffer.isBuffer(secret) || secret instanceof Uint8Array)) {
    fail('MODEL_AUTH_SECRET_REQUIRED', 'authenticated model profile requires credential material');
  }
  const value = Buffer.isBuffer(secret) || secret instanceof Uint8Array
    ? Buffer.from(secret).toString('utf8')
    : secret;
  if (!value || /[\r\n\u0000]/u.test(value)) {
    fail('MODEL_AUTH_SECRET_INVALID', 'credential cannot be represented as one HTTP header value');
  }
  const headers = profile.auth_scheme === 'bearer'
    ? { authorization: `Bearer ${value}` }
    : { [profile.auth_scheme]: value };
  return Object.freeze(headers);
}

export function assertModelEndpointResponseNotRedirected(statusCode, location = null) {
  if (Number.isInteger(statusCode) && statusCode >= 300 && statusCode < 400) {
    fail('MODEL_ENDPOINT_REDIRECT_FORBIDDEN', 'model endpoint redirects are disabled', {
      has_location: Boolean(location)
    });
  }
  return true;
}
