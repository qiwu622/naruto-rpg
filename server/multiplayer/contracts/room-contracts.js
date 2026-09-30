import {
  NARRATIVE_MODES,
  ROOM_LIFECYCLES,
  ROOM_SEATS,
  TURN_STATUSES
} from './enums.js';
import {
  assertExactKeys,
  assertInteger,
  assertPlainRecord,
  assertString,
  contractError,
  immutableContractValue,
  inspectContract
} from './common.js';

export const TURN_EXECUTION_PLAN_SCHEMA = 'naruto.multiplayer-turn-execution-plan/v1';
const EXECUTION_PLAN_SCHEMA = TURN_EXECUTION_PLAN_SCHEMA;

export const ROOM_CONTROL_SCHEMA = 'naruto.multiplayer-room-control/v1';
export const NARRATIVE_MODE_CHANGE_REQUEST_SCHEMA =
  'naruto.multiplayer-narrative-mode-change-request/v1';
export const CONTROL_IDEMPOTENCY_KEY_MAX_LENGTH = 200;

const SHA256_PATTERN = '^sha256:[a-f0-9]{64}$';
const SHA256_REGEXP = /^sha256:[a-f0-9]{64}$/u;
const SAFE_TEXT_PATTERN =
  '^(?![\\s\\S]*[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F-\\u009F\\u202A-\\u202E\\u2066-\\u2069])[\\s\\S]*$';

const nullableNarrativeModeSchema = {
  oneOf: [
    { type: 'string', enum: NARRATIVE_MODES },
    { type: 'null' }
  ]
};

const nullableTurnStatusSchema = {
  oneOf: [
    { type: 'string', enum: TURN_STATUSES },
    { type: 'null' }
  ]
};

const seatPairSchema = {
  type: 'object',
  additionalProperties: false,
  required: ROOM_SEATS,
  properties: {
    A: { type: 'string', enum: ROOM_SEATS },
    B: { type: 'string', enum: ROOM_SEATS }
  }
};

const hashPairSchema = {
  type: 'object',
  additionalProperties: false,
  required: ROOM_SEATS,
  properties: {
    A: { type: 'string', pattern: SHA256_PATTERN },
    B: { type: 'string', pattern: SHA256_PATTERN }
  }
};

export const NARRATIVE_MODE_CHANGE_REQUEST_JSON_SCHEMA = immutableContractValue({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  required: ['expected_control_revision', 'mode', 'idempotency_key'],
  properties: {
    expected_control_revision: {
      type: 'integer',
      minimum: 0,
      maximum: Number.MAX_SAFE_INTEGER
    },
    mode: { type: 'string', enum: NARRATIVE_MODES },
    idempotency_key: {
      type: 'string',
      minLength: 1,
      maxLength: CONTROL_IDEMPOTENCY_KEY_MAX_LENGTH,
      pattern: SAFE_TEXT_PATTERN
    }
  }
});

export const ROOM_CONTROL_JSON_SCHEMA = immutableContractValue({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  required: [
    'schema',
    'control_revision',
    'event_seq',
    'room_lifecycle',
    'turn_status',
    'active_narrative_mode',
    'queued_narrative_mode'
  ],
  properties: {
    schema: { const: ROOM_CONTROL_SCHEMA },
    control_revision: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    event_seq: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    room_lifecycle: { type: 'string', enum: ROOM_LIFECYCLES },
    turn_status: nullableTurnStatusSchema,
    active_narrative_mode: { type: 'string', enum: NARRATIVE_MODES },
    queued_narrative_mode: nullableNarrativeModeSchema
  }
});

export const TURN_EXECUTION_PLAN_JSON_SCHEMA = immutableContractValue({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  required: [
    'schema',
    'narrative_mode',
    'turn_payer_selection_hash',
    'pov_writer_selection_hashes',
    'writer_payer_by_audience',
    'model_config_fingerprints'
  ],
  properties: {
    schema: { const: EXECUTION_PLAN_SCHEMA },
    narrative_mode: { type: 'string', enum: NARRATIVE_MODES },
    turn_payer_selection_hash: { type: 'string', pattern: SHA256_PATTERN },
    pov_writer_selection_hashes: {
      oneOf: [hashPairSchema, { type: 'null' }]
    },
    writer_payer_by_audience: {
      oneOf: [seatPairSchema, { type: 'null' }]
    },
    model_config_fingerprints: {
      type: 'object',
      additionalProperties: false,
      required: ['shared_stage', 'pov_writers'],
      properties: {
        shared_stage: { type: 'string', pattern: SHA256_PATTERN },
        pov_writers: {
          oneOf: [hashPairSchema, { type: 'null' }]
        }
      }
    }
  },
  allOf: [
    {
      if: {
        required: ['narrative_mode'],
        properties: { narrative_mode: { const: 'shared' } }
      },
      then: {
        properties: {
          pov_writer_selection_hashes: { type: 'null' },
          writer_payer_by_audience: { type: 'null' },
          model_config_fingerprints: {
            properties: { pov_writers: { type: 'null' } }
          }
        }
      }
    },
    {
      if: {
        required: ['narrative_mode'],
        properties: { narrative_mode: { const: 'dual_pov' } }
      },
      then: {
        properties: {
          pov_writer_selection_hashes: hashPairSchema,
          writer_payer_by_audience: seatPairSchema,
          model_config_fingerprints: {
            properties: { pov_writers: hashPairSchema }
          }
        }
      }
    }
  ]
});

function assertObject(value, { allowed, required = allowed, path = '', label }) {
  assertPlainRecord(value, path || '/', label);
  return assertExactKeys(value, { allowed, required, path, label });
}

