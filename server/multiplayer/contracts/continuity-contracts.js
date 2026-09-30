import { validateShinobiDaily } from '../../../js/core/shinobi-daily.js';
import {
  assertArray,
  assertExactKeys,
  assertIdentifier,
  assertInteger,
  assertPlainRecord,
  assertString,
  immutableContractValue,
  inspectContract
} from './common.js';
import {
  CONTINUITY_OPERATIONS,
  CONTINUITY_PAUSE_REASONS,
  CONTINUITY_RESULT_STATUSES,
  CONTINUITY_RETRY_OWNERS,
  DOMAIN_CHECK_REASON_CODES
} from './enums.js';
import { DomainError } from '../domain/errors.js';

export const DOMAIN_CHECK_ITEM_SCHEMA = 'naruto.domain-check-item/v1';
export const MEMORY_ARTIFACT_ITEM_SCHEMA = 'naruto.memory-artifact-item/v1';
export const SHINOBI_DAILY_ARTIFACT_ITEM_SCHEMA = 'naruto.shinobi-daily-artifact-item/v1';
export const TURN_BUNDLE_PATCH_SCHEMA = 'naruto.turn-bundle-patch/v1';
export const REPAIR_PLAN_SCHEMA = 'naruto.continuity-repair-plan/v1';
export const CONTINUITY_BUNDLE_RESULT_SCHEMA = 'naruto.continuity-bundle-result/v1';
export const CONTINUITY_JSON_ENVELOPE_SCHEMA = 'naruto.continuity-json/v1';

const OBLIGATION_ID = /^obligation_[A-Za-z0-9_-]{1,120}$/;
const EFFECT_ID = /^effect_[A-Za-z0-9_-]{1,80}$/;
const STABLE_REF = /^[A-Za-z][A-Za-z0-9:_-]{1,159}$/;
const MEMORY_KINDS = Object.freeze(['fact', 'pin']);

const DOMAIN_KEYS = Object.freeze([
  'obligation_id',
  'reason_code',
  'evidence_event_ids'
]);
const MEMORY_KEYS = Object.freeze([
  'obligation_id',
  'summary',
  'entries',
  'supersede_entry_ids',
  'retract_entry_ids'
]);
const MEMORY_ENTRY_KEYS = Object.freeze([
  'kind',
  'text',
  'event_refs',
  'subject_refs'
]);
const DAILY_KEYS = Object.freeze(['obligation_id', 'daily', 'source_refs']);
const DAILY_SOURCE_KEYS = Object.freeze(['headline', 'world', 'flavor', 'missions', 'quote']);
const PATCH_KEYS = Object.freeze(['effect_ids', 'domain_checks', 'memories', 'shinobi_daily']);
const REPAIR_PLAN_KEYS = Object.freeze([
  'schema',
  'draft_revision',
  'reviewed_semantic_draft_hash',
  'allowed_effect_ids',
  'allowed_obligation_ids',
  'allowed_paths'
]);
const RESULT_KEYS = Object.freeze([
  'schema',
  'status',
  'draft_revision',
  'retryable_by',
  'pause_reason',
  'turn_state',
  'resume_stage',
  'accepted',
  'idempotent',
  'errors',
  'review',
  'next_operation',
  'allowed_effect_ids',
  'allowed_obligation_ids',
  'allowed_paths',
  'ready_receipt'
]);

const idSchema = (pattern, maxLength) => ({
  type: 'string',
  pattern,
  maxLength
});

export const DOMAIN_CHECK_ITEM_JSON_SCHEMA = immutableContractValue({
  $id: DOMAIN_CHECK_ITEM_SCHEMA,
  type: 'object',
  additionalProperties: false,
  required: DOMAIN_KEYS,
  properties: {
    obligation_id: idSchema('^obligation_[A-Za-z0-9_-]{1,120}$', 131),
    reason_code: { type: 'string', enum: DOMAIN_CHECK_REASON_CODES },
    evidence_event_ids: {
      type: 'array',
      maxItems: 64,
      uniqueItems: true,
      items: idSchema('^[A-Za-z][A-Za-z0-9:_-]{1,159}$', 160)
    }
  }
});

