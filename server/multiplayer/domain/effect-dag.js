import { canonicalizeJson, sha256Hex } from './canonical-json.js';
import { DomainError } from './errors.js';

export const COMPILED_EFFECT_DAG_SCHEMA = 'naruto.multiplayer-compiled-effect-dag/v1';
export const EFFECT_HASH_MATERIAL_SCHEMA = 'naruto.multiplayer-effect-hash-material/v1';

export const EFFECT_DAG_LIMITS = Object.freeze({
  maxEffects: 256,
  maxDependenciesPerEffect: 256,
  maxEvidenceEventsPerEffect: 256,
  maxRuleRefsPerEffect: 256,
  maxIdentifierLength: 128,
  maxSummaryLength: 2_000
});

const EFFECT_ID = /^effect_[A-Za-z0-9_-]{1,80}$/;
const REDUCER_KEY = /^[a-z][a-z0-9_]{0,127}$/;

const REQUIRED_EFFECT_FIELDS = Object.freeze([
  'effect_id',
  'depends_on_effect_ids',
  'event_id',
  'target',
  'domain',
  'kind',
  'operation',
  'payload',
  'provenance',
  'visibility',
  'evidence_event_ids'
]);

const OPTIONAL_EFFECT_FIELDS = Object.freeze([
  'summary',
  'unit',
  'rule_refs'
]);

const ALLOWED_EFFECT_FIELDS = new Set([
  ...REQUIRED_EFFECT_FIELDS,
  ...OPTIONAL_EFFECT_FIELDS
]);

const SERVER_BOUND_EFFECT_FIELDS = new Set([
  'effect_hash',
  'effect_seq',
  'integrity_policy_hash',
  'preconditions',
  'reducer',
  'reducer_version',
  'required_preconditions',
  'required_reducer',
  'required_reducer_version',
  'rule_snapshot',
  'rule_snapshot_hash',
  'semantic_hash'
]);

const RESOLVER_BINDING_FIELDS = new Set(['required_reducer', 'reducer_version']);

function fail(code, message, details = {}) {
  throw new DomainError(code, message, details);
}

function own(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function compareText(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertPlainObject(value, code, label, details = {}) {
  if (!isPlainObject(value)) fail(code, `${label} must be a plain object`, details);
}

function assertNonEmptyString(value, field, {
  code = 'INVALID_EFFECT_FIELD',
  max = EFFECT_DAG_LIMITS.maxIdentifierLength,
  pattern = null,
  effectId = undefined
} = {}) {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || !value.trim()) {
    fail(code, `${field} must be a non-empty bounded string`, {
      effect_id: effectId,
      field,
      max
    });
  }
  if (pattern && !pattern.test(value)) {
    fail(code, `${field} has an invalid identifier format`, {
      effect_id: effectId,
      field
    });
  }
  return value;
}

function assertEffectId(value, field = 'effect_id', effectId = undefined) {
  return assertNonEmptyString(value, field, {
    max: 87,
    pattern: EFFECT_ID,
    effectId
  });
}

function normalizeUniqueStringSet(value, {
  code,
  duplicateCode,
  effectId,
  field,
  maxItems,
  pattern = null
}) {
  if (!Array.isArray(value) || value.length > maxItems) {
    fail(code, `${field} must be an array within its item limit`, {
      effect_id: effectId,
      field,
      max_items: maxItems
    });
  }

  const seen = new Set();
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    assertNonEmptyString(item, `${field}[${index}]`, {
      max: EFFECT_DAG_LIMITS.maxIdentifierLength,
      pattern,
      effectId
    });
    if (seen.has(item)) {
      fail(duplicateCode, `${field} contains a duplicate identifier`, {
        effect_id: effectId,
        field,
        duplicate_id: item
      });
    }
    seen.add(item);
  }
  return [...seen].sort(compareText);
}

