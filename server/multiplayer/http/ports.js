import { DomainError } from '../domain/errors.js';

export const MULTIPLAYER_HTTP_OPERATION_NAMES = Object.freeze([
  'createSaveImport',
  'createRoom',
  'joinRoom',
  'getRoom',
  'saveRoomOpening',
  'markRoomReady',
  'openNextTurn',
  'changeNarrativeMode',
  'changeNarrativePreset',
  'chooseCredentialUsagePolicy',
  'bindRoomModelProfile',
  'createModelEndpointProfile',
  'listModelEndpointProfiles',
  'updateModelEndpointProfile',
  'revokeModelEndpointProfile',
  'runModelCapabilityProbe',
  'createModelCredential',
  'listModelCredentials',
  'rotateModelCredential',
  'revokeModelCredential',
  'createExecutionGrant',
  'revokeExecutionGrant',
  'grantDataProcessingConsent',
  'revokeDataProcessingConsent',
  'listChatMessages',
  'createChatMessage',
  'selectSharedStagePayer',
  'selectPovWriter',
  'lockAction',
  'getTurn',
  'getAction',
  'getBillingPlan',
  'authorizeBillingPlan',
  'proposeBillingPlanAmendment',
  'acceptBillingPlanAmendment',
  'retryTurn',
  'createTurnVoidProposal',
  'acceptTurnVoidProposal',
  'getLineage',
  'createArchiveProposal',
  'acceptArchiveProposal',
  'createContinuationProposal',
  'acceptContinuationProposal',
  'beginSinglePlayerExport',
  'downloadSinglePlayerExport'
]);

/**
 * Workflows which are intentionally not fabricated from a single repository
 * call. The application layer must supply these ports when composing the
 * complete phase-2 API.
 */
export const MULTIPLAYER_APPLICATION_SERVICE_PORTS = Object.freeze({
  saveImports: Object.freeze(['create']),
  rooms: Object.freeze(['create', 'ready']),
  capabilityProbes: Object.freeze(['run']),
  billing: Object.freeze(['acceptAmendment']),
  turns: Object.freeze(['retry', 'createVoidProposal', 'acceptVoidProposal']),
  lineage: Object.freeze([
    'acceptArchiveProposal',
    'acceptContinuationProposal',
    'beginSinglePlayerExport',
    'downloadSinglePlayerExport'
  ])
});

function configurationError(message, details = {}) {
  return new DomainError(
    'MULTIPLAYER_HTTP_CONFIGURATION_INVALID',
    message,
    details,
    { status: 500 }
  );
}

export function assertMultiplayerHttpOperations(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw configurationError('multiplayer HTTP operations must be an object');
  }
  for (const name of MULTIPLAYER_HTTP_OPERATION_NAMES) {
    if (typeof value[name] !== 'function') {
      throw configurationError(`multiplayer HTTP operation ${name} is missing`, {
        operation: name
      });
    }
  }
  return value;
}

export function assertMultiplayerApplicationServices(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw configurationError('multiplayer application services must be an object');
  }
  for (const [portName, methods] of Object.entries(MULTIPLAYER_APPLICATION_SERVICE_PORTS)) {
    const port = value[portName];
    if (!port || typeof port !== 'object' || Array.isArray(port)) {
      throw configurationError(`multiplayer application service port ${portName} is missing`, {
        port: portName
      });
    }
    for (const method of methods) {
      if (typeof port[method] !== 'function') {
        throw configurationError(
          `multiplayer application service ${portName}.${method} is missing`,
          { port: portName, method }
        );
      }
    }
  }
  return value;
}

export { configurationError };