export const MEMORY_ARTIFACT_ITEM_JSON_SCHEMA = immutableContractValue({
  $id: MEMORY_ARTIFACT_ITEM_SCHEMA,
  type: 'object',
  additionalProperties: false,
  required: MEMORY_KEYS,
  properties: {
    obligation_id: idSchema('^obligation_[A-Za-z0-9_-]{1,120}$', 131),
    summary: { type: 'string', minLength: 1, maxLength: 2_000 },
    entries: {
      type: 'array',
      minItems: 1,
      maxItems: 128,
      items: {
        type: 'object',
        additionalProperties: false,
        required: MEMORY_ENTRY_KEYS,
        properties: {
          kind: { type: 'string', enum: MEMORY_KINDS },
          text: { type: 'string', minLength: 1, maxLength: 2_000 },
          event_refs: {
            type: 'array', minItems: 1, maxItems: 32, uniqueItems: true,
            items: idSchema('^[A-Za-z][A-Za-z0-9:_-]{1,159}$', 160)
          },
          subject_refs: {
            type: 'array', minItems: 1, maxItems: 32, uniqueItems: true,
            items: idSchema('^[A-Za-z][A-Za-z0-9:_-]{1,159}$', 160)
          }
        }
      }
    },
    supersede_entry_ids: {
      type: 'array', maxItems: 64, uniqueItems: true,
      items: idSchema('^[A-Za-z][A-Za-z0-9:_-]{1,159}$', 160)
    },
    retract_entry_ids: {
      type: 'array', maxItems: 64, uniqueItems: true,
      items: idSchema('^[A-Za-z][A-Za-z0-9:_-]{1,159}$', 160)
    }
  }
});

export const SHINOBI_DAILY_ARTIFACT_ITEM_JSON_SCHEMA = immutableContractValue({
  $id: SHINOBI_DAILY_ARTIFACT_ITEM_SCHEMA,
  type: 'object',
  additionalProperties: false,
  required: DAILY_KEYS,
  properties: {
    obligation_id: idSchema('^obligation_[A-Za-z0-9_-]{1,120}$', 131),
    daily: { $ref: 'naruto.shinobi-daily/v1' },
    source_refs: {
      type: 'object',
      additionalProperties: false,
      required: DAILY_SOURCE_KEYS,
      properties: {
        headline: { $ref: '#/$defs/refList' },
        world: { type: 'array', minItems: 4, maxItems: 4, items: { $ref: '#/$defs/refList' } },
        flavor: { type: 'array', minItems: 3, maxItems: 3, items: { $ref: '#/$defs/refList' } },
        missions: { type: 'array', minItems: 4, maxItems: 4, items: { $ref: '#/$defs/refList' } },
        quote: { $ref: '#/$defs/refList' }
      }
    }
  },
  $defs: {
    refList: {
      type: 'array', minItems: 1, maxItems: 32, uniqueItems: true,
      items: idSchema('^public:[A-Za-z0-9:_-]{1,152}$', 160)
    }
  }
});

export const CONTINUITY_JSON_ENVELOPE_JSON_SCHEMA = immutableContractValue({
  $id: CONTINUITY_JSON_ENVELOPE_SCHEMA,
  type: 'object',
  additionalProperties: false,
  required: ['protocol', 'operation', 'bundle'],
  properties: {
    protocol: { const: CONTINUITY_JSON_ENVELOPE_SCHEMA },
    operation: { type: 'string', enum: CONTINUITY_OPERATIONS },
    bundle: { $ref: TURN_BUNDLE_PATCH_SCHEMA }
  }
});