function normalizeEffect(candidate, index) {
  assertPlainObject(candidate, 'INVALID_EFFECT', 'effect candidate', { index });

  for (const key of Object.keys(candidate)) {
    if (SERVER_BOUND_EFFECT_FIELDS.has(key)) {
      fail('SERVER_BOUND_EFFECT_FIELD', 'Effect candidates cannot provide server-bound fields', {
        index,
        field: key
      });
    }
    if (!ALLOWED_EFFECT_FIELDS.has(key)) {
      fail('UNKNOWN_EFFECT_FIELD', 'Effect candidate contains an unknown top-level field', {
        index,
        field: key
      });
    }
  }

  for (const field of REQUIRED_EFFECT_FIELDS) {
    if (!own(candidate, field)) {
      fail('MISSING_EFFECT_FIELD', 'Effect candidate is missing a required semantic field', {
        index,
        field
      });
    }
  }

  const effectId = assertEffectId(candidate.effect_id);
  const dependencies = normalizeUniqueStringSet(candidate.depends_on_effect_ids, {
    code: 'INVALID_EFFECT_DEPENDENCIES',
    duplicateCode: 'DUPLICATE_EFFECT_DEPENDENCY',
    effectId,
    field: 'depends_on_effect_ids',
    maxItems: EFFECT_DAG_LIMITS.maxDependenciesPerEffect,
    pattern: EFFECT_ID
  });
  if (dependencies.includes(effectId)) {
    fail('SELF_EFFECT_DEPENDENCY', 'An effect cannot depend on itself', {
      effect_id: effectId
    });
  }

  const eventId = assertNonEmptyString(candidate.event_id, 'event_id', {
    effectId
  });
  const evidenceEventIds = normalizeUniqueStringSet(candidate.evidence_event_ids, {
    code: 'INVALID_EFFECT_EVIDENCE',
    duplicateCode: 'DUPLICATE_EFFECT_EVIDENCE',
    effectId,
    field: 'evidence_event_ids',
    maxItems: EFFECT_DAG_LIMITS.maxEvidenceEventsPerEffect
  });
  if (evidenceEventIds.length === 0 || !evidenceEventIds.includes(eventId)) {
    fail('INVALID_EFFECT_EVIDENCE', 'evidence_event_ids must include the primary event_id', {
      effect_id: effectId,
      event_id: eventId
    });
  }

  assertPlainObject(candidate.target, 'INVALID_EFFECT_FIELD', 'effect target', {
    effect_id: effectId,
    field: 'target'
  });
  if (Object.keys(candidate.target).length === 0) {
    fail('INVALID_EFFECT_FIELD', 'effect target cannot be empty', {
      effect_id: effectId,
      field: 'target'
    });
  }
  assertPlainObject(candidate.payload, 'INVALID_EFFECT_FIELD', 'effect payload', {
    effect_id: effectId,
    field: 'payload'
  });

  for (const field of ['domain', 'kind', 'operation', 'provenance']) {
    assertNonEmptyString(candidate[field], field, { effectId });
  }
  if (candidate.visibility !== 'server_only') {
    fail('INVALID_EFFECT_VISIBILITY', 'Canonical state effects must remain server_only', {
      effect_id: effectId,
      visibility: candidate.visibility
    });
  }

  const normalized = {
    effect_id: effectId,
    depends_on_effect_ids: dependencies,
    event_id: eventId,
    target: canonicalizeJson(candidate.target),
    domain: candidate.domain,
    kind: candidate.kind,
    operation: candidate.operation,
    payload: canonicalizeJson(candidate.payload),
    provenance: candidate.provenance,
    visibility: 'server_only',
    evidence_event_ids: evidenceEventIds
  };

  if (own(candidate, 'summary')) {
    normalized.summary = assertNonEmptyString(candidate.summary, 'summary', {
      max: EFFECT_DAG_LIMITS.maxSummaryLength,
      effectId
    });
  }
  if (own(candidate, 'unit')) {
    normalized.unit = assertNonEmptyString(candidate.unit, 'unit', { effectId });
  }
  if (own(candidate, 'rule_refs')) {
    normalized.rule_refs = normalizeUniqueStringSet(candidate.rule_refs, {
      code: 'INVALID_EFFECT_RULE_REFS',
      duplicateCode: 'DUPLICATE_EFFECT_RULE_REF',
      effectId,
      field: 'rule_refs',
      maxItems: EFFECT_DAG_LIMITS.maxRuleRefsPerEffect
    });
  }

  return canonicalizeJson(normalized);
}

