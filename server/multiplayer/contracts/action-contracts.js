import {
  ACTION_LIMITS,
  ACTION_REQUEST_SCHEMA
} from '../domain/action-turn.js';
import {
  NARRATION_PREFERENCES,
  NARRATIVE_MODES,
  PRE_RESOLUTION_VISIBILITIES,
  ROOM_SEATS,
  TURN_STATUSES
} from './enums.js';
import {
  assertBoolean,
  assertExactKeys,
  assertIdentifier,
  assertInteger,
  assertPlainRecord,
  assertString,
  contractError,
  immutableContractValue,
  inspectContract
} from './common.js';
import {
  NARRATIVE_DELIVERY_JSON_SCHEMA,
  NARRATIVE_DELIVERY_SCHEMA,
  assertNarrativeCandidate
} from './narrative-contracts.js';
import {
  MEMBER_STATE_CANONICAL_DATA_DEFINITION,
  MEMBER_STATE_PROJECTION_DEFINITION,
  assertMemberStateProjection
} from './member-state-contracts.js';
import { validateShinobiDaily } from '../../../js/core/shinobi-daily.js';
import { assertTurnGenerationProgress, TURN_GENERATION_PROGRESS_JSON_SCHEMA } from './turn-progress-contracts.js';

export { ACTION_LIMITS, ACTION_REQUEST_SCHEMA };

export const ACTION_TURN_MEMBER_PROJECTION_SCHEMA =
  'naruto.multiplayer-action-turn-projection/v1';
export const ACTION_TURN_PROJECTION_SCHEMA = ACTION_TURN_MEMBER_PROJECTION_SCHEMA;
export const ACTION_RECEIPT_SCHEMA = 'naruto.multiplayer-action-receipt/v1';
export const ACTION_SUBMISSION_MEMBER_VIEW_SCHEMA =
  'naruto.multiplayer-action-submission-member-view/v1';
export const COMMITTED_TURN_PUBLICATION_SCHEMA =
  'naruto.multiplayer-committed-turn-publication/v1';

const ACTION_DISCLOSURES = Object.freeze([
  'owner',
  'open_pre_resolution',
  'full_after_commit'
]);
const OPPONENT_ACTION_DISCLOSURES = Object.freeze([
  'open_pre_resolution',
  'full_after_commit'
]);
const IDENTIFIER_PATTERN = '^[A-Za-z][A-Za-z0-9:_-]*$';
const CONTENT_COMMITMENT_PATTERN = '^hmac-sha256:[a-f0-9]{64}$';
const CONTENT_COMMITMENT_REGEXP = /^hmac-sha256:[a-f0-9]{64}$/u;
const SAFE_TEXT_PATTERN =
  '^(?![\\s\\S]*[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F-\\u009F\\u202A-\\u202E\\u2066-\\u2069])[\\s\\S]*$';
const SAFE_NONBLANK_TEXT_PATTERN =
  '^(?=[\\s\\S]*\\S)(?![\\s\\S]*[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F-\\u009F\\u202A-\\u202E\\u2066-\\u2069])[\\s\\S]*$';
const ISO_TIMESTAMP_REGEXP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u;

const receiptDefinition = {
  type: 'object',
  additionalProperties: false,
  required: [
    'submission_id',
    'seat',
    'receipt_seq',
    'received_at',
    'content_commitment',
    'base_state_revision'
  ],
  properties: {
    submission_id: {
      type: 'string',
      minLength: 2,
      maxLength: ACTION_LIMITS.identifierMaxLength,
      pattern: IDENTIFIER_PATTERN
    },
    seat: { type: 'string', enum: ROOM_SEATS },
    receipt_seq: { type: 'integer', minimum: 1, maximum: 2 },
    received_at: { type: 'string', format: 'date-time', maxLength: 64 },
    content_commitment: { type: 'string', pattern: CONTENT_COMMITMENT_PATTERN },
    base_state_revision: {
      type: 'integer',
      minimum: 0,
      maximum: Number.MAX_SAFE_INTEGER
    }
  }
};