export const REPAIR_PLAN_JSON_SCHEMA = immutableContractValue({
  $id: REPAIR_PLAN_SCHEMA,
  type: 'object',
  additionalProperties: false,
  required: REPAIR_PLAN_KEYS,
  properties: {
    schema: { const: REPAIR_PLAN_SCHEMA },
    draft_revision: { type: 'integer', minimum: 0 },
    reviewed_semantic_draft_hash: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' },
    allowed_effect_ids: {
      type: 'array', maxItems: 256, uniqueItems: true,
      items: idSchema('^effect_[A-Za-z0-9_-]{1,80}$', 87)
    },
    allowed_obligation_ids: {
      type: 'array', maxItems: 256, uniqueItems: true,
      items: idSchema('^obligation_[A-Za-z0-9_-]{1,120}$', 131)
    },
    allowed_paths: {
      type: 'array', maxItems: 256,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'id', 'json_pointers'],
        properties: {
          kind: { type: 'string', enum: ['domain_check', 'memory', 'shinobi_daily'] },
          id: idSchema('^obligation_[A-Za-z0-9_-]{1,120}$', 131),
          json_pointers: {
            type: 'array', minItems: 1, maxItems: 128, uniqueItems: true,
            items: { type: 'string', pattern: '^/' }
          }
        }
      }
    }
  }
});

export const CONTINUITY_BUNDLE_RESULT_JSON_SCHEMA = immutableContractValue({
  $id: CONTINUITY_BUNDLE_RESULT_SCHEMA,
  type: 'object',
  additionalProperties: false,
  required: RESULT_KEYS,
  properties: {
    schema: { const: CONTINUITY_BUNDLE_RESULT_SCHEMA },
    status: { type: 'string', enum: CONTINUITY_RESULT_STATUSES },
    draft_revision: { type: 'integer', minimum: 0 },
    retryable_by: { type: 'string', enum: CONTINUITY_RETRY_OWNERS },
    pause_reason: { anyOf: [{ type: 'null' }, { type: 'string', enum: CONTINUITY_PAUSE_REASONS }] },
    turn_state: { anyOf: [{ type: 'null' }, { type: 'string', minLength: 1, maxLength: 64 }] },
    resume_stage: { anyOf: [{ type: 'null' }, { type: 'string', minLength: 1, maxLength: 64 }] },
    accepted: { type: 'array', maxItems: 512 },
    idempotent: { type: 'array', maxItems: 512 },
    errors: { type: 'array', maxItems: 512 },
    review: { anyOf: [{ type: 'null' }, { type: 'object' }] },
    next_operation: { anyOf: [{ type: 'null' }, { type: 'string', enum: CONTINUITY_OPERATIONS }] },
    allowed_effect_ids: REPAIR_PLAN_JSON_SCHEMA.properties.allowed_effect_ids,
    allowed_obligation_ids: REPAIR_PLAN_JSON_SCHEMA.properties.allowed_obligation_ids,
    allowed_paths: REPAIR_PLAN_JSON_SCHEMA.properties.allowed_paths,
    ready_receipt: { anyOf: [{ type: 'null' }, { type: 'object' }] }
  },
  allOf: [
    {
      if: { properties: { status: { const: 'READY' } } },
      then: {
        properties: {
          retryable_by: { const: 'none' },
          next_operation: { const: null },
          allowed_effect_ids: { maxItems: 0 },
          allowed_obligation_ids: { maxItems: 0 },
          allowed_paths: { maxItems: 0 },
          ready_receipt: { type: 'object' }
        }
      }
    },
    {
      if: { properties: { status: { const: 'REPAIR_REQUIRED' } } },
      then: {
        properties: {
          retryable_by: { const: 'continuity' },
          next_operation: { const: 'repair_turn_bundle' }
        }
      }
    }
  ]
});

export const TURN_BUNDLE_PATCH_JSON_SCHEMA = immutableContractValue({
  $id: TURN_BUNDLE_PATCH_SCHEMA,
  type: 'object',
  additionalProperties: false,
  properties: {
    effect_ids: {
      type: 'array', maxItems: 256,
      items: idSchema('^effect_[A-Za-z0-9_-]{1,80}$', 87)
    },
    domain_checks: { type: 'array', maxItems: 128, items: { $ref: DOMAIN_CHECK_ITEM_SCHEMA } },
    memories: { type: 'array', maxItems: 128, items: { $ref: MEMORY_ARTIFACT_ITEM_SCHEMA } },
    shinobi_daily: { type: 'array', maxItems: 1, items: { $ref: SHINOBI_DAILY_ARTIFACT_ITEM_SCHEMA } }
  }
});

function assertObligationId(value, path = '/obligation_id') {
  return assertString(value, {
    path,
    label: 'obligation_id',
    min: 12,
    max: 131,
    pattern: OBLIGATION_ID
  });
}

