import { DomainError } from '../domain/errors.js';
import {
  assertMultiplayerApplicationServices,
  assertMultiplayerHttpOperations,
  configurationError
} from './ports.js';
import {
  onlyRequestFields,
  parseBooleanQuery,
  parseBoundedQueryInteger
} from './request-policy.js';

const ROOM_SEATS = Object.freeze(['A', 'B']);

function assertMethod(value, path) {
  if (typeof value !== 'function') {
    throw configurationError(`multiplayer repository method ${path} is missing`, { path });
  }
  return value;
}

function assertRepositoryDependencies(core, billing, lineage) {
  const methods = [
    [core?.rooms?.getForMember, 'core.rooms.getForMember'],
    [core?.invites?.join, 'core.invites.join'],
    [core?.epochs?.getActive, 'core.epochs.getActive'],
    [core?.turns?.changeNarrativeMode, 'core.turns.changeNarrativeMode'],
    [core?.turns?.lockAction, 'core.turns.lockAction'],
    [core?.turns?.getForMember, 'core.turns.getForMember'],
    [core?.chat?.append, 'core.chat.append'],
    [core?.chat?.listHistory, 'core.chat.listHistory'],
    [billing?.profiles?.createVersion, 'billing.profiles.createVersion'],
    [billing?.profiles?.list, 'billing.profiles.list'],
    [billing?.profiles?.revoke, 'billing.profiles.revoke'],
    [billing?.credentials?.create, 'billing.credentials.create'],
    [billing?.credentials?.list, 'billing.credentials.list'],
    [billing?.credentials?.rotate, 'billing.credentials.rotate'],
    [billing?.credentials?.revoke, 'billing.credentials.revoke'],
    [billing?.selections?.selectShared, 'billing.selections.selectShared'],
    [billing?.selections?.selectWriter, 'billing.selections.selectWriter'],
    [billing?.selections?.getMemberProjection, 'billing.selections.getMemberProjection'],
    [billing?.grants?.createVersion, 'billing.grants.createVersion'],
    [billing?.grants?.revoke, 'billing.grants.revoke'],
    [billing?.consents?.grant, 'billing.consents.grant'],
    [billing?.consents?.revoke, 'billing.consents.revoke'],
    [billing?.plans?.get, 'billing.plans.get'],
    [billing?.plans?.getLatest, 'billing.plans.getLatest'],
    [billing?.plans?.authorize, 'billing.plans.authorize'],
    [billing?.amendments?.propose, 'billing.amendments.propose'],
    [lineage?.lineage?.getForMember, 'lineage.lineage.getForMember'],
    [lineage?.proposals?.createArchive, 'lineage.proposals.createArchive'],
    [lineage?.proposals?.createCheckpointResume, 'lineage.proposals.createCheckpointResume'],
    [lineage?.proposals?.createLatestSource, 'lineage.proposals.createLatestSource']
  ];
  methods.forEach(([method, path]) => assertMethod(method, path));
}

function safeBody(context, allowed, label) {
  return onlyRequestFields(context.request, allowed, label);
}

function notFound(code, message, details = {}) {
  throw new DomainError(code, message, details, { status: 404 });
}

/**
 * Compose HTTP operations from existing phase-2 repositories. Every call
 * receives the authenticated principal from the router; body identity fields
 * never participate in these bindings.
 */