const unlockedActionDefinition = {
  type: 'object',
  additionalProperties: false,
  required: ['seat', 'locked'],
  properties: {
    seat: { type: 'string', enum: ROOM_SEATS },
    locked: { const: false }
  }
};

const hiddenActionDefinition = {
  type: 'object',
  additionalProperties: false,
  required: ['seat', 'locked'],
  properties: {
    seat: { type: 'string', enum: ROOM_SEATS },
    locked: { const: true }
  }
};

const visibleActionProperties = {
  seat: { type: 'string', enum: ROOM_SEATS },
  locked: { const: true },
  submission_id: {
    type: 'string',
    minLength: 2,
    maxLength: ACTION_LIMITS.identifierMaxLength,
    pattern: IDENTIFIER_PATTERN
  },
  text: {
    type: 'string',
    minLength: 1,
    maxLength: ACTION_LIMITS.textMaxLength,
    pattern: SAFE_NONBLANK_TEXT_PATTERN
  }
};

const ownerActionDefinition = {
  type: 'object',
  additionalProperties: false,
  required: ['seat', 'locked', 'submission_id', 'text', 'disclosure', 'receipt'],
  properties: {
    ...visibleActionProperties,
    disclosure: { const: 'owner' },
    receipt: receiptDefinition
  }
};

const disclosedOpponentActionDefinition = {
  type: 'object',
  additionalProperties: false,
  required: ['seat', 'locked', 'submission_id', 'text', 'disclosure'],
  properties: {
    ...visibleActionProperties,
    disclosure: { type: 'string', enum: OPPONENT_ACTION_DISCLOSURES }
  }
};

const memberViewDefinition = {
  oneOf: [
    unlockedActionDefinition,
    hiddenActionDefinition,
    ownerActionDefinition,
    disclosedOpponentActionDefinition
  ]
};

const committedTurnPublicationDefinition = {
  type: 'object',
  additionalProperties: false,
  required: ['schema', 'checkpoint', 'state', 'narratives', 'shinobi_daily'],
  properties: {
    schema: { const: COMMITTED_TURN_PUBLICATION_SCHEMA },
    checkpoint: {
      type: 'object',
      additionalProperties: false,
      required: ['checkpoint_id', 'commit_id', 'state_revision', 'created_at'],
      properties: {
        checkpoint_id: {
          type: 'string',
          minLength: 2,
          maxLength: ACTION_LIMITS.identifierMaxLength,
          pattern: IDENTIFIER_PATTERN
        },
        commit_id: {
          type: 'string',
          minLength: 2,
          maxLength: ACTION_LIMITS.identifierMaxLength,
          pattern: IDENTIFIER_PATTERN
        },
        state_revision: {
          type: 'integer',
          minimum: 1,
          maximum: Number.MAX_SAFE_INTEGER
        },
        created_at: { type: 'string', format: 'date-time', maxLength: 64 }
      }
    },
    state: MEMBER_STATE_PROJECTION_DEFINITION,
    narratives: {
      type: 'array',
      minItems: 1,
      maxItems: 1,
      items: NARRATIVE_DELIVERY_JSON_SCHEMA
    },
    shinobi_daily: {
      type: 'array',
      minItems: 1,
      maxItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['daily_id', 'source_turn_id', 'daily'],
        properties: {
          daily_id: {
            type: 'string',
            minLength: 2,
            maxLength: ACTION_LIMITS.identifierMaxLength,
            pattern: IDENTIFIER_PATTERN
          },
          source_turn_id: {
            type: 'string',
            minLength: 2,
            maxLength: ACTION_LIMITS.identifierMaxLength,
            pattern: IDENTIFIER_PATTERN
          },
          // The exact legacy daily shape is enforced by validateShinobiDaily
          // in the runtime contract below. Keeping this unconstrained here
          // avoids maintaining a second divergent JSON schema copy.
          daily: {}
        }
      }
    }
  }
};

