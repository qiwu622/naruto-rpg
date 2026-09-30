import { randomUUID } from 'node:crypto';

import { canonicalStringify, sha256Hex } from '../domain/canonical-json.js';
import { DomainError } from '../domain/errors.js';

const SHARED_STAGES = Object.freeze([
  'referee',
  'resolution_completeness_reviewer',
  'resolution_repair',
  'continuity_steward',
  'continuity_repair',
  'narrative_grounding_reviewer'
]);

const DEFAULT_STAGE_REQUEST_LIMITS = Object.freeze({
  referee: 9,
  resolution_completeness_reviewer: 4,
  resolution_repair: 11,
  writer: 4,
  narrative_grounding_reviewer: 12,
  continuity_steward: 1,
  continuity_repair: 7
});

export const DEFAULT_STAGE_BUDGET = Object.freeze(Object.fromEntries(
  Object.entries(DEFAULT_STAGE_REQUEST_LIMITS).map(([stage, maxRequests]) => [
    stage,
    Object.freeze({
      max_requests: maxRequests,
      max_input_tokens: 128_000,
      max_output_tokens: 8_000,
      max_retries: maxRequests - 1,
      estimated_cost_cap: null
    })
  ])
));

function fail(code, message, details = {}, status = 409) {
  throw new DomainError(code, message, details, { status });
}

function planItemId(turnId, stage, audience) {
  return `plan_item_${sha256Hex({ turn_id: turnId, stage, audience }).slice(0, 32)}`;
}

function profileRef(row) {
  return {
    profile_id: row.profile_id,
    config_revision: row.profile_revision,
    owner_user_id: row.profile_owner_user_id ?? row.payer_user_id,
    normalized_origin: row.normalized_origin,
    config_fingerprint: row.config_fingerprint,
    credential_ref: row.credential_id === null
      ? null
      : {
          credential_id: row.credential_id,
          credential_revision: row.credential_revision
        }
  };
}

function consentSubjects(membersBySeat, audience, selection) {
  const roomMemberUserIds = ['A', 'B'].map(seat => membersBySeat[seat]);
  if (audience === null) return roomMemberUserIds;

  const required = new Set([
    membersBySeat[audience],
    selection.payer_user_id,
    selection.profile_owner_user_id ?? selection.payer_user_id
  ]);
  for (const subjectUserId of required) {
    if (!roomMemberUserIds.includes(subjectUserId)) {
      fail(
        'BILLING_PLAN_CONSENT_SUBJECT_INVALID',
        'POV Writer consent subjects must be active room members',
        { audience, subject_user_id: subjectUserId }
      );
    }
  }
  return roomMemberUserIds.filter(subjectUserId => required.has(subjectUserId));
}

function budgetForStage(stageBudget, stage) {
  const budget = Number.isSafeInteger(stageBudget?.max_requests)
    ? stageBudget
    : stageBudget?.[stage];
  if (!budget) fail('BILLING_PLAN_SERVICE_INVALID', `stage budget is missing for ${stage}`, {}, 500);
  return budget;
}

function stagePlan({ turnId, stage, audience, selection, membersBySeat, budget }) {
  return {
    plan_item_id: planItemId(turnId, stage, audience),
    stage,
    audience,
    payer_user_id: selection.payer_user_id,
    payer_seat: selection.payer_seat_id,
    profile_ref: profileRef(selection),
    capability_probe_ref: null,
    transport: 'json_protocol',
    budget: { ...budget },
    required_consent_subject_user_ids: consentSubjects(membersBySeat, audience, selection)
  };
}