function assertEnum(value, enumValues, path, label) {
  return assertString(value, { path, label, enumValues });
}

function assertSha256(value, path, label) {
  return assertString(value, {
    path,
    label,
    min: 71,
    max: 71,
    pattern: SHA256_REGEXP
  });
}

function assertHashPair(value, path, label) {
  assertObject(value, { allowed: ROOM_SEATS, path, label });
  for (const seat of ROOM_SEATS) {
    assertSha256(value[seat], `${path}/${seat}`, `${label}.${seat}`);
  }
  return value;
}

function assertSeatPair(value, path, label) {
  assertObject(value, { allowed: ROOM_SEATS, path, label });
  for (const seat of ROOM_SEATS) {
    assertEnum(value[seat], ROOM_SEATS, `${path}/${seat}`, `${label}.${seat}`);
  }
  return value;
}

export function assertNarrativeModeChangeRequest(value) {
  assertObject(value, {
    allowed: ['expected_control_revision', 'mode', 'idempotency_key'],
    path: '',
    label: 'narrative mode change request'
  });
  assertInteger(value.expected_control_revision, {
    path: '/expected_control_revision',
    label: 'expected_control_revision',
    min: 0
  });
  assertEnum(value.mode, NARRATIVE_MODES, '/mode', 'mode');
  assertString(value.idempotency_key, {
    path: '/idempotency_key',
    label: 'idempotency_key',
    max: CONTROL_IDEMPOTENCY_KEY_MAX_LENGTH
  });
  return immutableContractValue(value);
}

export function inspectNarrativeModeChangeRequest(value) {
  return inspectContract(value, assertNarrativeModeChangeRequest);
}

export function assertRoomControl(value) {
  assertObject(value, {
    allowed: [
      'schema',
      'control_revision',
      'event_seq',
      'room_lifecycle',
      'turn_status',
      'active_narrative_mode',
      'queued_narrative_mode'
    ],
    path: '',
    label: 'room control'
  });
  if (value.schema !== ROOM_CONTROL_SCHEMA) {
    throw contractError('/schema', `schema must be ${ROOM_CONTROL_SCHEMA}`);
  }
  assertInteger(value.control_revision, {
    path: '/control_revision',
    label: 'control_revision',
    min: 0
  });
  assertInteger(value.event_seq, { path: '/event_seq', label: 'event_seq', min: 0 });
  assertEnum(value.room_lifecycle, ROOM_LIFECYCLES, '/room_lifecycle', 'room_lifecycle');
  if (value.turn_status !== null) {
    assertEnum(value.turn_status, TURN_STATUSES, '/turn_status', 'turn_status');
  }
  assertEnum(
    value.active_narrative_mode,
    NARRATIVE_MODES,
    '/active_narrative_mode',
    'active_narrative_mode'
  );
  if (value.queued_narrative_mode !== null) {
    assertEnum(
      value.queued_narrative_mode,
      NARRATIVE_MODES,
      '/queued_narrative_mode',
      'queued_narrative_mode'
    );
    if (value.queued_narrative_mode === value.active_narrative_mode) {
      throw contractError(
        '/queued_narrative_mode',
        'queued_narrative_mode must be null when it matches active_narrative_mode'
      );
    }
  }
  return immutableContractValue(value);
}

export function inspectRoomControl(value) {
  return inspectContract(value, assertRoomControl);
}

export function assertTurnExecutionPlan(value) {
  assertObject(value, {
    allowed: [
      'schema',
      'narrative_mode',
      'turn_payer_selection_hash',
      'pov_writer_selection_hashes',
      'writer_payer_by_audience',
      'model_config_fingerprints'
    ],
    path: '',
    label: 'turn execution plan'
  });
  if (value.schema !== EXECUTION_PLAN_SCHEMA) {
    throw contractError('/schema', `schema must be ${EXECUTION_PLAN_SCHEMA}`);
  }
  assertEnum(value.narrative_mode, NARRATIVE_MODES, '/narrative_mode', 'narrative_mode');
  assertSha256(
    value.turn_payer_selection_hash,
    '/turn_payer_selection_hash',
    'turn_payer_selection_hash'
  );

  assertObject(value.model_config_fingerprints, {
    allowed: ['shared_stage', 'pov_writers'],
    path: '/model_config_fingerprints',
    label: 'model_config_fingerprints'
  });
  assertSha256(
    value.model_config_fingerprints.shared_stage,
    '/model_config_fingerprints/shared_stage',
    'model_config_fingerprints.shared_stage'
  );

  if (value.narrative_mode === 'shared') {
    for (const [field, candidate] of [
      ['pov_writer_selection_hashes', value.pov_writer_selection_hashes],
      ['writer_payer_by_audience', value.writer_payer_by_audience],
      ['model_config_fingerprints/pov_writers', value.model_config_fingerprints.pov_writers]
    ]) {
      if (candidate !== null) {
        throw contractError(`/${field}`, `${field.replace('/', '.')} must be null in shared mode`);
      }
    }
  } else {
    assertHashPair(
      value.pov_writer_selection_hashes,
      '/pov_writer_selection_hashes',
      'pov_writer_selection_hashes'
    );
    assertSeatPair(
      value.writer_payer_by_audience,
      '/writer_payer_by_audience',
      'writer_payer_by_audience'
    );
    assertHashPair(
      value.model_config_fingerprints.pov_writers,
      '/model_config_fingerprints/pov_writers',
      'model_config_fingerprints.pov_writers'
    );
  }

  return immutableContractValue(value);
}

export function inspectTurnExecutionPlan(value) {
  return inspectContract(value, assertTurnExecutionPlan);
}
