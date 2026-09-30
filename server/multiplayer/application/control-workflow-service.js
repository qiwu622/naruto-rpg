import { sha256Hex } from '../domain/canonical-json.js';
import { DomainError } from '../domain/errors.js';
import { onlyRequestFields } from '../http/request-policy.js';

function fail(code, message, details = {}, status = 400) {
  throw new DomainError(code, message, details, { status });
}

function requestFields(context, allowed, required, label) {
  const request = onlyRequestFields(context?.request ?? {}, allowed, label);
  for (const field of required) {
    if (!Object.prototype.hasOwnProperty.call(request, field)) {
      fail('REQUEST_FIELD_REQUIRED', `${label} is missing ${field}`, { field });
    }
  }
  return request;
}

function assertMethod(value, path) {
  if (typeof value !== 'function') {
    fail('CONTROL_WORKFLOW_CONFIGURATION_INVALID', `${path} is required`, { path }, 500);
  }
}

function assertTargetsTurn(value, turnId, kind) {
  if (value.turn_id !== turnId) {
    fail(`${kind}_NOT_FOUND`, `${kind.toLowerCase()} does not belong to the requested turn`, {}, 404);
  }
}

function assertProposal(value, expectedType, context) {
  if (!value || value.proposal_type !== expectedType) {
    fail('PROPOSAL_NOT_FOUND', 'proposal does not belong to this workflow', {}, 404);
  }
  if (value.proposal_revision !== context.proposal_revision) {
    fail('STALE_PROPOSAL_REVISION', 'proposal revision does not match');
  }
  if (expectedType === 'void_turn' && value.target_turn_id !== context.turn_id) {
    fail('PROPOSAL_NOT_FOUND', 'void proposal targets another turn', {}, 404);
  }
  return value;
}

function continuationIds(proposalId) {
  const digest = sha256Hex({
    schema: 'naruto.multiplayer-continuation-activation-ids/v1',
    proposal_id: proposalId
  });
  return Object.freeze({
    new_epoch_id: `epoch_${digest.slice(0, 40)}`,
    new_genesis_checkpoint_id: `checkpoint_${digest.slice(8, 48)}`,
    new_snapshot_id: `snapshot_${digest.slice(16, 56)}`
  });
}

/**
 * Coordinates the HTTP application ports which require more than one durable
 * repository operation. Network/model work remains outside SQLite writes;
 * every authority binding comes from the authenticated member repositories.
 */
