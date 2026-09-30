import https from 'node:https';

import { canonicalStringify } from '../domain/canonical-json.js';
import { DomainError } from '../domain/errors.js';
import {
  assertModelEndpointResponseNotRedirected,
  assertPinnedRemoteAddress,
  buildModelAuthenticationHeaders,
  createPinnedEndpointLookup,
  validateModelEndpointNetwork
} from './endpoint-policy.js';

const OPERATION_PATHS = Object.freeze({
  openai_compatible: Object.freeze({
    generate: Object.freeze({ endpoint: 'chat/completions', default_prefix: 'v1' })
  }),
  anthropic: Object.freeze({
    generate: Object.freeze({ endpoint: 'messages', default_prefix: 'v1' })
  })
});

function fail(code, message, details = {}, status = 502) {
  throw new DomainError(code, message, details, { status });
}

function resolveOperationUrl(profile, validation, operation) {
  const descriptor = OPERATION_PATHS[profile.adapter]?.[operation];
  if (!descriptor) {
    fail('MODEL_ADAPTER_OPERATION_UNSUPPORTED', 'model adapter operation is unsupported', {}, 400);
  }
  const url = new URL(validation.normalized_base_url);
  const endpoint = descriptor.endpoint.replace(/^\/+|\/+$/gu, '');
  const pathname = url.pathname.replace(/\/+$/u, '');
  const lowerPath = pathname.toLowerCase();
  const lowerEndpoint = `/${endpoint.toLowerCase()}`;
  if (lowerPath.endsWith(lowerEndpoint)) return url;

  // Main-panel bases are normalized as either an origin or a versioned base
  // such as /v1. Append the provider version only when the base does not
  // already end in one; this keeps custom relay prefixes intact and prevents
  // Anthropic's former /v1/v1/messages path.
  const versioned = /\/v\d+(?:beta\d*)?$/iu.test(pathname);
  const prefix = versioned ? '' : `/${descriptor.default_prefix}`;
  url.pathname = `${pathname}${prefix}/${endpoint}`.replace(/\/{2,}/gu, '/');
  return url;
}

function assertBody(value, maxRequestBytes) {
  let serialized;
  try {
    serialized = canonicalStringify(value);
  } catch (error) {
    throw new DomainError(
      'MODEL_REQUEST_INVALID',
      'model request body must be canonical JSON',
      {},
      { status: 400, cause: error }
    );
  }
  const bytes = Buffer.from(serialized, 'utf8');
  if (bytes.byteLength > maxRequestBytes) {
    fail('MODEL_REQUEST_TOO_LARGE', 'model request exceeds the configured byte limit', {
      max_bytes: maxRequestBytes
    }, 413);
  }
  return bytes;
}

function safeProviderRequestId(headers) {
  for (const name of ['x-request-id', 'request-id', 'cf-ray']) {
    const value = headers?.[name];
    if (typeof value === 'string' && /^[\x20-\x7e]{1,200}$/u.test(value)) return value;
  }
  return null;
}

function sanitizeProviderText(value, maxLength = 600) {
  if (typeof value !== 'string') return null;
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]+/gu, ' ')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]{8,}/giu, 'Bearer [redacted]')
    .replace(/\b(?:sk|key|token)-[A-Za-z0-9_-]{8,}/giu, '[redacted]')
    .replace(/\s+/gu, ' ')
    .trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

function safeProviderErrorDetails(chunks) {
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return Object.freeze({});
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return Object.freeze({ upstream_error_summary: sanitizeProviderText(raw) });
  }
  const source = parsed?.error && typeof parsed.error === 'object'
    ? parsed.error
    : parsed;
  return Object.freeze({
    upstream_error_code: sanitizeProviderText(source?.code, 120),
    upstream_error_type: sanitizeProviderText(source?.type, 120),
    upstream_error_summary: sanitizeProviderText(
      typeof source?.message === 'string' ? source.message : null
    )
  });
}

function adapterHeaders(profile) {
  return profile.adapter === 'anthropic'
    ? Object.freeze({ 'anthropic-version': '2023-06-01' })
    : Object.freeze({});
}