export const ACTION_REQUEST_JSON_SCHEMA = immutableContractValue({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  required: [
    'schema',
    'base_state_revision',
    'text',
    'pre_resolution_visibility',
    'narration_preference',
    'idempotency_key'
  ],
  properties: {
    schema: { const: ACTION_REQUEST_SCHEMA },
    base_state_revision: {
      type: 'integer',
      minimum: 0,
      maximum: Number.MAX_SAFE_INTEGER
    },
    text: {
      type: 'string',
      minLength: 1,
      maxLength: ACTION_LIMITS.textMaxLength,
      pattern: SAFE_NONBLANK_TEXT_PATTERN
    },
    pre_resolution_visibility: {
      type: 'string',
      enum: PRE_RESOLUTION_VISIBILITIES
    },
    narration_preference: { type: 'string', enum: NARRATION_PREFERENCES },
    narration_note: {
      type: 'string',
      minLength: 0,
      maxLength: ACTION_LIMITS.narrationNoteMaxLength,
      pattern: SAFE_TEXT_PATTERN
    },
    idempotency_key: {
      type: 'string',
      minLength: 1,
      maxLength: ACTION_LIMITS.idempotencyKeyMaxLength,
      pattern: SAFE_TEXT_PATTERN
    }
  }
});

export const ACTION_RECEIPT_JSON_SCHEMA = immutableContractValue({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  ...receiptDefinition
});

export const ACTION_SUBMISSION_MEMBER_VIEW_JSON_SCHEMA = immutableContractValue({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  ...memberViewDefinition
});

// This alias intentionally names the only ActionSubmission shape that may be
// returned to a member. The internal persisted submission is not a client
// contract.
export const ACTION_SUBMISSION_JSON_SCHEMA = ACTION_SUBMISSION_MEMBER_VIEW_JSON_SCHEMA;

export const ACTION_TURN_MEMBER_PROJECTION_JSON_SCHEMA = immutableContractValue({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  required: [
    'schema',
    'turn_id',
    'turn_no',
    'viewer_seat',
    'status',
    'active_narrative_mode',
    'post_commit_disclosure',
    'actions'
  ],
  properties: {
    schema: { const: ACTION_TURN_MEMBER_PROJECTION_SCHEMA },
    turn_id: {
      type: 'string',
      minLength: 2,
      maxLength: ACTION_LIMITS.identifierMaxLength,
      pattern: IDENTIFIER_PATTERN
    },
    turn_no: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
    turn_kind: { type: 'string', enum: ['ACTION', 'OPENING'] },
    viewer_seat: { type: 'string', enum: ROOM_SEATS },
    status: { type: 'string', enum: TURN_STATUSES },
    active_narrative_mode: { type: 'string', enum: NARRATIVE_MODES },
    post_commit_disclosure: { const: 'full_after_commit' },
    actions: {
      type: 'object',
      additionalProperties: false,
      required: ROOM_SEATS,
      properties: {
        A: { $ref: '#/$defs/action_submission_member_view' },
        B: { $ref: '#/$defs/action_submission_member_view' }
      }
    },
    commit: committedTurnPublicationDefinition,
    generation: TURN_GENERATION_PROGRESS_JSON_SCHEMA
  },
  allOf: [{
    if: { properties: { status: { const: 'COMMITTED' } }, required: ['status'] },
    then: { required: ['commit'] },
    else: { not: { required: ['commit'] } }
  }],
  $defs: {
    action_submission_member_view: memberViewDefinition,
    member_state_canonical_data: MEMBER_STATE_CANONICAL_DATA_DEFINITION
  }
});

export const ACTION_TURN_PROJECTION_JSON_SCHEMA =
  ACTION_TURN_MEMBER_PROJECTION_JSON_SCHEMA;

export const COMMITTED_TURN_PUBLICATION_JSON_SCHEMA = immutableContractValue({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: COMMITTED_TURN_PUBLICATION_SCHEMA,
  ...committedTurnPublicationDefinition,
  $defs: {
    member_state_canonical_data: MEMBER_STATE_CANONICAL_DATA_DEFINITION
  }
});

