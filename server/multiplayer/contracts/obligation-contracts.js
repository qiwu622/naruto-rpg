import {
  assertArray,
  assertExactKeys,
  assertIdentifier,
  assertInteger,
  assertString,
  contractError,
  immutableContractValue,
  inspectContract
} from './common.js';
import { NARRATIVE_MODES } from './enums.js';

export const UPDATE_OBLIGATIONS_SCHEMA = 'naruto.update-obligations/v1';

export const UPDATE_OBLIGATION_DOMAINS = Object.freeze([
  'world',
  'attributes',
  'skills',
  'equipment',
  'missions',
  'relationships',
  'combat',
  'events'
]);

export const ARTIFACT_OBLIGATION_KINDS = Object.freeze([
  'memory',
  'shinobi_daily'
]);

export const NARRATIVE_OBLIGATION_AUDIENCES = Object.freeze([
  'shared',
  'seat:A',
  'seat:B'
]);

export const UPDATE_OBLIGATION_LIMITS = Object.freeze({
  maxEffects: 256,
  maxDomains: 128,
  maxArtifacts: 129,
  maxScopeRefs: 128,
  maxEffectRefs: 256
});

const JSON_SCHEMA_DRAFT = 'https://json-schema.org/draft/2020-12/schema';
const SHA256_PATTERN = '^sha256:[a-f0-9]{64}$';
const SHA256_REGEXP = /^sha256:[a-f0-9]{64}$/u;
const EFFECT_ID_PATTERN = '^effect_[A-Za-z0-9_-]{1,80}$';
const OBLIGATION_ID_PATTERN = '^obligation_[A-Za-z0-9_-]{1,120}$';
const STABLE_REF_PATTERN = '^[A-Za-z][A-Za-z0-9:_-]{1,159}$';
const NPC_PRIVATE_BINDING_PATTERN = '^npc:[A-Za-z0-9_-]{1,147}:private$';
const NPC_PRIVATE_BINDING = /^npc:[A-Za-z0-9_-]{1,147}:private$/u;

const TOP_LEVEL_KEYS = Object.freeze([
  'schema',
  'turn_id',
  'resolution_hash',
  'narrative_mode',
  'effect_obligations',
  'domain_obligations',
  'artifact_obligations',
  'narrative_obligations'
]);
const EFFECT_KEYS = Object.freeze([
  'effect_id',
  'effect_seq',
  'effect_hash',
  'depends_on_effect_ids'
]);
const DOMAIN_KEYS = Object.freeze([
  'obligation_id',
  'domain',
  'scope_refs',
  'satisfied_by_effect_ids'
]);
const ARTIFACT_KEYS = Object.freeze([
  'obligation_id',
  'kind',
  'target_binding',
  'source_projection_hash'
]);
const NARRATIVE_KEYS = Object.freeze([
  'obligation_id',
  'audience',
  'source_projection_hash'
]);

const effectIdJsonSchema = {
  type: 'string',
  minLength: 8,
  maxLength: 87,
  pattern: EFFECT_ID_PATTERN
};
const obligationIdJsonSchema = {
  type: 'string',
  minLength: 12,
  maxLength: 131,
  pattern: OBLIGATION_ID_PATTERN
};
const sha256JsonSchema = {
  type: 'string',
  minLength: 71,
  maxLength: 71,
  pattern: SHA256_PATTERN
};
const stableRefJsonSchema = {
  type: 'string',
  minLength: 2,
  maxLength: 160,
  pattern: STABLE_REF_PATTERN
};
const memoryTargetBindingJsonSchema = {
  anyOf: [
    { enum: ['server_bound', 'shared', 'actor:A', 'actor:B'] },
    {
      type: 'string',
      minLength: 13,
      maxLength: 159,
      pattern: NPC_PRIVATE_BINDING_PATTERN
    }
  ]
};

const effectObligationJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: EFFECT_KEYS,
  properties: {
    effect_id: effectIdJsonSchema,
    effect_seq: {
      type: 'integer',
      minimum: 1,
      maximum: UPDATE_OBLIGATION_LIMITS.maxEffects
    },
    effect_hash: sha256JsonSchema,
    depends_on_effect_ids: {
      type: 'array',
      maxItems: UPDATE_OBLIGATION_LIMITS.maxEffectRefs,
      uniqueItems: true,
      items: effectIdJsonSchema
    }
  }
};

const domainObligationJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: DOMAIN_KEYS,
  properties: {
    obligation_id: obligationIdJsonSchema,
    domain: { type: 'string', enum: UPDATE_OBLIGATION_DOMAINS },
    scope_refs: {
      type: 'array',
      minItems: 1,
      maxItems: UPDATE_OBLIGATION_LIMITS.maxScopeRefs,
      uniqueItems: true,
      items: stableRefJsonSchema
    },
    satisfied_by_effect_ids: {
      type: 'array',
      maxItems: UPDATE_OBLIGATION_LIMITS.maxEffectRefs,
      uniqueItems: true,
      items: effectIdJsonSchema
    }
  }
};

const artifactObligationProperties = {
  obligation_id: obligationIdJsonSchema,
  kind: { type: 'string', enum: ARTIFACT_OBLIGATION_KINDS },
  target_binding: {
    anyOf: [memoryTargetBindingJsonSchema, { const: 'world_public' }]
  },
  source_projection_hash: sha256JsonSchema
};
const artifactObligationBaseJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ARTIFACT_KEYS,
  properties: artifactObligationProperties
};
const memoryArtifactObligationJsonSchema = {
  ...artifactObligationBaseJsonSchema,
  properties: {
    ...artifactObligationProperties,
    kind: { const: 'memory' },
    target_binding: memoryTargetBindingJsonSchema
  }
};
const dailyArtifactObligationJsonSchema = {
  ...artifactObligationBaseJsonSchema,
  properties: {
    ...artifactObligationProperties,
    kind: { const: 'shinobi_daily' },
    target_binding: { const: 'world_public' }
  }
};
const artifactObligationJsonSchema = {
  ...artifactObligationBaseJsonSchema,
  oneOf: [
    memoryArtifactObligationJsonSchema,
    dailyArtifactObligationJsonSchema
  ]
};

const narrativeObligationJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: NARRATIVE_KEYS,
  properties: {
    obligation_id: obligationIdJsonSchema,
    audience: { type: 'string', enum: NARRATIVE_OBLIGATION_AUDIENCES },
    source_projection_hash: sha256JsonSchema
  }
};

const domainCoverageJsonSchema = UPDATE_OBLIGATION_DOMAINS.map(domain => ({
  contains: {
    ...domainObligationJsonSchema,
    properties: {
      ...domainObligationJsonSchema.properties,
      domain: { const: domain }
    }
  },
  minContains: 1
}));

const artifactGateJsonSchema = [{
  contains: {
    ...artifactObligationJsonSchema,
    properties: {
      ...artifactObligationJsonSchema.properties,
      kind: { const: 'memory' },
      target_binding: { const: 'server_bound' }
    }
  },
  minContains: 1,
  maxContains: 1
}, {
  contains: {
    ...artifactObligationJsonSchema,
    properties: {
      ...artifactObligationJsonSchema.properties,
      kind: { const: 'shinobi_daily' },
      target_binding: { const: 'world_public' }
    }
  },
  minContains: 1,
  maxContains: 1
}];

const updateObligationsProperties = {
  schema: { const: UPDATE_OBLIGATIONS_SCHEMA },
  turn_id: {
    type: 'string',
    minLength: 6,
    maxLength: 160,
    pattern: '^turn_[A-Za-z0-9_-]{1,155}$'
  },
  resolution_hash: sha256JsonSchema,
  narrative_mode: { type: 'string', enum: NARRATIVE_MODES },
  effect_obligations: {
    type: 'array',
    maxItems: UPDATE_OBLIGATION_LIMITS.maxEffects,
    uniqueItems: true,
    items: { $ref: '#/$defs/effectObligation' }
  },
  domain_obligations: {
    type: 'array',
    minItems: UPDATE_OBLIGATION_DOMAINS.length,
    maxItems: UPDATE_OBLIGATION_LIMITS.maxDomains,
    uniqueItems: true,
    items: { $ref: '#/$defs/domainObligation' },
    allOf: domainCoverageJsonSchema
  },
  artifact_obligations: {
    type: 'array',
    minItems: 2,
    maxItems: UPDATE_OBLIGATION_LIMITS.maxArtifacts,
    uniqueItems: true,
    items: { $ref: '#/$defs/artifactObligation' },
    allOf: artifactGateJsonSchema
  },
  narrative_obligations: {
    type: 'array',
    minItems: 1,
    maxItems: 2,
    uniqueItems: true,
    items: { $ref: '#/$defs/narrativeObligation' }
  }
};
const updateObligationsBaseJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: TOP_LEVEL_KEYS,
  properties: updateObligationsProperties
};
const sharedNarrativeObligationsJsonSchema = {
  type: 'array',
  minItems: 1,
  maxItems: 1,
  uniqueItems: true,
  items: {
    ...narrativeObligationJsonSchema,
    properties: {
      ...narrativeObligationJsonSchema.properties,
      audience: { const: 'shared' }
    }
  }
};
const dualNarrativeObligationsJsonSchema = {
  type: 'array',
  minItems: 2,
  maxItems: 2,
  uniqueItems: true,
  items: { $ref: '#/$defs/narrativeObligation' },
  allOf: [{
    contains: {
      ...narrativeObligationJsonSchema,
      properties: {
        ...narrativeObligationJsonSchema.properties,
        audience: { const: 'seat:A' }
      }
    },
    minContains: 1,
    maxContains: 1
  }, {
    contains: {
      ...narrativeObligationJsonSchema,
      properties: {
        ...narrativeObligationJsonSchema.properties,
        audience: { const: 'seat:B' }
      }
    },
    minContains: 1,
    maxContains: 1
  }]
};