function assertStableRef(value, path, label = 'reference') {
  return assertString(value, { path, label, min: 2, max: 160, pattern: STABLE_REF });
}

function assertUniqueRefArray(value, path, {
  min = 0,
  max = 64,
  allowed = null,
  label = 'references'
} = {}) {
  assertArray(value, {
    path,
    label,
    min,
    max,
    item: (item, itemPath) => assertStableRef(item, itemPath),
    uniqueBy: item => item
  });
  if (allowed) {
    for (let index = 0; index < value.length; index += 1) {
      if (!allowed.has(value[index])) {
        const choices = [...allowed].slice(0, 8);
        const hint = choices.length ? choices.join(', ') : '(none)';
        throw new DomainError('AUDIENCE_VIOLATION', `${label} contains a reference outside its bound projection. Allowed ${label}: ${hint}${allowed.size > choices.length ? '; see trusted_reference_bindings for the full list' : ''}`, {
          path: `${path}/${index}`,
          allowed_paths: [path]
        });
      }
    }
  }
  return [...value];
}

export function assertDomainCheckItem(value, options = {}) {
  assertExactKeys(value, {
    allowed: DOMAIN_KEYS,
    required: DOMAIN_KEYS,
    path: '/',
    label: 'domain check item'
  });
  const obligationId = assertObligationId(value.obligation_id);
  assertString(value.reason_code, {
    path: '/reason_code', label: 'reason_code', min: 1, max: 64,
    enumValues: DOMAIN_CHECK_REASON_CODES
  });
  const allowedEvidence = options.allowedEvidenceEventIds
    ? new Set(options.allowedEvidenceEventIds)
    : null;
  const evidence = assertUniqueRefArray(value.evidence_event_ids, '/evidence_event_ids', {
    max: 64,
    allowed: allowedEvidence,
    label: 'evidence_event_ids'
  });
  if (options.expectedObligationId && obligationId !== options.expectedObligationId) {
    throw new DomainError('INVALID_ITEM_CONTRACT', 'domain check changed its bound obligation', {
      path: '/obligation_id', allowed_paths: []
    });
  }
  return immutableContractValue({
    obligation_id: obligationId,
    reason_code: value.reason_code,
    evidence_event_ids: evidence
  });
}

export function inspectDomainCheckItem(value, options) {
  return inspectContract(value, item => assertDomainCheckItem(item, options));
}

function assertEntryIdArray(value, path, modifiableIds) {
  const refs = assertUniqueRefArray(value, path, { max: 64, label: 'memory entry IDs' });
  if (modifiableIds) {
    const allowed = new Set(modifiableIds);
    for (let index = 0; index < refs.length; index += 1) {
      if (!allowed.has(refs[index])) {
        throw new DomainError('AUDIENCE_VIOLATION', 'memory item cannot change an entry outside its bound partition', {
          path: `${path}/${index}`, allowed_paths: [path]
        });
      }
    }
  }
  return refs;
}