function assertObject(value, { allowed, required = allowed, path = '', label }) {
  assertPlainRecord(value, path || '/', label);
  return assertExactKeys(value, { allowed, required, path, label });
}

function assertEnum(value, enumValues, path, label) {
  return assertString(value, { path, label, enumValues });
}

function assertActionText(value, path, label) {
  assertString(value, {
    path,
    label,
    max: ACTION_LIMITS.textMaxLength
  });
  if (!value.trim()) {
    throw contractError(path, `${label} must contain a non-whitespace action`);
  }
  return value;
}

function assertIsoTimestamp(value, path, label) {
  assertString(value, { path, label, max: 64 });
  if (!ISO_TIMESTAMP_REGEXP.test(value) || !Number.isFinite(Date.parse(value))) {
    throw contractError(path, `${label} must be an ISO 8601 UTC timestamp`);
  }
  return value;
}

function assertCommittedTurnPublicationAt(value, path, projection) {
  assertObject(value, {
    allowed: ['schema', 'checkpoint', 'state', 'narratives', 'shinobi_daily'],
    path,
    label: 'committed turn publication'
  });
  if (value.schema !== COMMITTED_TURN_PUBLICATION_SCHEMA) {
    throw contractError(
      `${path}/schema`,
      `schema must be ${COMMITTED_TURN_PUBLICATION_SCHEMA}`
    );
  }
  assertObject(value.checkpoint, {
    allowed: ['checkpoint_id', 'commit_id', 'state_revision', 'created_at'],
    path: `${path}/checkpoint`,
    label: 'committed checkpoint projection'
  });
  assertIdentifier(value.checkpoint.checkpoint_id, {
    path: `${path}/checkpoint/checkpoint_id`,
    label: 'checkpoint_id',
    max: ACTION_LIMITS.identifierMaxLength
  });
  assertIdentifier(value.checkpoint.commit_id, {
    path: `${path}/checkpoint/commit_id`,
    label: 'commit_id',
    max: ACTION_LIMITS.identifierMaxLength
  });
  assertInteger(value.checkpoint.state_revision, {
    path: `${path}/checkpoint/state_revision`,
    label: 'state_revision',
    min: 1
  });
  assertIsoTimestamp(
    value.checkpoint.created_at,
    `${path}/checkpoint/created_at`,
    'created_at'
  );

  try {
    assertMemberStateProjection(value.state, {
      viewer_seat: projection.viewer_seat,
      state_revision: value.checkpoint.state_revision
    });
  } catch (error) {
    const nestedPath = error?.details?.path === '/'
      ? ''
      : (error?.details?.path ?? '');
    throw contractError(
      `${path}/state${nestedPath}`,
      error?.message ?? 'member state projection is invalid'
    );
  }

  if (!Array.isArray(value.narratives) || value.narratives.length !== 1) {
    throw contractError(`${path}/narratives`, 'exactly one member narrative is required');
  }
  const expectedAudience = projection.active_narrative_mode === 'shared'
    ? 'shared'
    : `seat:${projection.viewer_seat}`;
  const delivery = value.narratives[0];
  assertObject(delivery, {
    allowed: [
      'schema',
      'turn_id',
      'audience',
      'resolution_commitment',
      'segments',
      'stop_point_ref'
    ],
    path: `${path}/narratives/0`,
    label: 'member narrative delivery'
  });
  if (delivery.schema !== NARRATIVE_DELIVERY_SCHEMA
    || delivery.turn_id !== projection.turn_id
    || delivery.audience !== expectedAudience
    || typeof delivery.resolution_commitment !== 'string'
    || !CONTENT_COMMITMENT_REGEXP.test(delivery.resolution_commitment)) {
    throw contractError(
      `${path}/narratives/0`,
      'narrative delivery differs from the member turn binding'
    );
  }
  assertNarrativeCandidate({
    segments: delivery.segments,
    stop_point_ref: delivery.stop_point_ref
  });

  if (!Array.isArray(value.shinobi_daily) || value.shinobi_daily.length !== 1) {
    throw contractError(`${path}/shinobi_daily`, 'exactly one public shinobi daily is required');
  }
  const daily = value.shinobi_daily[0];
  assertObject(daily, {
    allowed: ['daily_id', 'source_turn_id', 'daily'],
    path: `${path}/shinobi_daily/0`,
    label: 'shinobi daily publication'
  });
  assertIdentifier(daily.daily_id, {
    path: `${path}/shinobi_daily/0/daily_id`,
    label: 'daily_id',
    max: ACTION_LIMITS.identifierMaxLength
  });
  if (daily.source_turn_id !== projection.turn_id) {
    throw contractError(
      `${path}/shinobi_daily/0/source_turn_id`,
      'shinobi daily must originate from the projected turn'
    );
  }
  const dailyValidation = validateShinobiDaily(daily.daily);
  if (!dailyValidation.valid) {
    throw contractError(`${path}/shinobi_daily/0/daily`, 'shinobi daily is invalid', {
      errors: dailyValidation.errors
    });
  }
  return value;
}

