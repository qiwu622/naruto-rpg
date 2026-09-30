import {
  MULTIPLAYER_API_BASE,
  assertNoClientAuthorityFields,
  assertPathIdentifier,
  assertPositiveInteger
} from './contracts.js';

const SAFE_API_BASE = /^\/(?!\/)[^?#]*$/u;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const CSRF_COOKIE_NAME = 'naruto_csrf';
const CSRF_HEADER_NAME = 'X-CSRF-Token';
const SAVE_IMPORT_OPAQUE_DATA_FIELDS = Object.freeze([
  'state',
  'source_timeline',
  'source_document'
]);
const ROOM_JOIN_OPAQUE_DATA_FIELDS = Object.freeze(['guest_character']);
const ROOM_JOIN_PATH = /^\/rooms\/[^/]+\/join$/u;

function normalizeApiBase(value) {
  const base = String(value ?? MULTIPLAYER_API_BASE).replace(/\/+$/u, '');
  if (!SAFE_API_BASE.test(base)) {
    throw new TypeError('multiplayer API base must be a same-origin absolute path');
  }
  return base || MULTIPLAYER_API_BASE;
}

function segment(value, label) {
  return encodeURIComponent(assertPathIdentifier(value, label));
}

function roomLocatorSegment(value) {
  const locator = String(value ?? '').trim();
  if (locator === '') throw new TypeError('roomId must not be empty');
  return encodeURIComponent(locator);
}

function turnPath(roomId, epochNo, turnNo) {
  const room = segment(roomId, 'roomId');
  const epoch = assertPositiveInteger(epochNo, 'epochNo');
  const turn = assertPositiveInteger(turnNo, 'turnNo');
  return `/rooms/${room}/epochs/${epoch}/turns/${turn}`;
}

function contentDispositionFilename(header) {
  if (typeof header !== 'string') return null;
  const encoded = header.match(/filename\*=UTF-8''([^;]+)/iu)?.[1];
  if (encoded) {
    try {
      return decodeURIComponent(encoded).replace(/[\\/\r\n]/gu, '_').slice(0, 255);
    } catch {
      return null;
    }
  }
  const plain = header.match(/filename="?([^";]+)"?/iu)?.[1];
  return plain ? plain.replace(/[\\/\r\n]/gu, '_').slice(0, 255) : null;
}

export class MultiplayerApiError extends Error {
  constructor({ code, message, details = {}, status = 0, retryAfterSeconds = null }) {
    super(message || '联机请求失败');
    this.name = 'MultiplayerApiError';
    this.code = code || 'MULTIPLAYER_REQUEST_FAILED';
    this.details = details && typeof details === 'object' ? details : {};
    this.status = Number.isInteger(status) ? status : 0;
    this.retryAfterSeconds = Number.isFinite(retryAfterSeconds)
      ? retryAfterSeconds
      : null;
  }
}

async function readError(response) {
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    // The server normally returns the documented error envelope. A proxy or
    // expired upstream session may instead return an empty/non-JSON response.
  }
  const error = payload?.error;
  const retryAfter = Number(response.headers?.get?.('Retry-After'));
  return new MultiplayerApiError({
    code: typeof error?.code === 'string' ? error.code : `HTTP_${response.status}`,
    message: typeof error?.message === 'string'
      ? error.message
      : `联机请求失败（HTTP ${response.status}）`,
    details: error?.details,
    status: response.status,
    retryAfterSeconds: Number.isFinite(retryAfter) ? retryAfter : null
  });
}

function normalizeExtraHeaders(value) {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('multiplayer header provider must return an object');
  }
  const headers = {};
  for (const [name, headerValue] of Object.entries(value)) {
    if (!/^[A-Za-z0-9-]+$/u.test(name) || /[\r\n]/u.test(String(headerValue))) {
      throw new TypeError('multiplayer request header is invalid');
    }
    headers[name] = String(headerValue);
  }
  return headers;
}

export function cookieValue(cookieHeader, name) {
  const target = `${name}=`;
  for (const item of String(cookieHeader ?? '').split(';')) {
    const candidate = item.trim();
    if (!candidate.startsWith(target)) continue;
    try {
      return decodeURIComponent(candidate.slice(target.length));
    } catch {
      return null;
    }
  }
  return null;
}