function prepareCandidates(candidates) {
  if (!Array.isArray(candidates)) {
    fail('INVALID_EFFECT_COLLECTION', 'Effect candidates must be an array');
  }
  if (candidates.length > EFFECT_DAG_LIMITS.maxEffects) {
    fail('TOO_MANY_EFFECTS', 'Effect candidate count exceeds the configured limit', {
      max_effects: EFFECT_DAG_LIMITS.maxEffects
    });
  }

  // Canonicalization performs the strict JSON/cycle/prototype validation while
  // also detaching the caller's input before any resolver can observe it.
  const detached = canonicalizeJson(candidates, {
    maxDepth: 64,
    maxNodes: 100_000
  });
  const effects = detached.map(normalizeEffect);
  const byId = new Map();

  for (const effect of effects) {
    if (byId.has(effect.effect_id)) {
      fail('DUPLICATE_EFFECT_ID', 'Effect IDs must be unique within a resolution', {
        effect_id: effect.effect_id
      });
    }
    byId.set(effect.effect_id, effect);
  }

  for (const effect of effects) {
    for (const dependencyId of effect.depends_on_effect_ids) {
      if (!byId.has(dependencyId)) {
        fail('DANGLING_EFFECT_DEPENDENCY', 'Effect dependency does not exist in this resolution', {
          effect_id: effect.effect_id,
          dependency_effect_id: dependencyId
        });
      }
    }
  }

  return { effects, byId };
}

/**
 * Kahn topological sorting by dependency depth. All effects that become ready
 * in the same layer are ordered by effect_id, so source array order can never
 * influence execution order.
 */
function sortPrepared(prepared) {
  const indegree = new Map();
  const dependents = new Map();

  for (const effect of prepared.effects) {
    indegree.set(effect.effect_id, effect.depends_on_effect_ids.length);
    dependents.set(effect.effect_id, []);
  }
  for (const effect of prepared.effects) {
    for (const dependencyId of effect.depends_on_effect_ids) {
      dependents.get(dependencyId).push(effect.effect_id);
    }
  }
  for (const ids of dependents.values()) ids.sort(compareText);

  let layer = [...indegree.entries()]
    .filter(([, count]) => count === 0)
    .map(([effectId]) => effectId)
    .sort(compareText);
  const orderedIds = [];

  while (layer.length > 0) {
    const nextLayer = new Set();
    for (const effectId of layer) {
      orderedIds.push(effectId);
      for (const dependentId of dependents.get(effectId)) {
        const remaining = indegree.get(dependentId) - 1;
        indegree.set(dependentId, remaining);
        if (remaining === 0) nextLayer.add(dependentId);
      }
    }
    layer = [...nextLayer].sort(compareText);
  }

  if (orderedIds.length !== prepared.effects.length) {
    const cyclicEffectIds = [...indegree.entries()]
      .filter(([, count]) => count > 0)
      .map(([effectId]) => effectId)
      .sort(compareText);
    fail('EFFECT_DEPENDENCY_CYCLE', 'Effect dependency graph must be acyclic', {
      effect_ids: cyclicEffectIds
    });
  }

  return orderedIds;
}