export function assertCommittedTurnPublication(value, projection) {
  assertCommittedTurnPublicationAt(value, '', projection);
  return immutableContractValue(value);
}

export function assertActionRequest(value) {
  assertObject(value, {
    allowed: [
      'schema',
      'base_state_revision',
      'text',
      'pre_resolution_visibility',
      'narration_preference',
      'narration_note',
      'idempotency_key'
    ],
    required: [
      'schema',
      'base_state_revision',
      'text',
      'pre_resolution_visibility',
      'narration_preference',
      'idempotency_key'
    ],
    path: '',
    label: 'action request'
  });
  if (value.schema !== ACTION_REQUEST_SCHEMA) {
    throw contractError('/schema', `schema must be ${ACTION_REQUEST_SCHEMA}`);
  }
  assertInteger(value.base_state_revision, {
    path: '/base_state_revision',
    label: 'base_state_revision',
    min: 0
  });
  assertActionText(value.text, '/text', 'text');
  assertEnum(
    value.pre_resolution_visibility,
    PRE_RESOLUTION_VISIBILITIES,
    '/pre_resolution_visibility',
    'pre_resolution_visibility'
  );
  assertEnum(
    value.narration_preference,
    NARRATION_PREFERENCES,
    '/narration_preference',
    'narration_preference'
  );
  if (Object.prototype.hasOwnProperty.call(value, 'narration_note')) {
    assertString(value.narration_note, {
      path: '/narration_note',
      label: 'narration_note',
      min: 0,
      max: ACTION_LIMITS.narrationNoteMaxLength
    });
  }
  assertString(value.idempotency_key, {
    path: '/idempotency_key',
    label: 'idempotency_key',
    max: ACTION_LIMITS.idempotencyKeyMaxLength
  });
  return immutableContractValue(value);
}

export function inspectActionRequest(value) {
  return inspectContract(value, assertActionRequest);
}

function assertActionReceiptAt(value, path) {
  assertObject(value, {
    allowed: [
      'submission_id',
      'seat',
      'receipt_seq',
      'received_at',
      'content_commitment',
      'base_state_revision'
    ],
    path,
    label: 'action receipt'
  });
  assertIdentifier(value.submission_id, {
    path: `${path}/submission_id`,
    label: 'submission_id',
    max: ACTION_LIMITS.identifierMaxLength
  });
  assertEnum(value.seat, ROOM_SEATS, `${path}/seat`, 'seat');
  assertInteger(value.receipt_seq, {
    path: `${path}/receipt_seq`,
    label: 'receipt_seq',
    min: 1,
    max: 2
  });
  assertIsoTimestamp(value.received_at, `${path}/received_at`, 'received_at');
  assertString(value.content_commitment, {
    path: `${path}/content_commitment`,
    label: 'content_commitment',
    min: 76,
    max: 76,
    pattern: CONTENT_COMMITMENT_REGEXP
  });
  assertInteger(value.base_state_revision, {
    path: `${path}/base_state_revision`,
    label: 'base_state_revision',
    min: 0
  });
  return value;
}

