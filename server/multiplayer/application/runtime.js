import { randomUUID } from 'node:crypto';

import { createProviderModelClient } from '../agent/provider-adapters.js';
import { createPersistentResolutionWorker } from '../agent/persistent-resolution-worker.js';
import { createResolutionWorkerScheduler } from '../agent/resolution-worker-scheduler.js';
import { TURN_EXECUTION_PLAN_SCHEMA } from '../contracts/room-contracts.js';
import { DomainError } from '../domain/errors.js';
import { createBillingPlanService } from './billing-plan-service.js';
import { createCapabilityProbeApplicationService } from './capability-probe-service.js';
import { createControlWorkflowServices } from './control-workflow-service.js';
import {
  createCompositeSaveImportService,
  createLatestSourceImportService
} from './latest-source-import-service.js';
import { createMultiplayerToSingleplayerCodec } from './multiplayer-to-singleplayer-codec.js';
import {
  createPersonalExportSourceTimelineReader
} from './personal-export-source-timeline-reader.js';
import {
  createPersonalSingleplayerExportService
} from './personal-singleplayer-export-service.js';
import { createRoomApplicationService } from './room-application-service.js';
import {
  createAuthoritativeSnapshotService,
  createContinuationSnapshotPreparer
} from './snapshot-service.js';
import { createResolutionRunLeaseRepository } from '../persistence/resolution-run-leases.js';
import {
  createSqliteBillingRepository,
  readTurnActionLockReadiness
} from '../persistence/sqlite-billing-repository.js';
import { openMultiplayerSqlite } from '../persistence/sqlite-connection.js';
import { createSqliteBackupScheduler } from '../persistence/sqlite-backup-scheduler.js';
import {
  createSqliteContinuityDraftRepository
} from '../persistence/sqlite-continuity-draft-repository.js';
import { createSqliteMultiplayerCoreRepositories } from '../persistence/sqlite-core-repositories.js';
import { createSqliteLineageRepository } from '../persistence/sqlite-lineage-repository.js';
import {
  createSqliteGenesisImportReviewRepository
} from '../persistence/sqlite-genesis-import-review-repository.js';
import {
  createSqliteLatestSourceSnapshotStore
} from '../persistence/sqlite-latest-source-snapshot-store.js';
import {
  createSqlitePersonalExportSourceRepository
} from '../persistence/sqlite-personal-export-source-repository.js';
import { createSqliteSaveImportStagingRepository } from '../persistence/sqlite-save-import-staging-repository.js';
import {
  createSqliteResolutionCheckRepository
} from '../persistence/sqlite-resolution-check-repository.js';
import { createSqliteTurnWorkflowRepository } from '../persistence/sqlite-turn-workflow-repository.js';
import { createTurnCommitRepository } from '../persistence/turn-commit-repository.js';
import {
  createFilesystemPersonalExportOutputStore
} from '../persistence/personal-export-output-store.js';
import { createActionContentCodec } from '../security/action-content-codec.js';
import { createChatRateLimiter } from '../security/chat-rate-limit.js';
import { createCredentialVault } from '../security/credential-vault.js';
import { createEncryptedJsonBlobCodec } from '../security/encrypted-json-blob-codec.js';
import { createModelHttpGateway } from '../security/model-http-gateway.js';
import { createOutboxDispatcher } from '../transport/outbox-dispatcher.js';
import { createRoomEventHub } from '../transport/room-event-hub.js';
import { createRoomEventStreamHandler } from '../transport/room-events-sse.js';

function fail(code, message, details = {}) {
  throw new DomainError(code, message, details, { status: 500 });
}

async function settleLifecycleActions(label, actions) {
  const pending = actions.map(action => {
    try {
      return Promise.resolve(action());
    } catch (error) {
      return Promise.reject(error);
    }
  });
  const settled = await Promise.allSettled(pending);
  const failures = settled
    .filter(result => result.status === 'rejected')
    .map(result => result.reason);
  if (failures.length > 0) {
    throw new AggregateError(failures, `${label} failed`);
  }
}

function assertRuntimeConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('MULTIPLAYER_RUNTIME_CONFIGURATION_INVALID', 'multiplayer runtime configuration is required');
  }
  for (const field of [
    'databasePath',
    'keyVersion',
    'contentMasterKey',
    'credentialMasterKey',
    'credentialFingerprintKey',
    'actionCommitmentSecret',
    'lineageSigningSecret',
    'proposalCommitmentSecret'
  ]) {
    if (typeof value[field] !== 'string' || !value[field]) {
      fail('MULTIPLAYER_RUNTIME_CONFIGURATION_INVALID', `${field} is required`);
    }
  }
  return value;
}

function executionPlanResolver({ database, turn }) {
  const selections = readTurnActionLockReadiness(database, turn.turn_id);
  if (!selections.ready) {
    if (!selections.selection_ready) {
      throw new DomainError(
        'PAYER_SELECTION_REQUIRED',
        'all model payer selections and audience acceptances must be ready before locking an action',
        { turn_id: turn.turn_id },
        { status: 409 }
      );
    }
    throw new DomainError(
      'DATA_PROCESSING_CONSENT_REQUIRED',
      'all required data owners must accept the exact selection, endpoint, terms and categories',
      {
        turn_id: turn.turn_id,
        blockers: selections.blockers.filter(blocker => (
          blocker.kind === 'data_processing_consent'
        ))
      },
      { status: 409 }
    );
  }
  return {
    schema: TURN_EXECUTION_PLAN_SCHEMA,
    narrative_mode: selections.narrative_mode,
    turn_payer_selection_hash: selections.turn_payer_selection_hash,
    pov_writer_selection_hashes: selections.pov_writer_selection_hashes,
    writer_payer_by_audience: selections.writer_payer_by_audience,
    model_config_fingerprints: selections.model_config_fingerprints
  };
}

/**
 * Composes the single-instance multiplayer boundary. No browser state or
 * single-player parser is imported here; every write flows through SQLite.
 */