export function createControlWorkflowServices({
  coreRepositories,
  billingRepository,
  lineageRepository,
  turnWorkflowRepository,
  prepareContinuationSnapshot
}) {
  for (const [method, path] of [
    [coreRepositories?.rooms?.getForMember, 'coreRepositories.rooms.getForMember'],
    [coreRepositories?.turns?.open, 'coreRepositories.turns.open'],
    [billingRepository?.amendments?.get, 'billingRepository.amendments.get'],
    [billingRepository?.amendments?.accept, 'billingRepository.amendments.accept'],
    [billingRepository?.amendments?.apply, 'billingRepository.amendments.apply'],
    [turnWorkflowRepository?.retry, 'turnWorkflowRepository.retry'],
    [lineageRepository?.proposals?.createTurnVoid, 'lineageRepository.proposals.createTurnVoid'],
    [lineageRepository?.proposals?.getForMember, 'lineageRepository.proposals.getForMember'],
    [lineageRepository?.proposals?.accept, 'lineageRepository.proposals.accept'],
    [lineageRepository?.proposals?.applyTurnVoid, 'lineageRepository.proposals.applyTurnVoid'],
    [lineageRepository?.proposals?.applyArchive, 'lineageRepository.proposals.applyArchive'],
    [lineageRepository?.proposals?.activateContinuation,
      'lineageRepository.proposals.activateContinuation'],
    [lineageRepository?.lineage?.getForMember, 'lineageRepository.lineage.getForMember'],
    [prepareContinuationSnapshot, 'prepareContinuationSnapshot']
  ]) assertMethod(method, path);

  const continuationTasks = new Map();

  async function ensureOpenTurn(context, previousTurnId = null) {
    let room = await coreRepositories.rooms.getForMember({
      authenticated_user_id: context.authenticated_user_id,
      room_id: context.room_id
    });
    if (room.current_turn_id !== null && room.current_turn_id !== previousTurnId) {
      return Object.freeze({
        turn_id: room.current_turn_id,
        existing: true,
        control_revision: room.control_revision
      });
    }
    if (room.lifecycle !== 'ACTIVE' || room.active_epoch_id === null) return null;
    try {
      return await coreRepositories.turns.open({
        authenticated_user_id: context.authenticated_user_id,
        room_id: context.room_id,
        expected_control_revision: room.control_revision
      });
    } catch (error) {
      if (!(error instanceof DomainError)
        || !['ACTIVE_TURN_EXISTS', 'STALE_CONTROL_REVISION'].includes(error.code)) {
        throw error;
      }
      room = await coreRepositories.rooms.getForMember({
        authenticated_user_id: context.authenticated_user_id,
        room_id: context.room_id
      });
      if (room.current_turn_id === null || room.current_turn_id === previousTurnId) throw error;
      return Object.freeze({
        turn_id: room.current_turn_id,
        existing: true,
        control_revision: room.control_revision
      });
    }
  }

  const billing = Object.freeze({
    async acceptAmendment(context) {
      requestFields(context, [], [], 'billing amendment acceptance request');
      const current = await billingRepository.amendments.get({
        authenticated_user_id: context.authenticated_user_id,
        room_id: context.room_id,
        amendment_id: context.amendment_id
      });
      assertTargetsTurn(current, context.turn_id, 'BILLING_AMENDMENT');
      if (current.status === 'APPLIED') {
        return billingRepository.amendments.apply({
          authenticated_user_id: context.authenticated_user_id,
          room_id: context.room_id,
          amendment_id: context.amendment_id
        });
      }
      const accepted = await billingRepository.amendments.accept({
        authenticated_user_id: context.authenticated_user_id,
        room_id: context.room_id,
        amendment_id: context.amendment_id
      });
      assertTargetsTurn(accepted.amendment, context.turn_id, 'BILLING_AMENDMENT');
      if (accepted.amendment.status !== 'ACCEPTED') return accepted;
      return billingRepository.amendments.apply({
        authenticated_user_id: context.authenticated_user_id,
        room_id: context.room_id,
        amendment_id: context.amendment_id
      });
    }
  });

  const turns = Object.freeze({
    retry(context) {
      const request = requestFields(
        context,
        ['expected_control_revision'],
        ['expected_control_revision'],
        'turn retry request'
      );
      return turnWorkflowRepository.retry({
        authenticated_user_id: context.authenticated_user_id,
        room_id: context.room_id,
        epoch_id: context.epoch_id,
        turn_id: context.turn_id,
        expected_control_revision: request.expected_control_revision
      });
    },

    createVoidProposal(context) {
      const request = requestFields(
        context,
        ['proposal_id', 'proposal_revision', 'expected_control_revision'],
        ['proposal_id', 'proposal_revision', 'expected_control_revision'],
        'turn void proposal request'
      );
      return lineageRepository.proposals.createTurnVoid({
        authenticated_user_id: context.authenticated_user_id,
        room_id: context.room_id,
        epoch_id: context.epoch_id,
        turn_id: context.turn_id,
        ...request
      });
    },

    async acceptVoidProposal(context) {
      const request = requestFields(
        context,
        ['proposal_revision', 'expected_control_revision'],
        ['proposal_revision', 'expected_control_revision'],
        'turn void acceptance request'
      );
      let proposal = assertProposal(
        await lineageRepository.proposals.getForMember({
          authenticated_user_id: context.authenticated_user_id,
          room_id: context.room_id,
          proposal_id: context.proposal_id
        }),
        'void_turn',
        { ...context, ...request }
      );
      let acceptance = null;
      if (proposal.status !== 'APPLIED') {
        acceptance = await lineageRepository.proposals.accept({
          authenticated_user_id: context.authenticated_user_id,
          room_id: context.room_id,
          proposal_id: context.proposal_id,
          ...request
        });
        proposal = acceptance.proposal;
        if (proposal.status !== 'ACCEPTED') return acceptance;
      }
      const voidResult = await lineageRepository.proposals.applyTurnVoid({
        authenticated_user_id: context.authenticated_user_id,
        room_id: context.room_id,
        proposal_id: context.proposal_id,
        ...request
      });
      const turn = voidResult.turn_status === 'TURN_VOIDED'
        ? await ensureOpenTurn(context, context.turn_id)
        : null;
      proposal = await lineageRepository.proposals.getForMember({
        authenticated_user_id: context.authenticated_user_id,
        room_id: context.room_id,
        proposal_id: context.proposal_id
      });
      return Object.freeze({
        proposal,
        void: voidResult,
        turn,
        replayed: Boolean(voidResult.replayed && (turn?.existing ?? true))
      });
    }
  });

  async function acceptLineageProposal(context, expectedType) {
    const allowed = expectedType === 'fork_from_latest_source_save'
      ? ['proposal_revision', 'expected_control_revision', 'audience_diff_commitment']
      : ['proposal_revision', 'expected_control_revision', 'audience_diff_commitment'];
    const request = requestFields(
      context,
      allowed,
      ['proposal_revision', 'expected_control_revision'],
      'lineage proposal acceptance request'
    );
    let proposal = assertProposal(
      await lineageRepository.proposals.getForMember({
        authenticated_user_id: context.authenticated_user_id,
        room_id: context.room_id,
        proposal_id: context.proposal_id
      }),
      expectedType,
      request
    );
    if (proposal.status === 'APPLIED') return Object.freeze({ proposal, acceptance: null });
    const accepted = await lineageRepository.proposals.accept({
      authenticated_user_id: context.authenticated_user_id,
      room_id: context.room_id,
      proposal_id: context.proposal_id,
      proposal_revision: request.proposal_revision,
      expected_control_revision: request.expected_control_revision,
      audience_diff_commitment: request.audience_diff_commitment ?? null
    });
    proposal = accepted.proposal;
    return Object.freeze({ proposal, acceptance: accepted });
  }

  async function activateContinuation(context, request, proposal) {
    const existingTask = continuationTasks.get(context.proposal_id);
    if (existingTask) return existingTask;
    const task = (async () => {
      const latest = await lineageRepository.proposals.getForMember({
        authenticated_user_id: context.authenticated_user_id,
        room_id: context.room_id,
        proposal_id: context.proposal_id
      });
      if (latest.status === 'APPLIED') {
        const projection = await lineageRepository.lineage.getForMember({
          authenticated_user_id: context.authenticated_user_id,
          room_id: context.room_id
        });
        const epoch = projection.epochs.find(item => (
          item.created_from_proposal_id === context.proposal_id
        ));
        const turn = await ensureOpenTurn(context);
        return Object.freeze({ proposal: latest, epoch: epoch ?? null, turn, replayed: true });
      }
      if (latest.status !== 'ACCEPTED') {
        return Object.freeze({ proposal: latest, replayed: false });
      }
      const ids = continuationIds(context.proposal_id);
      const snapshot = await prepareContinuationSnapshot(Object.freeze({
        authenticated_user_id: context.authenticated_user_id,
        room_id: context.room_id,
        proposal,
        ...ids
      }));
      const activation = await lineageRepository.proposals.activateContinuation({
        authenticated_user_id: context.authenticated_user_id,
        room_id: context.room_id,
        proposal_id: context.proposal_id,
        proposal_revision: request.proposal_revision,
        expected_control_revision: request.expected_control_revision,
        new_epoch_id: ids.new_epoch_id,
        new_genesis_checkpoint_id: ids.new_genesis_checkpoint_id,
        snapshot
      });
      const turn = await ensureOpenTurn(context);
      const applied = await lineageRepository.proposals.getForMember({
        authenticated_user_id: context.authenticated_user_id,
        room_id: context.room_id,
        proposal_id: context.proposal_id
      });
      return Object.freeze({ proposal: applied, activation, turn, replayed: activation.replayed });
    })();
    continuationTasks.set(context.proposal_id, task);
    try {
      return await task;
    } finally {
      if (continuationTasks.get(context.proposal_id) === task) {
        continuationTasks.delete(context.proposal_id);
      }
    }
  }

  const lineage = Object.freeze({
    async acceptArchiveProposal(context) {
      const request = requestFields(
        context,
        ['proposal_revision', 'expected_control_revision'],
        ['proposal_revision', 'expected_control_revision'],
        'archive proposal acceptance request'
      );
      const result = await acceptLineageProposal(context, 'archive_room');
      if (result.proposal.status !== 'ACCEPTED'
        && result.proposal.status !== 'APPLIED') {
        return result.acceptance;
      }
      const archive = await lineageRepository.proposals.applyArchive({
        authenticated_user_id: context.authenticated_user_id,
        room_id: context.room_id,
        proposal_id: context.proposal_id,
        ...request
      });
      const proposal = await lineageRepository.proposals.getForMember({
        authenticated_user_id: context.authenticated_user_id,
        room_id: context.room_id,
        proposal_id: context.proposal_id
      });
      return Object.freeze({ proposal, archive, replayed: archive.replayed });
    },

    async acceptContinuationProposal(context) {
      const proposal = await lineageRepository.proposals.getForMember({
        authenticated_user_id: context.authenticated_user_id,
        room_id: context.room_id,
        proposal_id: context.proposal_id
      });
      if (!['resume_room_checkpoint', 'fork_from_latest_source_save'].includes(
        proposal.proposal_type
      )) {
        fail('PROPOSAL_NOT_FOUND', 'proposal is not a continuation workflow', {}, 404);
      }
      const request = requestFields(
        context,
        ['proposal_revision', 'expected_control_revision', 'audience_diff_commitment'],
        ['proposal_revision', 'expected_control_revision'],
        'continuation proposal acceptance request'
      );
      assertProposal(proposal, proposal.proposal_type, request);
      const result = await acceptLineageProposal(context, proposal.proposal_type);
      if (result.proposal.status !== 'ACCEPTED'
        && result.proposal.status !== 'APPLIED') {
        return result.acceptance;
      }
      return activateContinuation(context, request, result.proposal);
    }
  });

  return Object.freeze({ billing, turns, lineage });
}

export { continuationIds };