export function buildStagePlansFromSelections({
  turn,
  selectionRows,
  membersBySeat,
  stageBudget = DEFAULT_STAGE_BUDGET
}) {
  const shared = selectionRows.find(row => row.scope === 'shared' && row.audience === 'shared');
  if (!shared) fail('PAYER_SELECTION_REQUIRED', 'shared-stage payer selection is missing');
  if (turn.narrative_mode === 'shared' && shared.selected_narrative_mode !== 'shared') {
    fail(
      'PAYER_SELECTION_MODE_MISMATCH',
      'a shared-stage selection accepted in dual-POV mode cannot authorize the shared Writer',
      {
        selected_narrative_mode: shared.selected_narrative_mode ?? null,
        required_narrative_mode: 'shared'
      }
    );
  }
  const plans = SHARED_STAGES.map(stage => stagePlan({
    turnId: turn.turn_id,
    stage,
    audience: null,
    selection: shared,
    membersBySeat,
    budget: budgetForStage(stageBudget, stage)
  }));
  if (turn.narrative_mode === 'shared') {
    plans.push(stagePlan({
      turnId: turn.turn_id,
      stage: 'writer',
      audience: null,
      selection: shared,
      membersBySeat,
      budget: budgetForStage(stageBudget, 'writer')
    }));
  } else {
    for (const audience of ['A', 'B']) {
      const writer = selectionRows.find(row => row.scope === 'writer' && row.audience === audience);
      if (!writer) fail('POV_WRITER_SELECTION_REQUIRED', `POV Writer ${audience} selection is missing`);
      plans.push(stagePlan({
        turnId: turn.turn_id,
        stage: 'writer',
        audience,
        selection: writer,
        membersBySeat,
        budget: budgetForStage(stageBudget, 'writer')
      }));
    }
  }
  return Object.freeze(plans.map(item => Object.freeze(item)));
}

function planningRowsFromDatabase(database, turnId) {
    const turn = database.prepare(`
      SELECT turn_id, room_id, epoch_id, turn_no, narrative_mode, turn_status
        FROM multiplayer_turns WHERE turn_id = ?
    `).get(turnId);
    if (!turn) fail('TURN_NOT_FOUND', 'turn does not exist', {}, 404);
    const members = database.prepare(`
      SELECT seat_id, user_id FROM multiplayer_members
       WHERE room_id = ? AND member_status = 'ACTIVE'
       ORDER BY seat_id
    `).all(turn.room_id);
    if (members.length !== 2) fail('ROOM_NOT_READY', 'both active members are required');
    const rows = database.prepare(`
      SELECT s.scope, s.audience, s.payer_user_id, s.payer_seat_id,
             s.selected_narrative_mode,
             s.profile_id, s.profile_revision, s.credential_id,
             s.credential_revision, p.owner_user_id AS profile_owner_user_id,
             p.normalized_origin, p.config_fingerprint
        FROM turn_model_selections AS s
        JOIN model_endpoint_profiles AS p
          ON p.profile_id = s.profile_id
         AND p.config_revision = s.profile_revision
         AND p.owner_user_id = s.payer_user_id
       WHERE s.turn_id = ? AND s.active = 1
       ORDER BY s.scope, s.audience
    `).all(turnId);
    return {
      turn,
      selectionRows: rows,
      membersBySeat: Object.fromEntries(members.map(row => [row.seat_id, row.user_id]))
    };
}

function loadPlanningRows(connection, turnId) {
  return connection.read(database => planningRowsFromDatabase(database, turnId));
}

