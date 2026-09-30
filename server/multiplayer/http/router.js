import express from 'express';

import { DomainError } from '../domain/errors.js';
import { createChatRateLimiter } from '../security/chat-rate-limit.js';
import { multiplayerRequestBoundary } from '../security/request-guards.js';
import { asyncRoute } from '../../middleware/async-route.js';
import {
  createMultiplayerHttpErrorHandler,
  multiplayerRouteNotFound
} from './error-mapper.js';
import { assertMultiplayerHttpOperations, configurationError } from './ports.js';
import {
  assertAuthenticatedPrincipal,
  assertClientAuthorityFieldsAbsent,
  parsePathIdentifier,
  parseRoomLocator,
  parsePositivePathInteger
} from './request-policy.js';

export const MULTIPLAYER_HTTP_MOUNT_PATH = '/api/multiplayer';

export const MULTIPLAYER_HTTP_ROUTE_SPECS = Object.freeze([
  Object.freeze({
    method: 'post',
    path: '/save-imports',
    operation: 'createSaveImport',
    status: 201,
    opaque_data_fields: Object.freeze(['state', 'source_timeline', 'source_document'])
  }),
  Object.freeze({ method: 'post', path: '/rooms', operation: 'createRoom', status: 201 }),
  Object.freeze({
    method: 'post',
    path: '/rooms/:roomId/join',
    operation: 'joinRoom',
    status: 200,
    opaque_data_fields: Object.freeze(['guest_character'])
  }),
  Object.freeze({ method: 'get', path: '/rooms/:roomId', operation: 'getRoom', status: 200 }),
  Object.freeze({ method: 'put', path: '/rooms/:roomId/opening', operation: 'saveRoomOpening', status: 200 }),
  Object.freeze({ method: 'post', path: '/rooms/:roomId/ready', operation: 'markRoomReady', status: 200 }),
  Object.freeze({ method: 'post', path: '/rooms/:roomId/turns/next', operation: 'openNextTurn', status: 200 }),
  Object.freeze({ method: 'put', path: '/rooms/:roomId/settings/narrative-mode', operation: 'changeNarrativeMode', status: 200 }),
  Object.freeze({ method: 'put', path: '/rooms/:roomId/settings/narrative-preset', operation: 'changeNarrativePreset', status: 200 }),
  Object.freeze({ method: 'put', path: '/rooms/:roomId/settings/credential-policy', operation: 'chooseCredentialUsagePolicy', status: 200 }),
  Object.freeze({ method: 'put', path: '/rooms/:roomId/model-profile-binding', operation: 'bindRoomModelProfile', status: 200 }),
  Object.freeze({
    method: 'post',
    path: '/model-endpoint-profiles',
    operation: 'createModelEndpointProfile',
    status: 201,
    extra_forbidden: Object.freeze(['capabilities', 'recommended_continuity_transport'])
  }),
  Object.freeze({ method: 'get', path: '/model-endpoint-profiles', operation: 'listModelEndpointProfiles', status: 200 }),
  Object.freeze({
    method: 'put',
    path: '/model-endpoint-profiles/:profileId',
    operation: 'updateModelEndpointProfile',
    status: 200,
    extra_forbidden: Object.freeze(['capabilities', 'recommended_continuity_transport'])
  }),
  Object.freeze({ method: 'delete', path: '/model-endpoint-profiles/:profileId', operation: 'revokeModelEndpointProfile', status: 200 }),
  Object.freeze({
    method: 'post',
    path: '/model-endpoint-profiles/:profileId/capability-probes',
    operation: 'runModelCapabilityProbe',
    status: 201
  }),
  Object.freeze({ method: 'post', path: '/model-credentials', operation: 'createModelCredential', status: 201 }),
  Object.freeze({ method: 'get', path: '/model-credentials', operation: 'listModelCredentials', status: 200 }),
  Object.freeze({ method: 'post', path: '/model-credentials/:credentialId/rotate', operation: 'rotateModelCredential', status: 200 }),
  Object.freeze({ method: 'delete', path: '/model-credentials/:credentialId', operation: 'revokeModelCredential', status: 200 }),
  Object.freeze({ method: 'post', path: '/rooms/:roomId/execution-grants', operation: 'createExecutionGrant', status: 201 }),
  Object.freeze({ method: 'delete', path: '/rooms/:roomId/execution-grants/:grantId', operation: 'revokeExecutionGrant', status: 200 }),
  Object.freeze({ method: 'post', path: '/rooms/:roomId/data-processing-consents', operation: 'grantDataProcessingConsent', status: 201 }),
  Object.freeze({ method: 'delete', path: '/rooms/:roomId/data-processing-consents/:consentId', operation: 'revokeDataProcessingConsent', status: 200 }),
  Object.freeze({ method: 'get', path: '/rooms/:roomId/events', special: 'events' }),
  Object.freeze({ method: 'get', path: '/rooms/:roomId/chat/messages', operation: 'listChatMessages', status: 200 }),
  Object.freeze({
    method: 'post',
    path: '/rooms/:roomId/chat/messages',
    operation: 'createChatMessage',
    status: 201,
    special: 'chat_write',
    extra_forbidden: Object.freeze([
      'created_at',
      'event_seq',
      'message_id',
      'message_type',
      'role',
      'sender',
      'sender_seat',
      'sender_user_id',
      'system'
    ])
  }),
  Object.freeze({ method: 'put', path: '/rooms/:roomId/epochs/:epochNo/turns/:turnNo/shared-stage-payer', operation: 'selectSharedStagePayer', status: 200 }),
  Object.freeze({ method: 'put', path: '/rooms/:roomId/epochs/:epochNo/turns/:turnNo/pov-writer-selections/:audienceSeat', operation: 'selectPovWriter', status: 200 }),
  Object.freeze({
    method: 'post',
    path: '/rooms/:roomId/epochs/:epochNo/turns/:turnNo/actions',
    operation: 'lockAction',
    status: 201,
    extra_forbidden: Object.freeze([
      'content_commitment',
      'post_commit_disclosure',
      'receipt_seq',
      'received_at',
      'submission_id'
    ])
  }),
  Object.freeze({ method: 'get', path: '/rooms/:roomId/epochs/:epochNo/turns/:turnNo', operation: 'getTurn', status: 200 }),
  Object.freeze({ method: 'get', path: '/rooms/:roomId/epochs/:epochNo/turns/:turnNo/actions/:submissionId', operation: 'getAction', status: 200 }),
  Object.freeze({ method: 'get', path: '/rooms/:roomId/epochs/:epochNo/turns/:turnNo/billing-plan', operation: 'getBillingPlan', status: 200 }),
  Object.freeze({ method: 'post', path: '/rooms/:roomId/epochs/:epochNo/turns/:turnNo/billing-plan/authorizations', operation: 'authorizeBillingPlan', status: 201 }),
  Object.freeze({ method: 'post', path: '/rooms/:roomId/epochs/:epochNo/turns/:turnNo/billing-plan/amendments', operation: 'proposeBillingPlanAmendment', status: 201 }),
  Object.freeze({ method: 'post', path: '/rooms/:roomId/epochs/:epochNo/turns/:turnNo/billing-plan/amendments/:amendmentId/accept', operation: 'acceptBillingPlanAmendment', status: 200 }),
  Object.freeze({ method: 'post', path: '/rooms/:roomId/epochs/:epochNo/turns/:turnNo/retry', operation: 'retryTurn', status: 202 }),
  Object.freeze({ method: 'post', path: '/rooms/:roomId/epochs/:epochNo/turns/:turnNo/void-proposals', operation: 'createTurnVoidProposal', status: 201 }),
  Object.freeze({ method: 'post', path: '/rooms/:roomId/epochs/:epochNo/turns/:turnNo/void-proposals/:proposalId/accept', operation: 'acceptTurnVoidProposal', status: 200 }),
  Object.freeze({ method: 'get', path: '/rooms/:roomId/lineage', operation: 'getLineage', status: 200 }),
  Object.freeze({ method: 'post', path: '/rooms/:roomId/archive-proposals', operation: 'createArchiveProposal', status: 201 }),
  Object.freeze({ method: 'post', path: '/rooms/:roomId/archive-proposals/:proposalId/accept', operation: 'acceptArchiveProposal', status: 200 }),
  Object.freeze({ method: 'post', path: '/rooms/:roomId/continuation-proposals', operation: 'createContinuationProposal', status: 201 }),
  Object.freeze({ method: 'post', path: '/rooms/:roomId/continuation-proposals/:proposalId/accept', operation: 'acceptContinuationProposal', status: 200 }),
  Object.freeze({ method: 'post', path: '/rooms/:roomId/checkpoints/:checkpointId/single-player-exports', operation: 'beginSinglePlayerExport', status: 202 }),
  Object.freeze({
    method: 'get',
    path: '/rooms/:roomId/single-player-exports/:exportId/content',
    operation: 'downloadSinglePlayerExport',
    status: 200,
    special: 'download'
  })
]);