export function assertActionReceipt(value) {
  assertActionReceiptAt(value, '');
  return immutableContractValue(value);
}

export function inspectActionReceipt(value) {
  return inspectContract(value, assertActionReceipt);
}

function assertActionSubmissionMemberViewAt(value, path) {
  assertPlainRecord(value, path || '/', 'action submission member view');
  const allowedBase = ['seat', 'locked'];
  assertEnum(value.seat, ROOM_SEATS, `${path}/seat`, 'seat');
  assertBoolean(value.locked, { path: `${path}/locked`, label: 'locked' });

  if (!value.locked) {
    assertExactKeys(value, {
      allowed: allowedBase,
      path,
      label: 'unlocked action member view'
    });
    return value;
  }

  const hasText = Object.prototype.hasOwnProperty.call(value, 'text');
  if (!hasText) {
    assertExactKeys(value, {
      allowed: allowedBase,
      path,
      label: 'hidden action member view'
    });
    return value;
  }

  const visibleBase = ['seat', 'locked', 'submission_id', 'text', 'disclosure'];
  if (value.disclosure === 'owner') {
    assertExactKeys(value, {
      allowed: [...visibleBase, 'receipt'],
      path,
      label: 'owner action member view'
    });
  } else {
    assertExactKeys(value, {
      allowed: visibleBase,
      path,
      label: 'disclosed opponent action member view'
    });
    assertEnum(
      value.disclosure,
      OPPONENT_ACTION_DISCLOSURES,
      `${path}/disclosure`,
      'disclosure'
    );
  }

  assertIdentifier(value.submission_id, {
    path: `${path}/submission_id`,
    label: 'submission_id',
    max: ACTION_LIMITS.identifierMaxLength
  });
  assertActionText(value.text, `${path}/text`, 'text');
  assertEnum(value.disclosure, ACTION_DISCLOSURES, `${path}/disclosure`, 'disclosure');

  if (value.disclosure === 'owner') {
    assertActionReceiptAt(value.receipt, `${path}/receipt`);
    if (value.receipt.seat !== value.seat) {
      throw contractError(`${path}/receipt/seat`, 'receipt seat must match the action seat');
    }
    if (value.receipt.submission_id !== value.submission_id) {
      throw contractError(
        `${path}/receipt/submission_id`,
        'receipt submission_id must match the visible action'
      );
    }
  }
  return value;
}

export function assertActionSubmissionMemberView(value) {
  assertActionSubmissionMemberViewAt(value, '');
  return immutableContractValue(value);
}

export const assertActionSubmission = assertActionSubmissionMemberView;

export function inspectActionSubmissionMemberView(value) {
  return inspectContract(value, assertActionSubmissionMemberView);
}

export const inspectActionSubmission = inspectActionSubmissionMemberView;