export function assertMemoryArtifactItem(value, options = {}) {
  assertExactKeys(value, {
    allowed: MEMORY_KEYS,
    required: MEMORY_KEYS,
    path: '/',
    label: 'memory artifact item'
  });
  const obligationId = assertObligationId(value.obligation_id);
  if (options.expectedObligationId && obligationId !== options.expectedObligationId) {
    throw new DomainError('INVALID_ITEM_CONTRACT', 'memory item changed its bound obligation', {
      path: '/obligation_id', allowed_paths: []
    });
  }
  const summary = assertString(value.summary, {
    path: '/summary', label: 'summary', min: 1, max: 2_000
  });
  const allowedEvents = options.audienceEventIds ? new Set(options.audienceEventIds) : null;
  const allowedSubjects = options.stableSubjectIds ? new Set(options.stableSubjectIds) : null;
  assertArray(value.entries, {
    path: '/entries', label: 'entries', min: 1, max: 128
  });
  const entries = value.entries.map((entry, index) => {
    const path = `/entries/${index}`;
    assertExactKeys(entry, {
      allowed: MEMORY_ENTRY_KEYS,
      required: MEMORY_ENTRY_KEYS,
      path,
      label: 'memory entry'
    });
    const kind = assertString(entry.kind, {
      path: `${path}/kind`, label: 'memory kind', min: 1, max: 16, enumValues: MEMORY_KINDS
    });
    const text = assertString(entry.text, {
      path: `${path}/text`, label: 'memory text', min: 1, max: 2_000
    });
    const eventRefs = assertUniqueRefArray(entry.event_refs, `${path}/event_refs`, {
      min: 1, max: 32, allowed: allowedEvents, label: 'event_refs'
    });
    const subjectRefs = assertUniqueRefArray(entry.subject_refs, `${path}/subject_refs`, {
      min: 1, max: 32, allowed: allowedSubjects, label: 'subject_refs'
    });
    return { kind, text, event_refs: eventRefs, subject_refs: subjectRefs };
  });
  const supersedeIds = assertEntryIdArray(
    value.supersede_entry_ids,
    '/supersede_entry_ids',
    options.modifiableEntryIds
  );
  const retractIds = assertEntryIdArray(
    value.retract_entry_ids,
    '/retract_entry_ids',
    options.modifiableEntryIds
  );
  const overlap = supersedeIds.find(id => retractIds.includes(id));
  if (overlap) {
    throw new DomainError('SCHEMA_VIOLATION', 'the same memory entry cannot be superseded and retracted together', {
      path: '/retract_entry_ids', entry_id: overlap
    });
  }
  return immutableContractValue({
    obligation_id: obligationId,
    summary,
    entries,
    supersede_entry_ids: supersedeIds,
    retract_entry_ids: retractIds
  });
}

export function inspectMemoryArtifactItem(value, options) {
  return inspectContract(value, item => assertMemoryArtifactItem(item, options));
}

function assertPublicRefList(value, path, publicRefs) {
  assertArray(value, { path, label: 'public source refs', min: 1, max: 32 });
  if (value.some(Array.isArray)) {
    const example = [...(publicRefs ?? ['public:event_example'])][0] ?? 'public:event_example';
    throw new DomainError('SCHEMA_VIOLATION', `${path} 必须是一维字符串数组，例如 ${JSON.stringify([example])}；不能再套一层数组。headline 和 quote 都是一维，world/flavor/missions 才是二维。`, {
      path, allowed_paths: [path]
    });
  }
  const seen = new Set();
  return value.map((ref, index) => {
    assertString(ref, {
      path: `${path}/${index}`,
      label: 'public source ref',
      min: 8,
      max: 160,
      pattern: /^public:[A-Za-z0-9:_-]{1,152}$/
    });
    if (seen.has(ref)) {
      throw new DomainError('SCHEMA_VIOLATION', 'public source refs must be unique', {
        path: `${path}/${index}`
      });
    }
    seen.add(ref);
    if (publicRefs && !publicRefs.has(ref)) {
      throw new DomainError('AUDIENCE_VIOLATION', `daily source is outside WorldPublicProjection: ${ref}. 只允许 ${[...publicRefs].slice(0, 12).join(', ')}；同时删除或改写日报中依赖非公开事件的内容，不得只换成无关引用。`, {
        path: `${path}/${index}`, allowed_paths: ['/source_refs', '/daily']
      });
    }
    return ref;
  });
}