function freezeDeep(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

function immutableCanonical(value) {
  return freezeDeep(canonicalizeJson(value));
}

/** Returns only the deterministic 1-D topological order of effect IDs. */
export function topologicalSortEffectIds(candidates) {
  return Object.freeze(sortPrepared(prepareCandidates(candidates)));
}

/** Returns detached, normalized and frozen candidate effects in DAG order. */
export function topologicalSortEffects(candidates) {
  const prepared = prepareCandidates(candidates);
  const orderedIds = sortPrepared(prepared);
  return immutableCanonical(orderedIds.map(effectId => prepared.byId.get(effectId)));
}

function normalizeCompileOptions(options) {
  assertPlainObject(options, 'INVALID_EFFECT_DAG_OPTIONS', 'compile options');
  for (const key of Object.keys(options)) {
    if (key !== 'resolveReducer' && key !== 'ruleSnapshot') {
      fail('INVALID_EFFECT_DAG_OPTIONS', 'Compile options contain an unknown field', { field: key });
    }
  }
  if (typeof options.resolveReducer !== 'function') {
    fail('INVALID_REDUCER_RESOLVER', 'resolveReducer must be a synchronous function');
  }
  if (!own(options, 'ruleSnapshot')) {
    fail('INVALID_RULE_SNAPSHOT', 'A canonical ruleSnapshot is required');
  }
  assertPlainObject(options.ruleSnapshot, 'INVALID_RULE_SNAPSHOT', 'ruleSnapshot');

  const ruleSnapshot = immutableCanonical(options.ruleSnapshot);
  return {
    resolveReducer: options.resolveReducer,
    ruleSnapshot,
    ruleSnapshotHash: `sha256:${sha256Hex(ruleSnapshot)}`
  };
}

function normalizeReducerBinding(binding, effectId) {
  assertPlainObject(binding, 'INVALID_REDUCER_BINDING', 'reducer binding', {
    effect_id: effectId
  });
  const detached = canonicalizeJson(binding, { maxDepth: 2, maxNodes: 8 });
  for (const key of Object.keys(detached)) {
    if (!RESOLVER_BINDING_FIELDS.has(key)) {
      fail('INVALID_REDUCER_BINDING', 'Reducer resolver returned an unknown binding field', {
        effect_id: effectId,
        field: key
      });
    }
  }
  for (const field of RESOLVER_BINDING_FIELDS) {
    if (!own(detached, field)) {
      fail('INVALID_REDUCER_BINDING', 'Reducer resolver must return one reducer and version', {
        effect_id: effectId,
        field
      });
    }
  }

  const requiredReducer = assertNonEmptyString(detached.required_reducer, 'required_reducer', {
    code: 'INVALID_REDUCER_BINDING',
    pattern: REDUCER_KEY,
    effectId
  });
  const reducerVersion = assertNonEmptyString(detached.reducer_version, 'reducer_version', {
    code: 'INVALID_REDUCER_BINDING',
    effectId
  });
  return {
    required_reducer: requiredReducer,
    reducer_version: reducerVersion
  };
}

/**
 * Compile semantic candidate effects into a server-bound, immutable DAG.
 *
 * The resolver receives a frozen detached effect and the frozen rule snapshot.
 * It must synchronously return exactly `{ required_reducer, reducer_version }`.
 */
export function compileEffectDag(candidates, options) {
  const prepared = prepareCandidates(candidates);
  const orderedIds = sortPrepared(prepared);
  const compileOptions = normalizeCompileOptions(options);

  const compiledEffects = orderedIds.map((effectId, index) => {
    const effect = immutableCanonical(prepared.byId.get(effectId));
    const rawBinding = compileOptions.resolveReducer(effect, compileOptions.ruleSnapshot);
    if (rawBinding && typeof rawBinding.then === 'function') {
      fail('INVALID_REDUCER_RESOLVER', 'resolveReducer must not return a Promise', {
        effect_id: effectId
      });
    }
    const binding = normalizeReducerBinding(rawBinding, effectId);
    const hashMaterial = {
      schema: EFFECT_HASH_MATERIAL_SCHEMA,
      effect,
      binding,
      rule_snapshot: compileOptions.ruleSnapshot
    };

    return {
      ...effect,
      effect_seq: index + 1,
      required_reducer: binding.required_reducer,
      reducer_version: binding.reducer_version,
      effect_hash: `sha256:${sha256Hex(hashMaterial)}`
    };
  });

  return immutableCanonical({
    schema: COMPILED_EFFECT_DAG_SCHEMA,
    rule_snapshot_hash: compileOptions.ruleSnapshotHash,
    effects: compiledEffects
  });
}