export const UPDATE_OBLIGATIONS_JSON_SCHEMA = immutableContractValue({
  $schema: JSON_SCHEMA_DRAFT,
  $id: UPDATE_OBLIGATIONS_SCHEMA,
  ...updateObligationsBaseJsonSchema,
  oneOf: [{
    ...updateObligationsBaseJsonSchema,
    properties: {
      ...updateObligationsProperties,
      narrative_mode: { const: 'shared' },
      narrative_obligations: sharedNarrativeObligationsJsonSchema
    }
  }, {
    ...updateObligationsBaseJsonSchema,
    properties: {
      ...updateObligationsProperties,
      narrative_mode: { const: 'dual_pov' },
      narrative_obligations: dualNarrativeObligationsJsonSchema
    }
  }],
  $defs: {
    effectObligation: effectObligationJsonSchema,
    domainObligation: domainObligationJsonSchema,
    artifactObligation: artifactObligationJsonSchema,
    narrativeObligation: narrativeObligationJsonSchema
  }
});

function pathFor(path, key) {
  return path === '/' ? `/${key}` : `${path}/${key}`;
}

function compareText(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
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

function assertEffectId(value, path) {
  return assertIdentifier(value, {
    path,
    label: 'effect_id',
    prefix: 'effect_',
    max: 87
  });
}

function assertObligationId(value, path) {
  return assertIdentifier(value, {
    path,
    label: 'obligation_id',
    prefix: 'obligation_',
    max: 131
  });
}

function assertUniqueStrings(value, {
  path,
  label,
  min = 0,
  max,
  validate
}) {
  const seen = new Set();
  assertArray(value, {
    path,
    label,
    min,
    max,
    item(item, itemPath) {
      validate(item, itemPath);
      if (seen.has(item)) {
        throw contractError(itemPath, `${label} contains a duplicate reference`, {
          duplicate_reference: item
        });
      }
      seen.add(item);
    }
  });
  return value;
}

function normalizeEffectObligation(value, path) {
  assertExactKeys(value, {
    allowed: EFFECT_KEYS,
    path,
    label: 'effect obligation'
  });
  assertEffectId(value.effect_id, pathFor(path, 'effect_id'));
  assertInteger(value.effect_seq, {
    path: pathFor(path, 'effect_seq'),
    label: 'effect_seq',
    min: 1,
    max: UPDATE_OBLIGATION_LIMITS.maxEffects
  });
  assertSha256(value.effect_hash, pathFor(path, 'effect_hash'), 'effect_hash');
  assertUniqueStrings(value.depends_on_effect_ids, {
    path: pathFor(path, 'depends_on_effect_ids'),
    label: 'depends_on_effect_ids',
    max: UPDATE_OBLIGATION_LIMITS.maxEffectRefs,
    validate: assertEffectId
  });
  return immutableContractValue({
    effect_id: value.effect_id,
    effect_seq: value.effect_seq,
    effect_hash: value.effect_hash,
    depends_on_effect_ids: [...value.depends_on_effect_ids].sort(compareText)
  });
}

function normalizeDomainObligation(value, path) {
  assertExactKeys(value, {
    allowed: DOMAIN_KEYS,
    path,
    label: 'domain obligation'
  });
  assertObligationId(value.obligation_id, pathFor(path, 'obligation_id'));
  assertString(value.domain, {
    path: pathFor(path, 'domain'),
    label: 'domain',
    enumValues: UPDATE_OBLIGATION_DOMAINS,
    max: 32
  });
  assertUniqueStrings(value.scope_refs, {
    path: pathFor(path, 'scope_refs'),
    label: 'scope_refs',
    min: 1,
    max: UPDATE_OBLIGATION_LIMITS.maxScopeRefs,
    validate(item, itemPath) {
      assertIdentifier(item, {
        path: itemPath,
        label: 'scope_ref',
        max: 160
      });
    }
  });
  assertUniqueStrings(value.satisfied_by_effect_ids, {
    path: pathFor(path, 'satisfied_by_effect_ids'),
    label: 'satisfied_by_effect_ids',
    max: UPDATE_OBLIGATION_LIMITS.maxEffectRefs,
    validate: assertEffectId
  });
  return immutableContractValue({
    obligation_id: value.obligation_id,
    domain: value.domain,
    scope_refs: [...value.scope_refs].sort(compareText),
    satisfied_by_effect_ids: [...value.satisfied_by_effect_ids].sort(compareText)
  });
}

function normalizeArtifactObligation(value, path) {
  assertExactKeys(value, {
    allowed: ARTIFACT_KEYS,
    path,
    label: 'artifact obligation'
  });
  assertObligationId(value.obligation_id, pathFor(path, 'obligation_id'));
  assertString(value.kind, {
    path: pathFor(path, 'kind'),
    label: 'artifact kind',
    enumValues: ARTIFACT_OBLIGATION_KINDS,
    max: 32
  });
  assertString(value.target_binding, {
    path: pathFor(path, 'target_binding'),
    label: 'target_binding',
    max: 160
  });
  if (value.kind === 'shinobi_daily') {
    if (value.target_binding !== 'world_public') {
      throw contractError(
        pathFor(path, 'target_binding'),
        'shinobi_daily obligation must bind world_public'
      );
    }
  } else {
    const fixedMemoryTargets = ['server_bound', 'shared', 'actor:A', 'actor:B'];
    if (!fixedMemoryTargets.includes(value.target_binding)
      && !NPC_PRIVATE_BINDING.test(value.target_binding)) {
      throw contractError(
        pathFor(path, 'target_binding'),
        'memory obligation has an invalid server-bound partition'
      );
    }
  }
  assertSha256(
    value.source_projection_hash,
    pathFor(path, 'source_projection_hash'),
    'source_projection_hash'
  );
  return immutableContractValue({
    obligation_id: value.obligation_id,
    kind: value.kind,
    target_binding: value.target_binding,
    source_projection_hash: value.source_projection_hash
  });
}

function normalizeNarrativeObligation(value, path) {
  assertExactKeys(value, {
    allowed: NARRATIVE_KEYS,
    path,
    label: 'narrative obligation'
  });
  assertObligationId(value.obligation_id, pathFor(path, 'obligation_id'));
  assertString(value.audience, {
    path: pathFor(path, 'audience'),
    label: 'narrative audience',
    enumValues: NARRATIVE_OBLIGATION_AUDIENCES,
    max: 32
  });
  assertSha256(
    value.source_projection_hash,
    pathFor(path, 'source_projection_hash'),
    'source_projection_hash'
  );
  return immutableContractValue({
    obligation_id: value.obligation_id,
    audience: value.audience,
    source_projection_hash: value.source_projection_hash
  });
}

function assertUniqueIdentity(records, key, path, label, sharedRegistry = null) {
  const seen = sharedRegistry ?? new Map();
  for (let index = 0; index < records.length; index += 1) {
    const identity = records[index][key];
    if (seen.has(identity)) {
      throw contractError(`${path}/${index}/${key}`, `${label} must be unique`, {
        duplicate_id: identity,
        first_path: seen.get(identity)
      });
    }
    seen.set(identity, `${path}/${index}/${key}`);
  }
  return seen;
}

function assertEffectReferenceClosure(effects, domains) {
  const byId = new Map(effects.map(effect => [effect.effect_id, effect]));
  for (let effectIndex = 0; effectIndex < effects.length; effectIndex += 1) {
    const effect = effects[effectIndex];
    for (let dependencyIndex = 0;
      dependencyIndex < effect.depends_on_effect_ids.length;
      dependencyIndex += 1) {
      const dependencyId = effect.depends_on_effect_ids[dependencyIndex];
      const dependency = byId.get(dependencyId);
      const path = `/effect_obligations/${effectIndex}/depends_on_effect_ids/${dependencyIndex}`;
      if (!dependency) {
        throw contractError(path, 'effect dependency is not defined in effect_obligations', {
          dangling_reference: dependencyId
        });
      }
      if (dependency.effect_seq >= effect.effect_seq) {
        throw contractError(path, 'effect dependency must precede its dependent effect', {
          effect_id: effect.effect_id,
          dependency_effect_id: dependencyId
        });
      }
    }
  }

  for (let domainIndex = 0; domainIndex < domains.length; domainIndex += 1) {
    const obligation = domains[domainIndex];
    for (let effectIndex = 0;
      effectIndex < obligation.satisfied_by_effect_ids.length;
      effectIndex += 1) {
      const effectId = obligation.satisfied_by_effect_ids[effectIndex];
      if (!byId.has(effectId)) {
        throw contractError(
          `/domain_obligations/${domainIndex}/satisfied_by_effect_ids/${effectIndex}`,
          'domain obligation references an undefined effect obligation',
          { dangling_reference: effectId }
        );
      }
    }
  }
}

function assertDomainCoverage(domains) {
  const covered = new Set(domains.map(obligation => obligation.domain));
  for (const domain of UPDATE_OBLIGATION_DOMAINS) {
    if (!covered.has(domain)) {
      throw contractError('/domain_obligations', 'fixed update domain is not covered', {
        missing_domain: domain
      });
    }
  }

  const signatures = new Map();
  for (let index = 0; index < domains.length; index += 1) {
    const obligation = domains[index];
    const signature = `${obligation.domain}\u0000${obligation.scope_refs.join('\u0000')}`;
    if (signatures.has(signature)) {
      throw contractError(
        `/domain_obligations/${index}/scope_refs`,
        'the same domain scope cannot be represented by multiple obligations',
        { first_path: signatures.get(signature) }
      );
    }
    signatures.set(signature, `/domain_obligations/${index}/scope_refs`);
  }
}

function assertArtifactGates(artifacts) {
  const bindingOwners = new Map();
  let canonicalMemoryCount = 0;
  let dailyCount = 0;
  for (let index = 0; index < artifacts.length; index += 1) {
    const artifact = artifacts[index];
    if (bindingOwners.has(artifact.target_binding)) {
      throw contractError(
        `/artifact_obligations/${index}/target_binding`,
        'artifact target_binding must be unique',
        { first_path: bindingOwners.get(artifact.target_binding) }
      );
    }
    bindingOwners.set(
      artifact.target_binding,
      `/artifact_obligations/${index}/target_binding`
    );
    if (artifact.kind === 'memory' && artifact.target_binding === 'server_bound') {
      canonicalMemoryCount += 1;
    }
    if (artifact.kind === 'shinobi_daily') dailyCount += 1;
  }
  if (canonicalMemoryCount !== 1) {
    throw contractError(
      '/artifact_obligations',
      'exactly one canonical server_bound memory obligation is required',
      { actual: canonicalMemoryCount }
    );
  }
  if (dailyCount !== 1) {
    throw contractError(
      '/artifact_obligations',
      'exactly one shinobi_daily obligation is required',
      { actual: dailyCount }
    );
  }
}

function assertNarrativeModeGate(narratives, narrativeMode) {
  const expectedAudiences = narrativeMode === 'shared'
    ? ['shared']
    : ['seat:A', 'seat:B'];
  if (narratives.length !== expectedAudiences.length) {
    throw contractError(
      '/narrative_obligations',
      'narrative obligation count does not match narrative_mode',
      {
        narrative_mode: narrativeMode,
        expected_count: expectedAudiences.length,
        actual_count: narratives.length
      }
    );
  }
  const audiences = new Set(narratives.map(obligation => obligation.audience));
  for (const audience of expectedAudiences) {
    if (!audiences.has(audience)) {
      throw contractError(
        '/narrative_obligations',
        'narrative obligations are missing a required audience',
        { narrative_mode: narrativeMode, missing_audience: audience }
      );
    }
  }
  for (let index = 0; index < narratives.length; index += 1) {
    if (!expectedAudiences.includes(narratives[index].audience)) {
      throw contractError(
        `/narrative_obligations/${index}/audience`,
        'narrative audience does not belong to narrative_mode',
        { narrative_mode: narrativeMode, audience: narratives[index].audience }
      );
    }
  }
}

/**
 * Validates the complete deterministic obligation set. Narrative delivery and
 * grounding remain mandatory server gates; no model-controlled opt-out field
 * exists in this contract.
 */
export function assertUpdateObligations(value) {
  assertExactKeys(value, {
    allowed: TOP_LEVEL_KEYS,
    path: '/',
    label: 'UpdateObligations'
  });
  assertString(value.schema, {
    path: '/schema',
    label: 'schema',
    enumValues: [UPDATE_OBLIGATIONS_SCHEMA],
    max: 128
  });
  assertIdentifier(value.turn_id, {
    path: '/turn_id',
    label: 'turn_id',
    prefix: 'turn_',
    max: 160
  });
  assertSha256(value.resolution_hash, '/resolution_hash', 'resolution_hash');
  assertString(value.narrative_mode, {
    path: '/narrative_mode',
    label: 'narrative_mode',
    enumValues: NARRATIVE_MODES,
    max: 32
  });

  const effects = [];
  assertArray(value.effect_obligations, {
    path: '/effect_obligations',
    label: 'effect_obligations',
    max: UPDATE_OBLIGATION_LIMITS.maxEffects,
    item(item, itemPath) {
      effects.push(normalizeEffectObligation(item, itemPath));
    }
  });
  assertUniqueIdentity(effects, 'effect_id', '/effect_obligations', 'effect_id');
  assertUniqueIdentity(effects, 'effect_seq', '/effect_obligations', 'effect_seq');
  effects.sort((left, right) => left.effect_seq - right.effect_seq);
  for (let index = 0; index < effects.length; index += 1) {
    if (effects[index].effect_seq !== index + 1) {
      throw contractError(
        `/effect_obligations/${index}/effect_seq`,
        'effect_seq must be contiguous and 1-based',
        { expected: index + 1, actual: effects[index].effect_seq }
      );
    }
  }

  const domains = [];
  assertArray(value.domain_obligations, {
    path: '/domain_obligations',
    label: 'domain_obligations',
    min: UPDATE_OBLIGATION_DOMAINS.length,
    max: UPDATE_OBLIGATION_LIMITS.maxDomains,
    item(item, itemPath) {
      domains.push(normalizeDomainObligation(item, itemPath));
    }
  });
  assertDomainCoverage(domains);

  const artifacts = [];
  assertArray(value.artifact_obligations, {
    path: '/artifact_obligations',
    label: 'artifact_obligations',
    min: 2,
    max: UPDATE_OBLIGATION_LIMITS.maxArtifacts,
    item(item, itemPath) {
      artifacts.push(normalizeArtifactObligation(item, itemPath));
    }
  });
  assertArtifactGates(artifacts);

  const narratives = [];
  assertArray(value.narrative_obligations, {
    path: '/narrative_obligations',
    label: 'narrative_obligations',
    min: 1,
    max: 2,
    item(item, itemPath) {
      narratives.push(normalizeNarrativeObligation(item, itemPath));
    }
  });
  assertNarrativeModeGate(narratives, value.narrative_mode);

  const obligationIds = new Map();
  assertUniqueIdentity(
    domains,
    'obligation_id',
    '/domain_obligations',
    'obligation_id',
    obligationIds
  );
  assertUniqueIdentity(
    artifacts,
    'obligation_id',
    '/artifact_obligations',
    'obligation_id',
    obligationIds
  );
  assertUniqueIdentity(
    narratives,
    'obligation_id',
    '/narrative_obligations',
    'obligation_id',
    obligationIds
  );

  assertEffectReferenceClosure(effects, domains);
  domains.sort((left, right) => compareText(left.obligation_id, right.obligation_id));
  artifacts.sort((left, right) => compareText(left.obligation_id, right.obligation_id));
  const audienceOrder = new Map(NARRATIVE_OBLIGATION_AUDIENCES.map((audience, index) => (
    [audience, index]
  )));
  narratives.sort((left, right) => audienceOrder.get(left.audience) - audienceOrder.get(right.audience));

  return immutableContractValue({
    schema: UPDATE_OBLIGATIONS_SCHEMA,
    turn_id: value.turn_id,
    resolution_hash: value.resolution_hash,
    narrative_mode: value.narrative_mode,
    effect_obligations: effects,
    domain_obligations: domains,
    artifact_obligations: artifacts,
    narrative_obligations: narratives
  });
}

export function inspectUpdateObligations(value) {
  return inspectContract(value, assertUpdateObligations);
}