export async function createMultiplayerRuntime(configValue, options = {}) {
  const config = assertRuntimeConfig(configValue);
  const keyMap = { [config.keyVersion]: config.contentMasterKey };
  const credentialKeys = { [config.keyVersion]: config.credentialMasterKey };
  const actionContentCodec = createActionContentCodec({
    masterKeys: keyMap,
    activeMasterKeyVersion: config.keyVersion
  });
  // NarrativeDelivery has a dedicated storage contract/AAD helper. This
  // surface intentionally exposes only the JSON envelope primitives consumed
  // by that helper, while sharing the configured business master key.
  const narrativeContentCodec = Object.freeze({
    sealJson(value, context) {
      return actionContentCodec.sealJson(value, context);
    },
    openJson(envelope, context) {
      return actionContentCodec.openJson(envelope, context);
    }
  });
  const credentialVault = createCredentialVault({
    masterKeys: credentialKeys,
    activeMasterKeyVersion: config.keyVersion,
    fingerprintKey: config.credentialFingerprintKey
  });
  const audienceDiffCodec = createEncryptedJsonBlobCodec({
    masterKeys: keyMap,
    activeMasterKeyVersion: config.keyVersion
  });
  const connection = await (options.openConnection ?? openMultiplayerSqlite)({
    databasePath: config.databasePath,
    ...(options.sqliteOptions ?? {})
  });
  let closed = false;
  let quiesced = false;
  let quiesceComplete = false;
  let quiesceInFlight = null;
  let closeComplete = false;
  let closeInFlight = null;
  let dispatcher = null;
  let resolutionScheduler = null;
  let backupScheduler = null;
  let eventHub = null;
  try {
    const billing = createSqliteBillingRepository(connection, {
      credentialVault,
      ...(options.billingRepositoryOptions ?? {})
    });
    const billingPlanService = createBillingPlanService({
      connection,
      billingRepository: billing,
      stageBudget: options.stageBudget,
      ...(options.billingPlanServiceOptions ?? {})
    });
    const core = createSqliteMultiplayerCoreRepositories(connection, {
      actionContentCodec,
      narrativeContentCodec,
      includeCommittedPublications: true,
      actionCommitmentSecret: config.actionCommitmentSecret,
      executionPlanResolver,
      sealedTurnFinalizer: context => (
        billingPlanService.ensureForSealedTurnInTransaction({
          database: context.database,
          authenticated_user_id: context.authenticated_user_id,
          room_id: context.room_id,
          epoch_id: context.epoch_id,
          turn_id: context.turn_id,
          input_hash: context.input_hash,
          created_at: context.created_at
        })
      ),
      ...(options.coreRepositoryOptions ?? {})
    });
    const lineage = createSqliteLineageRepository(connection, {
      audienceDiffCodec,
      bindingSignatureSecret: config.lineageSigningSecret,
      proposalCommitmentSecret: config.proposalCommitmentSecret,
      ...(options.lineageRepositoryOptions ?? {})
    });
    const genesisImportReviews = createSqliteGenesisImportReviewRepository(connection, {
      audienceDiffCodec,
      commitmentSecret: config.proposalCommitmentSecret,
      ...(options.genesisImportReviewRepositoryOptions ?? {})
    });
    const leases = createResolutionRunLeaseRepository(connection);
    const commits = createTurnCommitRepository(connection, options.commitRepositoryOptions);
    eventHub = createRoomEventHub();
    dispatcher = createOutboxDispatcher({
      outbox: core.outbox,
      event_hub: eventHub,
      dispatcher_owner_id: options.dispatcherOwnerId
        ?? `dispatcher_${randomUUID().replaceAll('-', '')}`,
      on_error: options.onBackgroundError ?? (() => {}),
      ...(options.outboxDispatcherOptions ?? {})
    });
    const sseHandler = createRoomEventStreamHandler({
      repositories: core,
      event_hub: eventHub,
      session_authorizer: options.sessionAuthorizer ?? (async req => (
        Boolean(req.user?.id)
        && (!Number.isFinite(req.authExpiresAt) || Date.now() < req.authExpiresAt)
      )),
      on_error: options.onBackgroundError ?? (() => {}),
      ...(options.sseOptions ?? {})
    });
    const chatRateLimiter = createChatRateLimiter(options.chatRateLimitOptions);
    const modelHttpGateway = createModelHttpGateway(options.modelHttpGatewayOptions);
    const providerModelClient = options.providerModelClient ?? createProviderModelClient({
      modelHttpGateway,
      resolveProfile: binding => billing.modelBindings.resolveProfile(binding),
      resolveCredential: binding => billing.modelBindings.resolveCredential(binding),
      credentialVault
    });
    const capabilityProbes = createCapabilityProbeApplicationService({
      billingRepository: billing,
      providerModelClient,
      ...(options.capabilityProbeServiceOptions ?? {})
    });
    const snapshotService = createAuthoritativeSnapshotService({
      connection,
      contentCodec: actionContentCodec
    });
    const continuityEnvelopeCodec = Object.freeze({
      sealJson(value, context) {
        const envelope = actionContentCodec.sealJson(value, context);
        return Object.freeze({
          ciphertext: envelope.action_ciphertext,
          wrapped_data_key: envelope.wrapped_data_key,
          nonce: envelope.nonce,
          auth_tag: envelope.auth_tag,
          master_key_version: envelope.master_key_version
        });
      },
      openJson(envelope, context) {
        return actionContentCodec.openJson({
          action_ciphertext: envelope.ciphertext,
          wrapped_data_key: envelope.wrapped_data_key,
          nonce: envelope.nonce,
          auth_tag: envelope.auth_tag,
          master_key_version: envelope.master_key_version
        }, context);
      }
    });
    const continuityDrafts = createSqliteContinuityDraftRepository(connection, {
      ...(options.continuityRepositoryOptions ?? {}),
      envelopeCodec: continuityEnvelopeCodec
    });
    const saveImportRepository = createSqliteSaveImportStagingRepository(connection, {
      contentCodec: actionContentCodec,
      ...(options.saveImportRepositoryOptions ?? {})
    });
    const roomApplication = createRoomApplicationService({
      connection,
      coreRepositories: core,
      lineageRepository: lineage,
      saveImportRepository,
      genesisImportReviewRepository: genesisImportReviews,
      snapshotService,
      bindingTokenSecret: config.lineageSigningSecret,
      ...(options.roomApplicationOptions ?? {})
    });
    const personalExportCodec = createMultiplayerToSingleplayerCodec();
    const latestSourceSnapshots = createSqliteLatestSourceSnapshotStore(connection, {
      contentCodec: actionContentCodec,
      ...(options.latestSourceSnapshotStoreOptions ?? {})
    });
    const latestSourceImports = createLatestSourceImportService({
      lineageRepository: lineage,
      snapshotStore: latestSourceSnapshots,
      codec: personalExportCodec,
      commitmentSecret: config.proposalCommitmentSecret,
      ...(options.latestSourceImportServiceOptions ?? {})
    });
    const saveImports = createCompositeSaveImportService({
      genesisSaveImports: roomApplication.saveImports,
      latestSourceImports
    });
    const personalExportSources = createSqlitePersonalExportSourceRepository(connection, {
      narrativeContentCodec,
      ...(options.personalExportSourceRepositoryOptions ?? {})
    });
    const personalExportSourceTimeline = createPersonalExportSourceTimelineReader({
      saveImportRepository,
      latestSourceSnapshotStore: latestSourceSnapshots
    });
    const personalExportOutputStore = options.personalExportOutputStore
      ?? createFilesystemPersonalExportOutputStore({
        directory: options.personalExportOutputDirectory
          ?? `${config.databasePath}.personal-exports`
      });
    const personalExports = createPersonalSingleplayerExportService({
      lineageRepository: lineage,
      coreRepositories: core,
      snapshotService,
      exportSourceRepository: personalExportSources,
      sourceTimelineReader: personalExportSourceTimeline,
      outputStore: personalExportOutputStore,
      codec: personalExportCodec,
      bindingTokenSecret: config.lineageSigningSecret
    });
    const resolutionChecks = options.resolutionCheckRepository
      ?? createSqliteResolutionCheckRepository(connection, {
        contentCodec: actionContentCodec,
        ...(options.resolutionCheckRepositoryOptions ?? {})
      });
    const turnWorkflows = createSqliteTurnWorkflowRepository(connection, {
      ...(options.turnWorkflowRepositoryOptions ?? {}),
      contentCodec: actionContentCodec,
      narrativeContentCodec,
      snapshotService,
      continuityRepository: continuityDrafts,
      providerModelClient,
      resolveModelProfile: binding => billing.modelBindings.resolveProfile(binding),
      resolutionCommitmentSecret: config.actionCommitmentSecret,
      resolutionCheckRepository: resolutionChecks
    });
    const resolutionWorker = createPersistentResolutionWorker({
      ...(options.resolutionWorkerOptions ?? {}),
      leases,
      billing_plans: billing.plans,
      billing_usage: billing.usage,
      continuity_repository: continuityDrafts,
      commit_repository: commits,
      workflow_repository: turnWorkflows
    });
    resolutionScheduler = createResolutionWorkerScheduler({
      worker: resolutionWorker,
      on_error: options.onBackgroundError ?? (() => {}),
      ...(options.resolutionSchedulerOptions ?? {})
    });
    const prepareContinuationSnapshot = createContinuationSnapshotPreparer({
      connection,
      snapshotService,
      saveImportRepository,
      readLatestSourceState: options.readLatestSourceState
        ?? (context => latestSourceSnapshots.readLatestSourceState(context))
    });
    const controlWorkflows = createControlWorkflowServices({
      coreRepositories: core,
      billingRepository: billing,
      lineageRepository: lineage,
      turnWorkflowRepository: turnWorkflows,
      prepareContinuationSnapshot
    });
    const lineageServices = Object.freeze({
      ...controlWorkflows.lineage,
      ...personalExports
    });

    const backupDirectory = options.backupDirectory ?? config.backupDir;
    if (options.backupScheduler) {
      backupScheduler = options.backupScheduler;
    } else if (typeof backupDirectory === 'string' && backupDirectory) {
      backupScheduler = createSqliteBackupScheduler({
        connection,
        backup_directory: backupDirectory,
        interval_ms: options.backupIntervalMs
          ?? config.backupIntervalMs
          ?? (6 * 60 * 60 * 1_000),
        on_error: options.onBackgroundError ?? (() => {}),
        ...(options.backupSchedulerOptions ?? {})
      });
    }

    // A process crash after an outbound request but before its acknowledgement
    // must never cause an automatic duplicate provider charge on startup.
    await billing.usage.recoverInflightAsUnknown({
      started_before: new Date().toISOString()
    });
    if (options.startDispatcher !== false) void dispatcher.start();
    if (options.startResolutionWorker !== false) void resolutionScheduler.start();
    if (backupScheduler && options.startBackupScheduler !== false) void backupScheduler.start();

    const runtime = {
      connection,
      repositories: Object.freeze({
        core,
        billing,
        lineage,
        leases,
        commits,
        continuityDrafts,
        turnWorkflows,
        resolutionChecks,
        saveImports: saveImportRepository,
        genesisImportReviews,
        latestSourceSnapshots,
        personalExportSources
      }),
      services: Object.freeze({
        billingPlan: billingPlanService,
        capabilityProbes,
        saveImports,
        rooms: roomApplication.rooms,
        snapshots: snapshotService,
        billing: controlWorkflows.billing,
        turns: controlWorkflows.turns,
        lineage: lineageServices
      }),
      codecs: Object.freeze({
        actionContentCodec,
        narrativeContentCodec,
        audienceDiffCodec,
        personalExportCodec
      }),
      personalExportOutputStore,
      credentialVault,
      modelHttpGateway,
      eventHub,
      dispatcher,
      resolutionWorker,
      resolutionScheduler,
      backupScheduler,
      sseHandler,
      chatRateLimiter,
      assertReady() {
        if (closed) fail('MULTIPLAYER_RUNTIME_CLOSED', 'multiplayer runtime is closed');
        return connection.assertReady();
      },
      isAcceptingWork() {
        return !closed && !quiesced;
      },
      async operationalMetrics() {
        const sqlite = await connection.operationalMetrics();
        const backupAge = sqlite.last_backup_at === null
          ? null
          : Math.max(0, Date.now() - Date.parse(sqlite.last_backup_at));
        return Object.freeze({
          ...sqlite,
          backup_age_ms: backupAge,
          ...(backupScheduler?.stats?.() ?? {
            backup_scheduler_running: false,
            backup_in_flight: false,
            backup_completed_count: 0,
            backup_failed_count: 0,
            backup_last_failure_at: null
          }),
          sse_active_connections: eventHub.stats().subscribers,
          sse_active_rooms: eventHub.stats().rooms,
          outbox_dispatcher_running: dispatcher.isRunning(),
          resolution_scheduler_running: resolutionScheduler.isRunning()
        });
      },
      async quiesce() {
        if (quiesceComplete) return;
        if (quiesceInFlight) return quiesceInFlight;
        quiesced = true;
        // Invoke every stop signal before awaiting any drain. In particular,
        // the logical-worker scheduler must stop claiming new runs while an
        // online backup or another background task is still draining.
        quiesceInFlight = (async () => {
          await settleLifecycleActions('multiplayer runtime quiesce', [
            () => resolutionScheduler.quiesce(),
            () => dispatcher.stop(),
            () => backupScheduler?.quiesce(),
            () => eventHub.close('runtime_quiesced')
          ]);
          quiesceComplete = true;
        })().finally(() => {
          quiesceInFlight = null;
        });
        return quiesceInFlight;
      },
      async close() {
        if (closeComplete) return;
        if (closeInFlight) return closeInFlight;
        closed = true;
        closeInFlight = (async () => {
          await runtime.quiesce();
          await connection.close();
          closeComplete = true;
        })().finally(() => {
          closeInFlight = null;
        });
        return closeInFlight;
      }
    };
    return Object.freeze(runtime);
  } catch (error) {
    await Promise.allSettled([
      Promise.resolve().then(() => resolutionScheduler?.quiesce()),
      Promise.resolve().then(() => dispatcher?.stop()),
      Promise.resolve().then(() => backupScheduler?.quiesce()),
      Promise.resolve().then(() => eventHub?.close('startup_failed'))
    ]);
    await connection.close().catch(() => {});
    throw error;
  }
}
