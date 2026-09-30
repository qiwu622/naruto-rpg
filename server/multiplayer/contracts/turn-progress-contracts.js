import { assertExactKeys, assertInteger, assertPlainRecord, assertString } from './common.js';

export const MODEL_PROGRESS_STATUSES = Object.freeze({
  referee: 'RESOLVING',
  resolution_repair: 'RESOLVING',
  resolution_completeness_reviewer: 'RESOLVING',
  writer: 'RENDERING',
  narrative_grounding_reviewer: 'AUDITING',
  continuity_steward: 'STAGING_UPDATES',
  continuity_repair: 'REPAIRING_DRAFT'
});

const textFields = ['model_stage', 'run_status', 'started_at', 'updated_at', 'heartbeat_at',
  'resume_stage', 'reason', 'error_code', 'failure_kind'];
const countFields = ['attempt', 'repair_attempts', 'remaining_items'];
const keys = [...textFields, ...countFields];

export const TURN_GENERATION_PROGRESS_JSON_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false, required: keys,
  properties: Object.fromEntries([
    ...textFields.map(key => [key, { type: ['string', 'null'], maxLength: 160 }]),
    ...countFields.map(key => [key, { type: ['integer', 'null'], minimum: 0, maximum: Number.MAX_SAFE_INTEGER }])
  ])
});

/** Operational metadata only; never include model text, refs, actors or credentials. */
export function assertTurnGenerationProgress(value) {
  assertPlainRecord(value, { path: '/generation', label: 'generation progress' });
  assertExactKeys(value, { allowed: keys, required: keys, path: '/generation' });
  for (const key of textFields) {
    if (value[key] !== null) assertString(value[key], { path: `/generation/${key}`, max: 160, min: 1 });
  }
  for (const key of countFields) {
    if (value[key] !== null) assertInteger(value[key], { path: `/generation/${key}`, min: 0 });
  }
  return value;
}