export function createBillingPlanService({
  connection,
  billingRepository,
  stageBudget,
  idFactory = kind => `${kind}_${randomUUID().replaceAll('-', '')}`,
  clock = () => new Date().toISOString(),
  promptVersion = 'referee/v1',
  bundleSchemaVersion = 'naruto.turn-bundle-patch/v1',
  reducerVersion = 'naruto.multiplayer-reducers/v1'
}) {
  if (!connection || typeof connection.read !== 'function'
    || typeof billingRepository?.plans?.append !== 'function'
    || typeof billingRepository?.plans?.appendInTransaction !== 'function') {
    fail('BILLING_PLAN_SERVICE_INVALID', 'connection and billing plan repository are required', {}, 500);
  }
  return Object.freeze({
    ensureForSealedTurnInTransaction({
      database,
      authenticated_user_id,
      room_id,
      epoch_id,
      turn_id,
      input_hash,
      created_at = clock()
    }) {
      if (!database || typeof database.prepare !== 'function') {
        fail('BILLING_PLAN_SERVICE_INVALID', 'a synchronous SQLite database is required', {}, 500);
      }
      if (typeof input_hash !== 'string' || input_hash.length < 16) {
        fail('TURN_INPUT_HASH_INVALID', 'sealed turn input hash is required');
      }
      const planning = planningRowsFromDatabase(database, turn_id);
      if (planning.turn.room_id !== room_id || planning.turn.epoch_id !== epoch_id) {
        fail('TURN_NOT_FOUND', 'turn does not belong to the requested room epoch', {}, 404);
      }
      if (planning.turn.turn_status !== 'SEALED') {
        fail('INVALID_TURN_STATE', 'billing plan can only be created for a sealed turn');
      }
      const stagePlans = buildStagePlansFromSelections({
        ...planning,
        stageBudget
      });
      const planResult = billingRepository.plans.appendInTransaction({
        database,
        authenticated_user_id,
        room_id,
        epoch_id,
        turn_id,
        stage_plans: stagePlans,
        created_at
      });
      let run = database.prepare(`
        SELECT run_id, run_status, input_hash, transport, lease_fence
          FROM resolution_runs WHERE turn_id = ?
      `).get(turn_id);
      if (run) {
        if (run.input_hash !== input_hash) {
          fail('RESOLUTION_RUN_INPUT_CONFLICT', 'sealed turn already has another resolution input');
        }
      } else {
        const continuity = stagePlans.find(item => item.stage === 'continuity_steward');
        const referee = stagePlans.find(item => item.stage === 'referee');
        if (!continuity?.transport || !referee?.profile_ref?.config_fingerprint) {
          fail('BILLING_PLAN_SERVICE_INVALID', 'sealed plan lacks authoritative run transport/profile');
        }
        const runId = idFactory('run');
        database.prepare(`
          INSERT INTO resolution_runs (
            run_id, room_id, epoch_id, turn_id, turn_no, input_hash,
            stage, run_status, owner_boot_id, owner_task_id, claimed_at,
            heartbeat_at, lease_expires_at, lease_fence, attempt_count,
            prompt_version, model_fingerprint, transport,
            bundle_schema_version, reducer_version, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'resolution', 'QUEUED',
            NULL, NULL, NULL, NULL, NULL, 0, 0, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          runId,
          room_id,
          epoch_id,
          turn_id,
          planning.turn.turn_no,
          input_hash,
          promptVersion,
          referee.profile_ref.config_fingerprint,
          continuity.transport,
          bundleSchemaVersion,
          reducerVersion,
          created_at,
          created_at
        );
        run = database.prepare(`
          SELECT run_id, run_status, input_hash, transport, lease_fence
            FROM resolution_runs WHERE run_id = ?
        `).get(runId);
      }
      return Object.freeze({
        plan: planResult.plan,
        run: Object.freeze(run),
        turn_status: 'AWAITING_BILLING_AUTHORIZATION',
        events: Object.freeze([
          ...['A', 'B'].map(viewerSeat => Object.freeze({
            audience: viewerSeat,
            event_type: 'billing.plan_ready',
            payload: Object.freeze({
              turn_id,
              viewer_seat: viewerSeat,
              plan_hash: planResult.plan.plan_hash,
              plan_revision: planResult.plan.plan_revision
            })
          })),
          ...['A', 'B'].map(viewerSeat => Object.freeze({
            audience: viewerSeat,
            event_type: 'billing.authorization_required',
            payload: Object.freeze({
              turn_id,
              viewer_seat: viewerSeat,
              plan_hash: planResult.plan.plan_hash
            })
          }))
        ])
      });
    },

    async ensureForSealedTurn({ authenticated_user_id, room_id, epoch_id, turn_id }) {
      const current = billingRepository.plans.getLatest({
        authenticated_user_id,
        room_id,
        turn_id
      });
      if (current) return Object.freeze({ plan: current, replayed: true });
      const planning = loadPlanningRows(connection, turn_id);
      if (planning.turn.room_id !== room_id || planning.turn.epoch_id !== epoch_id) {
        fail('TURN_NOT_FOUND', 'turn does not belong to the requested room epoch', {}, 404);
      }
      if (planning.turn.turn_status !== 'SEALED') {
        fail('INVALID_TURN_STATE', 'billing plan can only be created for a sealed turn');
      }
      const stage_plans = buildStagePlansFromSelections({
        ...planning,
        stageBudget
      });
      return billingRepository.plans.append({
        authenticated_user_id,
        room_id,
        epoch_id,
        turn_id,
        stage_plans
      });
    },
    fingerprint() {
      return `sha256:${sha256Hex(canonicalStringify(stageBudget ?? DEFAULT_STAGE_BUDGET))}`;
    }
  });
}