/** Double-submit token used by cookie-authenticated multiplayer writes. */
export function defaultMultiplayerRequestHeaders({ method } = {}) {
  if (SAFE_METHODS.has(String(method ?? 'GET').toUpperCase())) return {};
  // The browser UI is cookie-authenticated. Refuse to issue a mutation when
  // its double-submit cookie is absent or malformed instead of silently
  // sending a write that cannot satisfy the multiplayer CSRF boundary.
  // Non-browser/Bearer consumers can inject their own requestHeaders provider.
  if (!globalThis.document) return {};
  const token = cookieValue(globalThis.document?.cookie ?? '', CSRF_COOKIE_NAME);
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/u.test(token)) {
    throw new TypeError('cookie-authenticated multiplayer writes require a valid naruto_csrf cookie');
  }
  return { [CSRF_HEADER_NAME]: token };
}

/**
 * Same-origin client for the complete documented multiplayer REST surface.
 * Custom model base URLs and API keys are always sent to this server API;
 * this client never contacts a player-supplied model endpoint directly.
 */
export class MultiplayerApiClient {
  constructor({
    baseUrl = MULTIPLAYER_API_BASE,
    fetchImpl = globalThis.fetch?.bind(globalThis),
    credentials = 'same-origin',
    requestHeaders = defaultMultiplayerRequestHeaders
  } = {}) {
    if (typeof fetchImpl !== 'function') {
      throw new TypeError('fetch is required for the multiplayer API client');
    }
    if (typeof requestHeaders !== 'function') {
      throw new TypeError('requestHeaders must be a function');
    }
    this.baseUrl = normalizeApiBase(baseUrl);
    this.fetchImpl = fetchImpl;
    this.credentials = credentials;
    this.requestHeaders = requestHeaders;
  }

  eventsUrl(roomId, afterEventSeq = 0) {
    const after = Number(afterEventSeq);
    if (!Number.isSafeInteger(after) || after < 0) {
      throw new TypeError('afterEventSeq must be a non-negative safe integer');
    }
    return `${this.baseUrl}/rooms/${segment(roomId, 'roomId')}/events?after=${after}`;
  }