export function assertActionTurnMemberProjection(value) {
  assertObject(value, {
    allowed: [
      'schema',
      'turn_id',
      'turn_no',
      'turn_kind',
      'viewer_seat',
      'status',
      'active_narrative_mode',
      'post_commit_disclosure',
      'actions',
      'commit',
      'generation'
    ],
    required: [
      'schema',
      'turn_id',
      'turn_no',
      'viewer_seat',
      'status',
      'active_narrative_mode',
      'post_commit_disclosure',
      'actions'
    ],
    path: '',
    label: 'action turn member projection'
  });
  if (value.schema !== ACTION_TURN_MEMBER_PROJECTION_SCHEMA) {
    throw contractError('/schema', `schema must be ${ACTION_TURN_MEMBER_PROJECTION_SCHEMA}`);
  }
  assertIdentifier(value.turn_id, {
    path: '/turn_id',
    label: 'turn_id',
    max: ACTION_LIMITS.identifierMaxLength
  });
  assertInteger(value.turn_no, { path: '/turn_no', label: 'turn_no', min: 1 });
  if (Object.prototype.hasOwnProperty.call(value, 'turn_kind')) {
    assertEnum(value.turn_kind, ['ACTION', 'OPENING'], '/turn_kind', 'turn_kind');
  }
  assertEnum(value.viewer_seat, ROOM_SEATS, '/viewer_seat', 'viewer_seat');
  assertEnum(value.status, TURN_STATUSES, '/status', 'status');
  if (value.generation !== undefined) assertTurnGenerationProgress(value.generation);
  assertEnum(
    value.active_narrative_mode,
    NARRATIVE_MODES,
    '/active_narrative_mode',
    'active_narrative_mode'
  );
  if (value.post_commit_disclosure !== 'full_after_commit') {
    throw contractError(
      '/post_commit_disclosure',
      'post_commit_disclosure must be full_after_commit'
    );
  }
  assertObject(value.actions, {
    allowed: ROOM_SEATS,
    path: '/actions',
    label: 'actions'
  });

  for (const seat of ROOM_SEATS) {
    assertActionSubmissionMemberViewAt(value.actions[seat], `/actions/${seat}`);
    if (value.actions[seat].seat !== seat) {
      throw contractError(`/actions/${seat}/seat`, 'action seat must match its projection slot');
    }
  }

  const ownerAction = value.actions[value.viewer_seat];
  const opponentSeat = value.viewer_seat === 'A' ? 'B' : 'A';
  const opponentAction = value.actions[opponentSeat];

  if (ownerAction.locked && ownerAction.disclosure !== 'owner') {
    throw contractError(
      `/actions/${value.viewer_seat}/disclosure`,
      'a locked owner action must use the owner disclosure with its private receipt'
    );
  }
  if (opponentAction.disclosure === 'owner') {
    throw contractError(
      `/actions/${opponentSeat}/disclosure`,
      'an opponent action cannot expose the owner disclosure or receipt'
    );
  }
  if (value.status !== 'COMMITTED'
    && opponentAction.disclosure === 'open_pre_resolution'
    && ownerAction.locked
    && ownerAction.receipt.receipt_seq !== 2) {
    throw contractError(
      `/actions/${value.viewer_seat}/receipt/receipt_seq`,
      'only the first locked action can be revealed before the opponent submits'
    );
  }

  if (value.status === 'COMMITTED') {
    if (!ownerAction.locked || !opponentAction.locked || !opponentAction.text) {
      throw contractError(
        '/actions',
        'a committed turn must disclose both locked action texts to the member'
      );
    }
    if (opponentAction.disclosure !== 'full_after_commit') {
      throw contractError(
        `/actions/${opponentSeat}/disclosure`,
        'a committed opponent action must use full_after_commit disclosure'
      );
    }
    if (!Object.prototype.hasOwnProperty.call(value, 'commit')) {
      throw contractError('/commit', 'a committed turn must include its member publication');
    }
    assertCommittedTurnPublicationAt(value.commit, '/commit', value);
  } else if (opponentAction.disclosure === 'full_after_commit') {
    throw contractError(
      `/actions/${opponentSeat}/disclosure`,
      'full_after_commit disclosure is forbidden before COMMITTED'
    );
  } else if (Object.prototype.hasOwnProperty.call(value, 'commit')) {
    throw contractError('/commit', 'committed outputs are forbidden before COMMITTED');
  }

  if (ownerAction.submission_id
    && opponentAction.submission_id
    && ownerAction.submission_id === opponentAction.submission_id) {
    throw contractError('/actions', 'the two visible actions must have distinct submission_id values');
  }

  return immutableContractValue(value);
}

export const assertActionTurnProjection = assertActionTurnMemberProjection;

export function inspectActionTurnMemberProjection(value) {
  return inspectContract(value, assertActionTurnMemberProjection);
}

export const inspectActionTurnProjection = inspectActionTurnMemberProjection;