const IDENTIFIER_PARAMS = Object.freeze({
  roomId: 'room_id',
  profileId: 'profile_id',
  credentialId: 'credential_id',
  grantId: 'grant_id',
  consentId: 'consent_id',
  submissionId: 'submission_id',
  amendmentId: 'amendment_id',
  proposalId: 'proposal_id',
  checkpointId: 'checkpoint_id',
  exportId: 'export_id'
});

function requireAuthenticationContext(req, _res, next) {
  try {
    assertAuthenticatedPrincipal(req);
    if (!['bearer', 'cookie', 'bypass'].includes(req.authSource)) {
      throw new DomainError(
        'AUTHENTICATION_CONTEXT_INVALID',
        'multiplayer authentication source is missing',
        {},
        { status: 401 }
      );
    }
    next();
  } catch (error) {
    next(error);
  }
}

function requestContext(req, spec) {
  const context = {
    authenticated_user_id: assertAuthenticatedPrincipal(req),
    request: assertClientAuthorityFieldsAbsent(req.body, {
      extra_forbidden: spec.extra_forbidden ?? [],
      opaque_data_fields: spec.opaque_data_fields ?? []
    }),
    query: Object.freeze({ ...req.query })
  };
  for (const [parameter, field] of Object.entries(IDENTIFIER_PARAMS)) {
    if (req.params[parameter] !== undefined) {
      context[field] = parameter === 'roomId'
        ? parseRoomLocator(req.params[parameter])
        : parsePathIdentifier(req.params[parameter], parameter);
    }
  }
  if (req.params.epochNo !== undefined) {
    context.epoch_no = parsePositivePathInteger(req.params.epochNo, 'epochNo');
  }
  if (req.params.turnNo !== undefined) {
    context.turn_no = parsePositivePathInteger(req.params.turnNo, 'turnNo');
  }
  if (req.params.audienceSeat !== undefined) {
    if (!['A', 'B'].includes(req.params.audienceSeat)) {
      throw new DomainError('AUDIENCE_SEAT_INVALID', 'audienceSeat must be A or B');
    }
    context.audience_seat = req.params.audienceSeat;
  }
  return Object.freeze(context);
}