export function createRepositoryBackedMultiplayerHttpOperations({
  core_repositories: core,
  billing_repository: billing,
  lineage_repository: lineage,
  application_services: applicationServicesValue
}) {
  assertRepositoryDependencies(core, billing, lineage);
  const services = assertMultiplayerApplicationServices(applicationServicesValue);

  async function activeEpoch(context) {
    const epoch = await core.epochs.getActive({
      authenticated_user_id: context.authenticated_user_id,
      room_id: context.room_id
    });
    if (!epoch) {
      throw new DomainError(
        'ACTIVE_EPOCH_REQUIRED',
        'room has no active epoch',
        { room_id: context.room_id },
        { status: 409 }
      );
    }
    if (context.epoch_no !== undefined && epoch.epoch_no !== context.epoch_no) {
      notFound('ROOM_EPOCH_NOT_FOUND', 'requested room epoch is not active', {
        epoch_no: context.epoch_no
      });
    }
    return epoch;
  }

  async function projectedEpoch(context) {
    const current = await core.epochs.getActive({
      authenticated_user_id: context.authenticated_user_id,
      room_id: context.room_id
    });
    if (current?.epoch_no === context.epoch_no) return current;
    const projection = await lineage.lineage.getForMember({
      authenticated_user_id: context.authenticated_user_id,
      room_id: context.room_id
    });
    const epoch = projection.epochs?.find(candidate => candidate.epoch_no === context.epoch_no);
    if (!epoch) {
      notFound('ROOM_EPOCH_NOT_FOUND', 'requested room epoch does not exist', {
        epoch_no: context.epoch_no
      });
    }
    return epoch;
  }

  async function turnContext(context, { active = false } = {}) {
    const epoch = active ? await activeEpoch(context) : await projectedEpoch(context);
    const turn = await core.turns.getForMember({
      authenticated_user_id: context.authenticated_user_id,
      room_id: context.room_id,
      epoch_id: epoch.epoch_id,
      turn_no: context.turn_no
    });
    return Object.freeze({ epoch, turn });
  }

  async function assertPlanTargetsTurn(context, planHash, turn) {
    const plan = await billing.plans.get({
      authenticated_user_id: context.authenticated_user_id,
      room_id: context.room_id,
      plan_hash: planHash
    });
    if (plan.turn_id !== turn.turn_id) {
      notFound('BILLING_PLAN_NOT_FOUND', 'billing plan does not belong to the requested turn');
    }
    return plan;
  }

  const operations = {
    createSaveImport(context) {
      return services.saveImports.create(context);
    },

    createRoom(context) {
      return services.rooms.create(context);
    },

    joinRoom(context) {
      if (typeof services.rooms.join === 'function') return services.rooms.join(context);
      const request = safeBody(context, ['token'], 'room join request');
      return core.invites.join({
        authenticated_user_id: context.authenticated_user_id,
        room_id: context.room_id,
        token: request.token
      });
    },

    async getRoom(context) {
      const result = typeof services.rooms.get === 'function'
        ? await services.rooms.get(context)
        : await core.rooms.getForMember({
            authenticated_user_id: context.authenticated_user_id,
            room_id: context.room_id
          });
      if (typeof billing?.credentialPolicies?.getMemberProjection !== 'function') {
        return result;
      }
      const resolvedRoomId = result?.room?.room_id ?? result?.room_id ?? context.room_id;
      const credentialPolicy = await billing.credentialPolicies.getMemberProjection({
        authenticated_user_id: context.authenticated_user_id,
        room_id: resolvedRoomId
      });
      if (result?.room) {
        return Object.freeze({
          ...result,
          room: Object.freeze({ ...result.room, credential_policy: credentialPolicy })
        });
      }
      return Object.freeze({ ...result, credential_policy: credentialPolicy });
    },

    saveRoomOpening(context) {
      assertMethod(core?.openings?.saveOwn, 'core.openings.saveOwn');
      const request = safeBody(context, [
        'expected_revision',
        'draft'
      ], 'room opening request');
      return core.openings.saveOwn({
        authenticated_user_id: context.authenticated_user_id,
        room_id: context.room_id,
        expected_revision: request.expected_revision,
        draft: request.draft
      });
    },

    async markRoomReady(context) {
      const roomBefore = await core.rooms.getForMember({
        authenticated_user_id: context.authenticated_user_id,
        room_id: context.room_id
      });
      let policyBefore = null;
      if (typeof billing?.credentialPolicies?.getMemberProjection === 'function') {
        policyBefore = await billing.credentialPolicies.getMemberProjection({
          authenticated_user_id: context.authenticated_user_id,
          room_id: context.room_id
        });
        if (policyBefore?.ready !== true) {
          throw new DomainError(
            'ROOM_AI_SETTINGS_NOT_READY',
            '请先完成联机 AI 设置：双方确认凭证方式，所需席位绑定模型',
            {
              fully_accepted: policyBefore?.fully_accepted === true,
              bindings_ready: policyBefore?.bindings_ready === true
            },
            { status: 409 }
          );
        }
      }
      const result = await services.rooms.ready(context);
      if (!result?.turn
        || typeof billing?.credentialPolicies?.materializeActiveTurn !== 'function') {
        return result;
      }
      const policyMaterialization = await billing.credentialPolicies.materializeActiveTurn({
        authenticated_user_id: context.authenticated_user_id,
        room_id: context.room_id
      });
      let openingGeneration = null;
      let policyAuthorization = null;
      if (roomBefore.origin_type === 'new_multiplayer_save'
        && typeof services.rooms.startOpening === 'function') {
        openingGeneration = await services.rooms.startOpening(context);
        if (openingGeneration?.plan_hash
          && typeof billing?.credentialPolicies?.autoAuthorizePlan === 'function') {
          policyAuthorization = await billing.credentialPolicies.autoAuthorizePlan({
            authenticated_user_id: context.authenticated_user_id,
            room_id: context.room_id,
            plan_hash: openingGeneration.plan_hash
          });
        }
      }
      const freshRoom = typeof services.rooms.get === 'function'
        ? await services.rooms.get(context)
        : await core.rooms.getForMember({
            authenticated_user_id: context.authenticated_user_id,
            room_id: context.room_id
          });
      const credentialPolicy = typeof billing?.credentialPolicies?.getMemberProjection === 'function'
        ? await billing.credentialPolicies.getMemberProjection({
            authenticated_user_id: context.authenticated_user_id,
            room_id: context.room_id
          })
        : (policyMaterialization?.credential_policy ?? policyBefore);
      const turnStatus = policyAuthorization?.turn_status
        ?? openingGeneration?.turn?.status
        ?? result.turn.status;
      return Object.freeze({
        ...result,
        room: Object.freeze({ ...freshRoom, credential_policy: credentialPolicy }),
        turn: Object.freeze({
          ...result.turn,
          ...(openingGeneration?.turn ?? {}),
          status: turnStatus
        }),
        credential_policy: credentialPolicy,
        opening_generation: openingGeneration,
        credential_policy_authorization: policyAuthorization
      });
    },

    async openNextTurn(context) {
      const request = safeBody(context, ['previous_turn_id'], 'next-turn request');
      if (typeof request.previous_turn_id !== 'string'
        || !/^[A-Za-z][A-Za-z0-9:_-]{1,255}$/u.test(request.previous_turn_id)) {
        throw new DomainError(
          'NEXT_TURN_REQUEST_INVALID',
          'previous_turn_id must identify the committed turn',
          {},
          { status: 400 }
        );
      }
      const openTurn = assertMethod(core?.turns?.open, 'core.turns.open');
      const readRoom = () => core.rooms.getForMember({
        authenticated_user_id: context.authenticated_user_id,
        room_id: context.room_id
      });
      let room = await readRoom();
      if (room.lifecycle !== 'ACTIVE') {
        throw new DomainError(
          'ROOM_NOT_ACTIVE',
          'only an active room can open its next turn',
          { lifecycle: room.lifecycle },
          { status: 409 }
        );
      }
      let turn;
      if (room.current_turn_id !== request.previous_turn_id) {
        if (!room.current_turn_id) {
          throw new DomainError(
            'CURRENT_TURN_REQUIRED',
            'the room has no current turn to advance',
            {},
            { status: 409 }
          );
        }
        turn = Object.freeze({
          turn_id: room.current_turn_id,
          existing: true,
          control_revision: room.control_revision
        });
      } else {
        try {
          turn = await openTurn({
            authenticated_user_id: context.authenticated_user_id,
            room_id: context.room_id,
            expected_control_revision: room.control_revision
          });
        } catch (error) {
          if (!(error instanceof DomainError)
            || !['ACTIVE_TURN_EXISTS', 'STALE_CONTROL_REVISION'].includes(error.code)) {
            throw error;
          }
          room = await readRoom();
          if (!room.current_turn_id || room.current_turn_id === request.previous_turn_id) throw error;
          turn = Object.freeze({
            turn_id: room.current_turn_id,
            existing: true,
            control_revision: room.control_revision
          });
        }
      }
      const credentialPolicy = typeof billing?.credentialPolicies?.materializeActiveTurn === 'function'
        ? await billing.credentialPolicies.materializeActiveTurn({
            authenticated_user_id: context.authenticated_user_id,
            room_id: context.room_id
          })
        : null;
      return Object.freeze({ turn, credential_policy: credentialPolicy });
    },

    async changeNarrativeMode(context) {
      const request = safeBody(context, [
        'expected_control_revision',
        'mode',
        'idempotency_key'
      ], 'narrative-mode request');
      const result = await core.turns.changeNarrativeMode({
        authenticated_user_id: context.authenticated_user_id,
        room_id: context.room_id,
        request
      });
      if (typeof billing?.credentialPolicies?.materializeActiveTurn !== 'function') {
        return result;
      }
      const policyMaterialization = await billing.credentialPolicies.materializeActiveTurn({
        authenticated_user_id: context.authenticated_user_id,
        room_id: context.room_id
      });
      return Object.freeze({ ...result, credential_policy: policyMaterialization });
    },

    changeNarrativePreset(context) {
      const request = safeBody(context, ['expected_control_revision', 'source_seat', 'preset'], 'narrative-preset request');
      return core.turns.changeNarrativePreset({ authenticated_user_id: context.authenticated_user_id,
        room_id: context.room_id, request });
    },

    bindRoomModelProfile(context) {
      assertMethod(
        billing?.credentialPolicies?.bindOwnProfile,
        'billing.credentialPolicies.bindOwnProfile'
      );
      const request = safeBody(context, [
        'endpoint_profile_id',
        'expected_binding_revision',
        'expected_control_revision'
      ], 'room model-profile binding request');
      return billing.credentialPolicies.bindOwnProfile({
        authenticated_user_id: context.authenticated_user_id,
        room_id: context.room_id,
        ...request
      });
    },

    chooseCredentialUsagePolicy(context) {
      assertMethod(
        billing?.credentialPolicies?.choose,
        'billing.credentialPolicies.choose'
      );
      const request = safeBody(context, [
        'policy',
        'expected_policy_revision',
        'expected_control_revision'
      ], 'credential usage-policy request');
      return billing.credentialPolicies.choose({
        authenticated_user_id: context.authenticated_user_id,
        room_id: context.room_id,
        ...request
      });
    },

    createModelEndpointProfile(context) {
      const request = safeBody(context, [
        'adapter',
        'base_url',
        'model',
        'auth_scheme',
        'credential_ref'
      ], 'model endpoint profile create request');
      return billing.profiles.createVersion({
        authenticated_user_id: context.authenticated_user_id,
        expected_config_revision: 0,
        ...request,
        capabilities: {},
        recommended_continuity_transport: null
      });
    },

    listModelEndpointProfiles(context) {
      return billing.profiles.list({
        authenticated_user_id: context.authenticated_user_id,
        include_revoked: parseBooleanQuery(
          context.query.include_revoked,
          'include_revoked',
          true
        )
      });
    },

    updateModelEndpointProfile(context) {
      const request = safeBody(context, [
        'expected_config_revision',
        'adapter',
        'base_url',
        'model',
        'auth_scheme',
        'credential_ref'
      ], 'model endpoint profile update request');
      return billing.profiles.createVersion({
        authenticated_user_id: context.authenticated_user_id,
        profile_id: context.profile_id,
        ...request,
        capabilities: {},
        recommended_continuity_transport: null
      });
    },

    revokeModelEndpointProfile(context) {
      const request = safeBody(context, ['config_revision'], 'model endpoint profile revoke request');
      return billing.profiles.revoke({
        authenticated_user_id: context.authenticated_user_id,
        profile_id: context.profile_id,
        config_revision: request.config_revision
      });
    },

    runModelCapabilityProbe(context) {
      const request = safeBody(context, [
        'profile_revision',
        'credential_revision',
        'requested_capabilities',
        'max_requests',
        'max_input_tokens',
        'max_output_tokens',
        'idempotency_key'
      ], 'model capability-probe request');
      return services.capabilityProbes.run({
        authenticated_user_id: context.authenticated_user_id,
        profile_id: context.profile_id,
        request
      });
    },

    createModelCredential(context) {
      const request = safeBody(context, [
        'endpoint_origin',
        'plaintext'
      ], 'model credential create request');
      return billing.credentials.create({
        authenticated_user_id: context.authenticated_user_id,
        ...request
      });
    },

    listModelCredentials(context) {
      return billing.credentials.list({
        authenticated_user_id: context.authenticated_user_id,
        include_revoked: parseBooleanQuery(
          context.query.include_revoked,
          'include_revoked',
          true
        )
      });
    },

    rotateModelCredential(context) {
      const request = safeBody(context, [
        'expected_credential_revision',
        'endpoint_origin',
        'plaintext'
      ], 'model credential rotation request');
      return billing.credentials.rotate({
        authenticated_user_id: context.authenticated_user_id,
        credential_id: context.credential_id,
        ...request
      });
    },

    revokeModelCredential(context) {
      const request = safeBody(context, ['credential_revision'], 'model credential revoke request');
      return billing.credentials.revoke({
        authenticated_user_id: context.authenticated_user_id,
        credential_id: context.credential_id,
        credential_revision: request.credential_revision
      });
    },

    async createExecutionGrant(context) {
      const epoch = await activeEpoch(context);
      const request = safeBody(context, [
        'grant_id',
        'expected_grant_revision',
        'endpoint_profile_id',
        'profile_revision',
        'stage_scopes',
        'authorization_scope',
        'budget',
        'expires_at'
      ], 'execution grant request');
      return billing.grants.createVersion({
        authenticated_user_id: context.authenticated_user_id,
        room_id: context.room_id,
        epoch_id: epoch.epoch_id,
        ...request
      });
    },

    revokeExecutionGrant(context) {
      const request = safeBody(context, ['grant_revision'], 'execution grant revoke request');
      return billing.grants.revoke({
        authenticated_user_id: context.authenticated_user_id,
        room_id: context.room_id,
        grant_id: context.grant_id,
        grant_revision: request.grant_revision
      });
    },

    async grantDataProcessingConsent(context) {
      const epoch = await activeEpoch(context);
      const request = safeBody(context, [
        'selection_hash',
        'config_fingerprint',
        'terms_revision',
        'data_categories'
      ], 'data-processing consent request');
      return billing.consents.grant({
        authenticated_user_id: context.authenticated_user_id,
        room_id: context.room_id,
        epoch_id: epoch.epoch_id,
        ...request
      });
    },

    revokeDataProcessingConsent(context) {
      return billing.consents.revoke({
        authenticated_user_id: context.authenticated_user_id,
        room_id: context.room_id,
        consent_id: context.consent_id
      });
    },

    listChatMessages(context) {
      return core.chat.listHistory({
        authenticated_user_id: context.authenticated_user_id,
        room_id: context.room_id,
        before: context.query.before || null,
        limit: parseBoundedQueryInteger(context.query.limit, 'limit', {
          default_value: 50,
          min: 1,
          max: 100
        })
      });
    },

    createChatMessage(context) {
      const request = safeBody(context, ['text', 'idempotency_key'], 'chat message request');
      return core.chat.append({
        authenticated_user_id: context.authenticated_user_id,
        room_id: context.room_id,
        request
      });
    },

    async selectSharedStagePayer(context) {
      const epoch = await activeEpoch(context);
      const request = safeBody(context, [
        'expected_control_revision',
        'expected_selection_revision',
        'endpoint_profile_id',
        'idempotency_key'
      ], 'shared-stage payer selection request');
      return billing.selections.selectShared({
        authenticated_user_id: context.authenticated_user_id,
        room_id: context.room_id,
        epoch_id: epoch.epoch_id,
        turn_no: context.turn_no,
        ...request
      });
    },

    async selectPovWriter(context) {
      if (!ROOM_SEATS.includes(context.audience_seat)) {
        throw new DomainError('AUDIENCE_SEAT_INVALID', 'audienceSeat must be A or B');
      }
      const epoch = await activeEpoch(context);
      const request = safeBody(context, [
        'expected_control_revision',
        'expected_selection_revision',
        'endpoint_profile_id',
        'idempotency_key'
      ], 'POV Writer selection request');
      return billing.selections.selectWriter({
        authenticated_user_id: context.authenticated_user_id,
        room_id: context.room_id,
        epoch_id: epoch.epoch_id,
        turn_no: context.turn_no,
        audience: context.audience_seat,
        ...request
      });
    },

    async lockAction(context) {
      const epoch = await activeEpoch(context);
      const request = safeBody(context, [
        'schema',
        'base_state_revision',
        'text',
        'pre_resolution_visibility',
        'narration_preference',
        'narration_note',
        'idempotency_key'
      ], 'action submission request');
      const result = await core.turns.lockAction({
        authenticated_user_id: context.authenticated_user_id,
        room_id: context.room_id,
        epoch_id: epoch.epoch_id,
        turn_no: context.turn_no,
        request
      });
      const planHash = result?.sealed_finalization?.plan_hash;
      if (!planHash || typeof billing?.credentialPolicies?.autoAuthorizePlan !== 'function') {
        return result;
      }
      const policyAuthorization = await billing.credentialPolicies.autoAuthorizePlan({
        authenticated_user_id: context.authenticated_user_id,
        room_id: context.room_id,
        plan_hash: planHash
      });
      return Object.freeze({
        ...result,
        credential_policy_authorization: policyAuthorization
      });
    },

    async getTurn(context) {
      const { epoch, turn } = await turnContext(context);
      const payerSelections = await billing.selections.getMemberProjection({
        authenticated_user_id: context.authenticated_user_id,
        room_id: context.room_id,
        epoch_id: epoch.epoch_id,
        turn_no: context.turn_no
      });
      return Object.freeze({
        ...turn,
        payer_selections: payerSelections
      });
    },

    async getAction(context) {
      const { turn } = await turnContext(context);
      const action = Object.values(turn.actions ?? {}).find(candidate => (
        candidate.submission_id === context.submission_id
      ));
      if (!action) {
        notFound(
          'ACTION_SUBMISSION_NOT_FOUND',
          'action submission is not visible in this member projection'
        );
      }
      return action;
    },

    async getBillingPlan(context) {
      const { turn } = await turnContext(context);
      return billing.plans.getLatest({
        authenticated_user_id: context.authenticated_user_id,
        room_id: context.room_id,
        turn_id: turn.turn_id
      });
    },

    async authorizeBillingPlan(context) {
      const { turn } = await turnContext(context, { active: true });
      const request = safeBody(context, [
        'plan_hash',
        'grant_id',
        'grant_revision'
      ], 'billing-plan authorization request');
      await assertPlanTargetsTurn(context, request.plan_hash, turn);
      return billing.plans.authorize({
        authenticated_user_id: context.authenticated_user_id,
        room_id: context.room_id,
        ...request
      });
    },

    async proposeBillingPlanAmendment(context) {
      const { turn } = await turnContext(context, { active: true });
      const request = safeBody(context, [
        'prior_plan_hash',
        'future_stage_changes'
      ], 'billing-plan amendment request');
      await assertPlanTargetsTurn(context, request.prior_plan_hash, turn);
      return billing.amendments.propose({
        authenticated_user_id: context.authenticated_user_id,
        room_id: context.room_id,
        ...request
      });
    },

    async acceptBillingPlanAmendment(context) {
      const current = await turnContext(context, { active: true });
      return services.billing.acceptAmendment({
        ...context,
        epoch_id: current.epoch.epoch_id,
        turn_id: current.turn.turn_id
      });
    },

    async retryTurn(context) {
      const current = await turnContext(context, { active: true });
      return services.turns.retry({
        ...context,
        epoch_id: current.epoch.epoch_id,
        turn_id: current.turn.turn_id
      });
    },

    async createTurnVoidProposal(context) {
      const current = await turnContext(context, { active: true });
      return services.turns.createVoidProposal({
        ...context,
        epoch_id: current.epoch.epoch_id,
        turn_id: current.turn.turn_id
      });
    },

    async acceptTurnVoidProposal(context) {
      const current = await turnContext(context, { active: true });
      return services.turns.acceptVoidProposal({
        ...context,
        epoch_id: current.epoch.epoch_id,
        turn_id: current.turn.turn_id
      });
    },

    getLineage(context) {
      return lineage.lineage.getForMember({
        authenticated_user_id: context.authenticated_user_id,
        room_id: context.room_id
      });
    },

    createArchiveProposal(context) {
      const request = safeBody(context, [
        'proposal_id',
        'proposal_revision',
        'checkpoint_id',
        'expected_control_revision'
      ], 'archive proposal request');
      return lineage.proposals.createArchive({
        authenticated_user_id: context.authenticated_user_id,
        room_id: context.room_id,
        ...request
      });
    },

    acceptArchiveProposal(context) {
      return services.lineage.acceptArchiveProposal(context);
    },

    createContinuationProposal(context) {
      const common = [
        'continuation_mode',
        'proposal_id',
        'proposal_revision',
        'expected_control_revision'
      ];
      if (context.request.continuation_mode === 'resume_room_checkpoint') {
        const request = safeBody(
          context,
          [...common, 'checkpoint_id'],
          'checkpoint continuation request'
        );
        const { continuation_mode: _mode, ...input } = request;
        return lineage.proposals.createCheckpointResume({
          authenticated_user_id: context.authenticated_user_id,
          room_id: context.room_id,
          ...input
        });
      }
      if (context.request.continuation_mode === 'fork_from_latest_source_save') {
        const request = safeBody(
          context,
          [...common, 'source_import_id'],
          'latest-source continuation request'
        );
        const { continuation_mode: _mode, ...input } = request;
        return lineage.proposals.createLatestSource({
          authenticated_user_id: context.authenticated_user_id,
          room_id: context.room_id,
          ...input
        });
      }
      throw new DomainError(
        'CONTINUATION_MODE_INVALID',
        'continuation_mode must select exactly one documented continuation source'
      );
    },

    acceptContinuationProposal(context) {
      return services.lineage.acceptContinuationProposal(context);
    },

    beginSinglePlayerExport(context) {
      return services.lineage.beginSinglePlayerExport(context);
    },

    downloadSinglePlayerExport(context) {
      return services.lineage.downloadSinglePlayerExport(context);
    }
  };

  return Object.freeze(assertMultiplayerHttpOperations(operations));
}