function requestJson({
  requestImpl,
  url,
  validation,
  headers,
  body,
  signal,
  timeoutMs,
  maxResponseBytes,
  forwardProxyAgent = null
}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let response = null;
    const finishReject = error => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error instanceof DomainError
        ? error
        : new DomainError('MODEL_ENDPOINT_REQUEST_FAILED', 'model endpoint request failed', {}, {
          status: 502,
          cause: error
        }));
    };
    const finishResolve = value => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const abort = () => {
      const error = new DomainError('MODEL_ENDPOINT_REQUEST_ABORTED', 'model endpoint request was aborted', {}, {
        status: 499
      });
      request.destroy(error);
      finishReject(error);
    };
    const cleanup = () => {
      signal?.removeEventListener('abort', abort);
      response?.removeAllListeners?.();
    };

    const requestOptions = {
      protocol: 'https:',
      hostname: validation.hostname,
      port: validation.port,
      servername: validation.hostname,
      method: 'POST',
      path: `${url.pathname}${url.search}`,
      ...(forwardProxyAgent === null
        ? { lookup: createPinnedEndpointLookup(validation), agent: false }
        : { agent: forwardProxyAgent }),
      headers: {
        accept: 'application/json',
        'content-type': 'application/json; charset=utf-8',
        'content-length': String(body.byteLength),
        'user-agent': 'naruto-rpg-multiplayer/1',
        ...headers
      }
    };
    const request = requestImpl(requestOptions, incoming => {
      response = incoming;
      try {
        assertModelEndpointResponseNotRedirected(incoming.statusCode, incoming.headers?.location);
      } catch (error) {
        incoming.resume?.();
        finishReject(error);
        return;
      }
      const declared = Number(incoming.headers?.['content-length']);
      if (Number.isFinite(declared) && declared > maxResponseBytes) {
        incoming.destroy?.();
        finishReject(new DomainError(
          'MODEL_ENDPOINT_RESPONSE_TOO_LARGE',
          'model endpoint response exceeds the configured byte limit',
          { max_bytes: maxResponseBytes },
          { status: 502 }
        ));
        return;
      }
      const chunks = [];
      let received = 0;
      incoming.on('data', chunkValue => {
        const chunk = Buffer.isBuffer(chunkValue) ? chunkValue : Buffer.from(chunkValue);
        received += chunk.byteLength;
        if (received > maxResponseBytes) {
          incoming.destroy?.();
          finishReject(new DomainError(
            'MODEL_ENDPOINT_RESPONSE_TOO_LARGE',
            'model endpoint response exceeds the configured byte limit',
            { max_bytes: maxResponseBytes },
            { status: 502 }
          ));
          return;
        }
        chunks.push(chunk);
      });
      incoming.once('error', finishReject);
      incoming.once('end', () => {
        if (settled) return;
        const statusCode = incoming.statusCode ?? 0;
        if (statusCode < 200 || statusCode >= 300) {
          finishReject(new DomainError(
            'MODEL_ENDPOINT_UPSTREAM_ERROR',
            'model endpoint returned a non-success status',
            {
              upstream_status: statusCode,
              provider_request_id: safeProviderRequestId(incoming.headers),
              ...safeProviderErrorDetails(chunks)
            },
            { status: 502 }
          ));
          return;
        }
        let parsed;
        try {
          parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch (error) {
          finishReject(new DomainError(
            'MODEL_ENDPOINT_RESPONSE_INVALID',
            'model endpoint response is not valid JSON',
            {},
            { status: 502, cause: error }
          ));
          return;
        }
        finishResolve(Object.freeze({
          status_code: statusCode,
          provider_request_id: safeProviderRequestId(incoming.headers),
          body: parsed
        }));
      });
    });

    if (forwardProxyAgent === null) {
      request.once('socket', socket => {
        socket.once('secureConnect', () => {
          try {
            assertPinnedRemoteAddress(validation, socket.remoteAddress);
          } catch (error) {
            request.destroy(error);
            finishReject(error);
          }
        });
      });
    }
    request.once('error', finishReject);
    request.setTimeout(timeoutMs, () => {
      const error = new DomainError('MODEL_ENDPOINT_REQUEST_TIMEOUT', 'model endpoint request timed out', {}, {
        status: 504
      });
      request.destroy(error);
      finishReject(error);
    });
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener('abort', abort, { once: true });
    request.end(body);
  });
}

/**
 * Creates the only outbound HTTP primitive used by multiplayer model stages.
 * It revalidates DNS per invocation, pins the socket, refuses redirects and
 * injects only adapter-owned authentication headers.
 */
export function createModelHttpGateway({
  lookup,
  requestImpl = https.request,
  max_request_bytes = 8 * 1024 * 1024,
  max_response_bytes = 16 * 1024 * 1024,
  timeout_ms = 180_000,
  forward_proxy_agent = null,
  allow_fake_ip_dns = false
} = {}) {
  for (const [value, label] of [
    [max_request_bytes, 'max_request_bytes'],
    [max_response_bytes, 'max_response_bytes'],
    [timeout_ms, 'timeout_ms']
  ]) {
    if (!Number.isSafeInteger(value) || value < 1) {
      fail('MODEL_HTTP_GATEWAY_CONFIGURATION_INVALID', `${label} must be positive`, {}, 500);
    }
  }
  if (typeof requestImpl !== 'function') {
    fail('MODEL_HTTP_GATEWAY_CONFIGURATION_INVALID', 'requestImpl must be a function', {}, 500);
  }

  async function invoke({
    profile,
    operation = 'generate',
    body: bodyValue,
    credential = null,
    credential_vault = null,
    owner_user_id,
    signal
  }) {
    const validation = await validateModelEndpointNetwork(
      profile?.endpoint?.normalized_base_url,
      { lookup, signal, allowFakeIpDns: allow_fake_ip_dns }
    );
    if (profile?.endpoint?.normalized_origin !== validation.normalized_origin
      || profile?.endpoint?.normalized_base_url !== validation.normalized_base_url) {
      fail('MODEL_ENDPOINT_PROFILE_MISMATCH', 'profile URL differs from the validated endpoint', {}, 409);
    }
    const url = resolveOperationUrl(profile, validation, operation);
    const body = assertBody(bodyValue, max_request_bytes);
    const send = secret => requestJson({
      requestImpl,
      url,
      validation,
      headers: {
        ...adapterHeaders(profile),
        ...buildModelAuthenticationHeaders(profile, secret)
      },
      body,
      signal,
      timeoutMs: timeout_ms,
      maxResponseBytes: max_response_bytes,
      forwardProxyAgent: forward_proxy_agent
    });
    if (profile.auth_scheme === 'none') return send(null);
    if (!credential || typeof credential_vault?.withDecryptedCredential !== 'function') {
      fail('MODEL_CREDENTIAL_REQUIRED', 'an active credential and vault are required', {}, 409);
    }
    return credential_vault.withDecryptedCredential(credential, {
      owner_user_id,
      endpoint_origin: validation.normalized_origin
    }, send);
  }

  return Object.freeze({ invoke });
}

export { resolveOperationUrl };