function sendOperationResult(res, spec, result) {
  const status = result?.replayed === true && spec.status === 201 ? 200 : spec.status;
  res.setHeader('Cache-Control', 'no-store');
  return res.status(status).json(result ?? {});
}

function safeDownloadHeader(value, fallback) {
  if (typeof value !== 'string' || !value || /[\r\n]/u.test(value)) return fallback;
  return value.slice(0, 255);
}

function sendDownloadResult(res, result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new DomainError(
      'SINGLEPLAYER_EXPORT_CONTENT_INVALID',
      'single-player export service returned an invalid content descriptor',
      {},
      { status: 500 }
    );
  }
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader(
    'Content-Type',
    safeDownloadHeader(result.content_type, 'application/json; charset=utf-8')
  );
  if (result.filename !== undefined) {
    const filename = safeDownloadHeader(result.filename, 'multiplayer-export.json')
      .replace(/["\\]/gu, '_');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  }
  if (Object.prototype.hasOwnProperty.call(result, 'body')) {
    if (!(typeof result.body === 'string' || Buffer.isBuffer(result.body))) {
      throw new DomainError(
        'SINGLEPLAYER_EXPORT_CONTENT_INVALID',
        'single-player export body must be a string or Buffer',
        {},
        { status: 500 }
      );
    }
    return res.status(200).send(result.body);
  }
  if (Object.prototype.hasOwnProperty.call(result, 'content')) {
    return res.status(200).send(
      typeof result.content === 'string'
        ? result.content
        : JSON.stringify(result.content)
    );
  }
  throw new DomainError(
    'SINGLEPLAYER_EXPORT_CONTENT_INVALID',
    'single-player export service returned no content',
    {},
    { status: 500 }
  );
}

/**
 * Authenticated Express router mounted at /api/multiplayer. Authentication is
 * deliberately upstream; this boundary requires req.user.id and never reads a
 * principal, seat or payer from JSON.
 */
export function createMultiplayerHttpRouter({
  operations: operationsValue,
  room_event_stream_handler,
  chat_rate_limiter = createChatRateLimiter(),
  json_limit = '256kb',
  error_logger = () => {}
}) {
  const operations = assertMultiplayerHttpOperations(operationsValue);
  if (typeof room_event_stream_handler !== 'function') {
    throw configurationError('room event stream handler is required');
  }
  if (typeof chat_rate_limiter?.middleware !== 'function') {
    throw configurationError('chat rate limiter middleware is required');
  }
  const router = express.Router();
  router.use(requireAuthenticationContext);
  router.use(multiplayerRequestBoundary);
  const standardJson = express.json({ limit: json_limit, strict: true });
  const presetJson = express.json({ limit: '1mb', strict: true });
  router.use((req, res, next) => {
    // Complete imported presets and detailed Chinese opening dossiers can be
    // larger in UTF-8 bytes than the ordinary action request ceiling.
    const detailed = /^\/rooms\/[^/]+\/(?:opening|settings\/narrative-preset)\/?$/u.test(req.path);
    return (detailed ? presetJson : standardJson)(req, res, next);
  });

  for (const spec of MULTIPLAYER_HTTP_ROUTE_SPECS) {
    if (spec.special === 'events') {
      router.get(spec.path, room_event_stream_handler);
      continue;
    }
    const middleware = [];
    if (spec.special === 'chat_write') middleware.push(chat_rate_limiter.middleware);
    middleware.push(asyncRoute(async (req, res) => {
      const result = await operations[spec.operation](requestContext(req, spec));
      if (spec.special === 'download') return sendDownloadResult(res, result);
      return sendOperationResult(res, spec, result);
    }));
    router[spec.method](spec.path, ...middleware);
  }

  router.use(multiplayerRouteNotFound);
  router.use(createMultiplayerHttpErrorHandler({ logger: error_logger }));
  return router;
}

export { requestContext, sendDownloadResult };