export function assertShinobiDailyArtifactItem(value, options = {}) {
  assertExactKeys(value, {
    allowed: DAILY_KEYS,
    required: DAILY_KEYS,
    path: '/',
    label: 'shinobi daily artifact item'
  });
  const obligationId = assertObligationId(value.obligation_id);
  if (options.expectedObligationId && obligationId !== options.expectedObligationId) {
    throw new DomainError('INVALID_ITEM_CONTRACT', 'daily item changed its bound obligation', {
      path: '/obligation_id', allowed_paths: []
    });
  }
  const dailyResult = validateShinobiDaily(value.daily);
  const errors = [];
  if (!dailyResult.valid) errors.push(new DomainError('SCHEMA_VIOLATION', dailyResult.errors.join('；'), {
    path: '/daily', allowed_paths: ['/daily']
  }));
  assertExactKeys(value.source_refs, {
    allowed: DAILY_SOURCE_KEYS,
    required: DAILY_SOURCE_KEYS,
    path: '/source_refs',
    label: 'daily source_refs'
  });
  const publicRefs = options.worldPublicRefs ? new Set(options.worldPublicRefs) : null;
  const check = operation => {
    try { return operation(); } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      errors.push(error); return null;
    }
  };
  const sourceRefs = {};
  for (const key of ['headline', 'quote']) sourceRefs[key] = check(() =>
    assertPublicRefList(value.source_refs[key], `/source_refs/${key}`, publicRefs));
  for (const [key, length] of [['world', 4], ['flavor', 3], ['missions', 4]]) {
    const refs = value.source_refs[key];
    check(() => assertArray(refs, { path: `/source_refs/${key}`, label: 'public source ref matrix', min: length, max: length }));
    if (Array.isArray(refs) && refs.length === length) sourceRefs[key] = refs.map((list, index) => check(() =>
      assertPublicRefList(list, `/source_refs/${key}/${index}`, publicRefs)));
  }
  if (errors.length) throw new DomainError(errors[0].code, errors.map(error => `${error.details?.path ?? '/'}: ${error.message}`).join('；'), {
    path: errors[0].details?.path ?? '/',
    allowed_paths: [...new Set(errors.flatMap(error => error.details?.allowed_paths ?? [error.details?.path ?? '/']))]
  });
  return immutableContractValue({
    obligation_id: obligationId,
    daily: dailyResult.daily,
    source_refs: sourceRefs
  });
}

export function inspectShinobiDailyArtifactItem(value, options) {
  return inspectContract(value, item => assertShinobiDailyArtifactItem(item, options));
}

export function assertTurnBundlePatch(value) {
  assertExactKeys(value, {
    allowed: PATCH_KEYS,
    required: [],
    path: '/',
    label: 'TurnBundlePatch'
  });
  const effectIds = value.effect_ids ?? [];
  assertArray(effectIds, {
    path: '/effect_ids', label: 'effect_ids', max: 256,
    item: (id, path) => assertString(id, {
      path, label: 'effect_id', min: 8, max: 87, pattern: EFFECT_ID
    })
  });
  const domainChecks = value.domain_checks ?? [];
  const memories = value.memories ?? [];
  const daily = value.shinobi_daily ?? [];
  assertArray(domainChecks, { path: '/domain_checks', label: 'domain_checks', max: 128 });
  assertArray(memories, { path: '/memories', label: 'memories', max: 128 });
  assertArray(daily, { path: '/shinobi_daily', label: 'shinobi_daily', max: 1 });
  return immutableContractValue({
    effect_ids: effectIds,
    domain_checks: domainChecks,
    memories,
    shinobi_daily: daily
  });
}

export function inspectTurnBundlePatch(value) {
  return inspectContract(value, assertTurnBundlePatch);
}

/** Strict validators suitable for TurnDraft's injected runtime registry. */
export function createContinuityItemValidators(bindings = {}) {
  const byObligation = bindings.byObligation ?? {};
  return Object.freeze({
    domain_check(item, obligation) {
      const binding = byObligation[obligation.obligation_id] ?? {};
      return assertDomainCheckItem(item, {
        expectedObligationId: obligation.obligation_id,
        allowedEvidenceEventIds: binding.allowedEvidenceEventIds
      });
    },
    memory(item, obligation) {
      const binding = byObligation[obligation.obligation_id] ?? {};
      return assertMemoryArtifactItem(item, {
        expectedObligationId: obligation.obligation_id,
        audienceEventIds: binding.audienceEventIds,
        stableSubjectIds: binding.stableSubjectIds,
        modifiableEntryIds: binding.modifiableEntryIds
      });
    },
    shinobi_daily(item, obligation) {
      const binding = byObligation[obligation.obligation_id] ?? {};
      return assertShinobiDailyArtifactItem(item, {
        expectedObligationId: obligation.obligation_id,
        worldPublicRefs: binding.worldPublicRefs
      });
    }
  });
}