  async request(path, {
    method = 'GET',
    body,
    query,
    signal,
    responseType = 'json'
  } = {}) {
    const normalizedMethod = String(method).toUpperCase();
    let url = `${this.baseUrl}${path}`;
    if (query && typeof query === 'object') {
      const parameters = new URLSearchParams();
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== null && value !== '') {
          parameters.set(key, String(value));
        }
      }
      const encoded = parameters.toString();
      if (encoded) url += `?${encoded}`;
    }

    const headers = {
      Accept: responseType === 'json' ? 'application/json' : '*/*',
      ...normalizeExtraHeaders(await this.requestHeaders({
        method: normalizedMethod,
        path
      }))
    };
    const init = {
      method: normalizedMethod,
      credentials: this.credentials,
      cache: 'no-store',
      headers,
      signal
    };
    if (body !== undefined) {
      assertNoClientAuthorityFields(body, {
        opaqueDataFields: path === '/save-imports'
          ? SAVE_IMPORT_OPAQUE_DATA_FIELDS
          : (ROOM_JOIN_PATH.test(path) ? ROOM_JOIN_OPAQUE_DATA_FIELDS : [])
      });
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    let response;
    try {
      response = await this.fetchImpl(url, init);
    } catch (cause) {
      if (cause?.name === 'AbortError') throw cause;
      throw new MultiplayerApiError({
        code: 'MULTIPLAYER_NETWORK_ERROR',
        message: '无法连接联机服务，已锁定的服务端数据不会因此撤回',
        details: {},
        status: 0
      });
    }
    if (!response?.ok) throw await readError(response);
    if (responseType === 'blob') {
      const blob = await response.blob();
      return Object.freeze({
        blob,
        filename: contentDispositionFilename(response.headers?.get?.('Content-Disposition')),
        contentType: response.headers?.get?.('Content-Type') || blob.type || 'application/octet-stream'
      });
    }
    if (response.status === 204) return {};
    try {
      return await response.json();
    } catch {
      throw new MultiplayerApiError({
        code: 'MULTIPLAYER_RESPONSE_INVALID',
        message: '联机服务返回了无效 JSON',
        status: response.status
      });
    }
  }

  createSaveImport(request, options) {
    return this.request('/save-imports', { method: 'POST', body: request, ...options });
  }

  createRoom(request, options) {
    return this.request('/rooms', { method: 'POST', body: request, ...options });
  }

  joinRoom(roomId, request, options) {
    return this.request(`/rooms/${roomLocatorSegment(roomId)}/join`, {
      method: 'POST', body: request, ...options
    });
  }

  getRoom(roomId, options) {
    return this.request(`/rooms/${roomLocatorSegment(roomId)}`, options);
  }

  saveRoomOpening(roomId, request, options) {
    return this.request(`/rooms/${segment(roomId, 'roomId')}/opening`, {
      method: 'PUT', body: request, ...options
    });
  }

  markRoomReady(roomId, request, options) {
    return this.request(`/rooms/${segment(roomId, 'roomId')}/ready`, {
      method: 'POST', body: request, ...options
    });
  }

  openNextTurn(roomId, previousTurnId, options) {
    return this.request(`/rooms/${segment(roomId, 'roomId')}/turns/next`, {
      method: 'POST',
      body: { previous_turn_id: assertPathIdentifier(previousTurnId, 'previousTurnId') },
      ...options
    });
  }

  changeNarrativeMode(roomId, request, options) {
    return this.request(`/rooms/${segment(roomId, 'roomId')}/settings/narrative-mode`, {
      method: 'PUT', body: request, ...options
    });
  }

  changeNarrativePreset(roomId, request, options) {
    return this.request(`/rooms/${segment(roomId, 'roomId')}/settings/narrative-preset`, {
      method: 'PUT', body: request, ...options
    });
  }

  bindRoomModelProfile(roomId, request, options) {
    return this.request(`/rooms/${segment(roomId, 'roomId')}/model-profile-binding`, {
      method: 'PUT', body: request, ...options
    });
  }

  chooseCredentialUsagePolicy(roomId, request, options) {
    return this.request(`/rooms/${segment(roomId, 'roomId')}/settings/credential-policy`, {
      method: 'PUT', body: request, ...options
    });
  }

  createModelEndpointProfile(request, options) {
    return this.request('/model-endpoint-profiles', {
      method: 'POST', body: request, ...options
    });
  }

  listModelEndpointProfiles({ includeRevoked = false, ...options } = {}) {
    return this.request('/model-endpoint-profiles', {
      query: { include_revoked: includeRevoked }, ...options
    });
  }

  updateModelEndpointProfile(profileId, request, options) {
    return this.request(`/model-endpoint-profiles/${segment(profileId, 'profileId')}`, {
      method: 'PUT', body: request, ...options
    });
  }

  revokeModelEndpointProfile(profileId, request, options) {
    return this.request(`/model-endpoint-profiles/${segment(profileId, 'profileId')}`, {
      method: 'DELETE', body: request, ...options
    });
  }

  runModelCapabilityProbe(profileId, request, options) {
    return this.request(
      `/model-endpoint-profiles/${segment(profileId, 'profileId')}/capability-probes`,
      { method: 'POST', body: request, ...options }
    );
  }

  createModelCredential(request, options) {
    return this.request('/model-credentials', { method: 'POST', body: request, ...options });
  }

  listModelCredentials({ includeRevoked = false, ...options } = {}) {
    return this.request('/model-credentials', {
      query: { include_revoked: includeRevoked }, ...options
    });
  }

  rotateModelCredential(credentialId, request, options) {
    return this.request(`/model-credentials/${segment(credentialId, 'credentialId')}/rotate`, {
      method: 'POST', body: request, ...options
    });
  }

  revokeModelCredential(credentialId, request, options) {
    return this.request(`/model-credentials/${segment(credentialId, 'credentialId')}`, {
      method: 'DELETE', body: request, ...options
    });
  }

  createExecutionGrant(roomId, request, options) {
    return this.request(`/rooms/${segment(roomId, 'roomId')}/execution-grants`, {
      method: 'POST', body: request, ...options
    });
  }

  revokeExecutionGrant(roomId, grantId, request, options) {
    return this.request(
      `/rooms/${segment(roomId, 'roomId')}/execution-grants/${segment(grantId, 'grantId')}`,
      { method: 'DELETE', body: request, ...options }
    );
  }

  grantDataProcessingConsent(roomId, request, options) {
    return this.request(`/rooms/${segment(roomId, 'roomId')}/data-processing-consents`, {
      method: 'POST', body: request, ...options
    });
  }

  revokeDataProcessingConsent(roomId, consentId, options) {
    return this.request(
      `/rooms/${segment(roomId, 'roomId')}/data-processing-consents/${segment(consentId, 'consentId')}`,
      { method: 'DELETE', body: {}, ...options }
    );
  }

  listChatMessages(roomId, { before = null, limit = 50, ...options } = {}) {
    return this.request(`/rooms/${segment(roomId, 'roomId')}/chat/messages`, {
      query: { before, limit }, ...options
    });
  }

  createChatMessage(roomId, request, options) {
    return this.request(`/rooms/${segment(roomId, 'roomId')}/chat/messages`, {
      method: 'POST', body: request, ...options
    });
  }

  selectSharedStagePayer(roomId, epochNo, turnNo, request, options) {
    return this.request(`${turnPath(roomId, epochNo, turnNo)}/shared-stage-payer`, {
      method: 'PUT', body: request, ...options
    });
  }

  selectPovWriter(roomId, epochNo, turnNo, audienceSeat, request, options) {
    if (!['A', 'B'].includes(audienceSeat)) {
      throw new TypeError('audienceSeat must be A or B');
    }
    return this.request(
      `${turnPath(roomId, epochNo, turnNo)}/pov-writer-selections/${audienceSeat}`,
      { method: 'PUT', body: request, ...options }
    );
  }

  lockAction(roomId, epochNo, turnNo, request, options) {
    return this.request(`${turnPath(roomId, epochNo, turnNo)}/actions`, {
      method: 'POST', body: request, ...options
    });
  }

  getTurn(roomId, epochNo, turnNo, options) {
    return this.request(turnPath(roomId, epochNo, turnNo), options);
  }

  getAction(roomId, epochNo, turnNo, submissionId, options) {
    return this.request(
      `${turnPath(roomId, epochNo, turnNo)}/actions/${segment(submissionId, 'submissionId')}`,
      options
    );
  }

  getBillingPlan(roomId, epochNo, turnNo, options) {
    return this.request(`${turnPath(roomId, epochNo, turnNo)}/billing-plan`, options);
  }

  authorizeBillingPlan(roomId, epochNo, turnNo, request, options) {
    return this.request(`${turnPath(roomId, epochNo, turnNo)}/billing-plan/authorizations`, {
      method: 'POST', body: request, ...options
    });
  }

  proposeBillingPlanAmendment(roomId, epochNo, turnNo, request, options) {
    return this.request(`${turnPath(roomId, epochNo, turnNo)}/billing-plan/amendments`, {
      method: 'POST', body: request, ...options
    });
  }

  acceptBillingPlanAmendment(roomId, epochNo, turnNo, amendmentId, options) {
    return this.request(
      `${turnPath(roomId, epochNo, turnNo)}/billing-plan/amendments/${segment(amendmentId, 'amendmentId')}/accept`,
      { method: 'POST', body: {}, ...options }
    );
  }

  retryTurn(roomId, epochNo, turnNo, request, options) {
    return this.request(`${turnPath(roomId, epochNo, turnNo)}/retry`, {
      method: 'POST', body: request, ...options
    });
  }

  createTurnVoidProposal(roomId, epochNo, turnNo, request, options) {
    return this.request(`${turnPath(roomId, epochNo, turnNo)}/void-proposals`, {
      method: 'POST', body: request, ...options
    });
  }

  acceptTurnVoidProposal(roomId, epochNo, turnNo, proposalId, request, options) {
    return this.request(
      `${turnPath(roomId, epochNo, turnNo)}/void-proposals/${segment(proposalId, 'proposalId')}/accept`,
      { method: 'POST', body: request, ...options }
    );
  }

  getLineage(roomId, options) {
    return this.request(`/rooms/${segment(roomId, 'roomId')}/lineage`, options);
  }

  createArchiveProposal(roomId, request, options) {
    return this.request(`/rooms/${segment(roomId, 'roomId')}/archive-proposals`, {
      method: 'POST', body: request, ...options
    });
  }

  acceptArchiveProposal(roomId, proposalId, request, options) {
    return this.request(
      `/rooms/${segment(roomId, 'roomId')}/archive-proposals/${segment(proposalId, 'proposalId')}/accept`,
      { method: 'POST', body: request, ...options }
    );
  }

  createContinuationProposal(roomId, request, options) {
    return this.request(`/rooms/${segment(roomId, 'roomId')}/continuation-proposals`, {
      method: 'POST', body: request, ...options
    });
  }

  acceptContinuationProposal(roomId, proposalId, request, options) {
    return this.request(
      `/rooms/${segment(roomId, 'roomId')}/continuation-proposals/${segment(proposalId, 'proposalId')}/accept`,
      { method: 'POST', body: request, ...options }
    );
  }

  beginSinglePlayerExport(roomId, checkpointId, request, options) {
    return this.request(
      `/rooms/${segment(roomId, 'roomId')}/checkpoints/${segment(checkpointId, 'checkpointId')}/single-player-exports`,
      { method: 'POST', body: request, ...options }
    );
  }

  downloadSinglePlayerExport(roomId, exportId, options) {
    return this.request(
      `/rooms/${segment(roomId, 'roomId')}/single-player-exports/${segment(exportId, 'exportId')}/content`,
      { responseType: 'blob', ...options }
    );
  }
}

export { contentDispositionFilename, normalizeApiBase, turnPath };