export function assertRepairPlan(value) {
  assertExactKeys(value, {
    allowed: REPAIR_PLAN_KEYS,
    required: REPAIR_PLAN_KEYS,
    path: '/',
    label: 'RepairPlan'
  });
  if (value.schema !== REPAIR_PLAN_SCHEMA) {
    throw new DomainError('SCHEMA_VIOLATION', `schema must be ${REPAIR_PLAN_SCHEMA}`, {
      path: '/schema'
    });
  }
  const revision = assertInteger(value.draft_revision, {
    path: '/draft_revision', label: 'draft_revision', min: 0
  });
  const reviewedHash = assertString(value.reviewed_semantic_draft_hash, {
    path: '/reviewed_semantic_draft_hash',
    label: 'reviewed_semantic_draft_hash',
    min: 71,
    max: 71,
    pattern: /^sha256:[a-f0-9]{64}$/
  });
  assertResultIdList(value.allowed_effect_ids, '/allowed_effect_ids', EFFECT_ID);
  assertResultIdList(value.allowed_obligation_ids, '/allowed_obligation_ids', OBLIGATION_ID);
  const allowedObligations = new Set(value.allowed_obligation_ids);
  assertArray(value.allowed_paths, { path: '/allowed_paths', label: 'allowed_paths', max: 256 });
  const seen = new Set();
  const allowedPaths = value.allowed_paths.map((entry, index) => {
    const path = `/allowed_paths/${index}`;
    assertExactKeys(entry, {
      allowed: ['kind', 'id', 'json_pointers'],
      required: ['kind', 'id', 'json_pointers'],
      path,
      label: 'allowed path item'
    });
    const kind = assertString(entry.kind, {
      path: `${path}/kind`, label: 'kind', min: 1, max: 32,
      enumValues: ['domain_check', 'memory', 'shinobi_daily']
    });
    const id = assertObligationId(entry.id, `${path}/id`);
    if (!allowedObligations.has(id)) {
      throw new DomainError('SCHEMA_VIOLATION', 'allowed path refers to an obligation outside the plan', {
        path: `${path}/id`
      });
    }
    const identity = `${kind}\u0000${id}`;
    if (seen.has(identity)) {
      throw new DomainError('SCHEMA_VIOLATION', 'RepairPlan contains duplicate allowed path items', {
        path
      });
    }
    seen.add(identity);
    assertArray(entry.json_pointers, {
      path: `${path}/json_pointers`, label: 'json_pointers', min: 1, max: 128,
      item: (pointer, pointerPath) => assertString(pointer, {
        path: pointerPath, label: 'JSON Pointer', min: 1, max: 512, pattern: /^\//
      }),
      uniqueBy: pointer => pointer
    });
    return { kind, id, json_pointers: entry.json_pointers };
  });
  return immutableContractValue({
    schema: REPAIR_PLAN_SCHEMA,
    draft_revision: revision,
    reviewed_semantic_draft_hash: reviewedHash,
    allowed_effect_ids: value.allowed_effect_ids,
    allowed_obligation_ids: value.allowed_obligation_ids,
    allowed_paths: allowedPaths
  });
}

export function inspectRepairPlan(value) {
  return inspectContract(value, assertRepairPlan);
}

/** Provider-neutral tool registration; adapters map this to their SDK shape. */
export function createContinuityToolContract(operation) {
  assertString(operation, {
    path: '/operation', label: 'operation', min: 1, max: 64,
    enumValues: CONTINUITY_OPERATIONS
  });
  return immutableContractValue({
    name: operation,
    description: operation === 'stage_turn_bundle'
      ? '首次暂存本回合全部 effect IDs、领域核对、记忆与唯一日报。'
      : '仅修复服务端 RepairPlan 允许的缺项或已重开产物。',
    input_schema: TURN_BUNDLE_PATCH_JSON_SCHEMA,
    referenced_schemas: [
      DOMAIN_CHECK_ITEM_JSON_SCHEMA,
      MEMORY_ARTIFACT_ITEM_JSON_SCHEMA,
      SHINOBI_DAILY_ARTIFACT_ITEM_JSON_SCHEMA
    ]
  });
}

export const CONTINUITY_SCHEMA_REGISTRY = immutableContractValue([
  DOMAIN_CHECK_ITEM_JSON_SCHEMA,
  MEMORY_ARTIFACT_ITEM_JSON_SCHEMA,
  SHINOBI_DAILY_ARTIFACT_ITEM_JSON_SCHEMA,
  TURN_BUNDLE_PATCH_JSON_SCHEMA,
  CONTINUITY_JSON_ENVELOPE_JSON_SCHEMA,
  REPAIR_PLAN_JSON_SCHEMA,
  CONTINUITY_BUNDLE_RESULT_JSON_SCHEMA
]);

function assertResultIdList(value, path, pattern) {
  assertArray(value, {
    path,
    label: 'allowed IDs',
    max: 256,
    item: (id, itemPath) => assertString(id, {
      path: itemPath, label: 'allowed ID', min: 8, max: 160, pattern
    }),
    uniqueBy: id => id
  });
}

export function assertContinuityBundleResult(value) {
  assertExactKeys(value, {
    allowed: RESULT_KEYS,
    required: RESULT_KEYS,
    path: '/',
    label: 'ContinuityBundleResult'
  });
  if (value.schema !== CONTINUITY_BUNDLE_RESULT_SCHEMA) {
    throw new DomainError('SCHEMA_VIOLATION', `schema must be ${CONTINUITY_BUNDLE_RESULT_SCHEMA}`, {
      path: '/schema'
    });
  }
  assertString(value.status, {
    path: '/status', label: 'status', min: 1, max: 32, enumValues: CONTINUITY_RESULT_STATUSES
  });
  assertString(value.retryable_by, {
    path: '/retryable_by', label: 'retryable_by', min: 1, max: 32,
    enumValues: CONTINUITY_RETRY_OWNERS
  });
  assertInteger(value.draft_revision, {
    path: '/draft_revision', label: 'draft_revision', min: 0
  });
  assertResultIdList(value.allowed_effect_ids, '/allowed_effect_ids', EFFECT_ID);
  assertResultIdList(value.allowed_obligation_ids, '/allowed_obligation_ids', OBLIGATION_ID);
  for (const field of ['accepted', 'idempotent', 'errors', 'allowed_paths']) {
    assertArray(value[field], { path: `/${field}`, label: field, max: 512 });
  }

  if (value.status === 'READY') {
    if (value.retryable_by !== 'none' || value.next_operation !== null
      || value.allowed_effect_ids.length || value.allowed_obligation_ids.length
      || value.allowed_paths.length || !value.ready_receipt) {
      throw new DomainError('SCHEMA_VIOLATION', 'READY result has inconsistent repair fields', {
        path: '/status'
      });
    }
  } else if (value.status === 'REPAIR_REQUIRED') {
    if (value.retryable_by !== 'continuity' || value.next_operation !== 'repair_turn_bundle') {
      throw new DomainError('SCHEMA_VIOLATION', 'REPAIR_REQUIRED must route to repair_turn_bundle', {
        path: '/next_operation'
      });
    }
  } else if (value.status === 'PROTOCOL_RETRY') {
    if (value.retryable_by !== 'continuity'
      || !CONTINUITY_OPERATIONS.includes(value.next_operation)) {
      throw new DomainError('SCHEMA_VIOLATION', 'PROTOCOL_RETRY must identify the next protocol operation', {
        path: '/next_operation'
      });
    }
  } else if (value.status === 'HANDOFF_REQUIRED') {
    if (!['referee', 'orchestrator'].includes(value.retryable_by)
      || value.next_operation !== null
      || value.allowed_effect_ids.length || value.allowed_obligation_ids.length
      || value.allowed_paths.length) {
      throw new DomainError('SCHEMA_VIOLATION', 'HANDOFF_REQUIRED cannot expose repair permissions', {
        path: '/status'
      });
    }
  } else if (value.status === 'PAUSED') {
    if (value.retryable_by !== 'none' || value.next_operation !== null
      || !CONTINUITY_PAUSE_REASONS.includes(value.pause_reason)
      || typeof value.turn_state !== 'string'
      || typeof value.resume_stage !== 'string') {
      throw new DomainError('SCHEMA_VIOLATION', 'PAUSED must carry an exact pause and resume point', {
        path: '/pause_reason'
      });
    }
  }
  return immutableContractValue(value);
}

export function inspectContinuityBundleResult(value) {
  return inspectContract(value, assertContinuityBundleResult);
}
