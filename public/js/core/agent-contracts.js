export const AGENT_CONTRACT_SCHEMAS = Object.freeze({
  sceneBrief: 'naruto.scene-brief/v1',
  characterDecision: 'naruto.character-decision/v1',
  storyArcPlan: 'naruto.story-arc-plan/v1',
  turnEnvelope: 'naruto.turn-envelope/v1',
  auditReport: 'naruto.agent-audit/v1'
});

const FORBIDDEN_SCENE_KEYS = new Set([
  'action', 'actions', 'dialogue', 'decision', 'decisions', 'outcome', 'result',
  'npc_action', 'npcAction', 'player_action', 'playerAction'
]);
const FORBIDDEN_PLAN_KEYS = new Set([
  'forcedOutcome', 'requiredOutcome', 'playerAction', 'npcAction', 'dialogue',
  'scriptedAction', 'mustHappen'
]);

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function record(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function text(value, max = 1200) {
  return String(value ?? '').replace(/\u0000/g, '').trim().slice(0, max);
}

function textList(value, { maxItems = 24, maxChars = 600 } = {}) {
  return [...new Set((Array.isArray(value) ? value : [])
    .map(item => text(item, maxChars))
    .filter(Boolean))].slice(0, maxItems);
}

function forbiddenKeys(value, forbidden, path = '$', findings = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => forbiddenKeys(item, forbidden, `${path}[${index}]`, findings));
    return findings;
  }
  if (!record(value)) return findings;
  for (const [key, nested] of Object.entries(value)) {
    if (forbidden.has(key)) findings.push(`${path}.${key}`);
    forbiddenKeys(nested, forbidden, `${path}.${key}`, findings);
  }
  return findings;
}

function throwContract(name, errors) {
  const error = new Error(`${name} contract invalid: ${errors.join('; ')}`);
  error.name = 'AgentContractError';
  error.code = 'AGENT_CONTRACT_INVALID';
  error.details = [...errors];
  throw error;
}

export function normalizeSceneBrief(value = {}) {
  const source = record(value) ? value : {};
  return Object.freeze({
    schema: AGENT_CONTRACT_SCHEMAS.sceneBrief,
    id: text(source.id, 120) || `scene:${Date.now()}`,
    location: text(source.location, 240),
    time: text(source.time, 160),
    participants: Object.freeze(textList(source.participants, { maxItems: 32, maxChars: 80 })),
    playerIntent: text(source.playerIntent ?? source.player_intent, 1200),
    facts: Object.freeze(textList(source.facts, { maxItems: 40, maxChars: 800 })),
    constraints: Object.freeze(textList(source.constraints, { maxItems: 40, maxChars: 800 })),
    tensions: Object.freeze(textList(source.tensions, { maxItems: 20, maxChars: 600 })),
    evidenceRefs: Object.freeze(textList(source.evidenceRefs ?? source.evidence_refs, {
      maxItems: 80,
      maxChars: 240
    }))
  });
}

export function assertSceneBrief(value) {
  const errors = [];
  if (!record(value)) errors.push('scene brief must be an object');
  const forbidden = forbiddenKeys(value, FORBIDDEN_SCENE_KEYS);
  if (forbidden.length) errors.push(`NPC/player decisions are forbidden: ${forbidden.join(', ')}`);
  const brief = normalizeSceneBrief(value);
  if (!brief.location) errors.push('location is required');
  if (!brief.participants.length) errors.push('participants are required');
  if (!brief.playerIntent) errors.push('playerIntent is required');
  if (errors.length) throwContract('SceneBrief', errors);
  return brief;
}

export function normalizeCharacterDecision(value = {}, options = {}) {
  const source = record(value) ? value : {};
  const npc = text(source.npc ?? source.npcName ?? options.npc, 80);
  const observableSource = record(source.observable) ? source.observable : source;
  const privateSource = record(source.private) ? source.private : source;
  const fallback = source.provenance === 'director-fallback' || source.fallback === true;
  return Object.freeze({
    schema: AGENT_CONTRACT_SCHEMAS.characterDecision,
    id: text(source.id, 160) || `decision:${npc || 'unknown'}:${options.turn ?? 0}`,
    npc,
    sceneId: text(source.sceneId ?? source.scene_id ?? options.sceneId, 160),
    observable: Object.freeze({
      action: text(observableSource.action, 800),
      dialogue: text(observableSource.dialogue, 800),
      moodShift: text(observableSource.moodShift ?? observableSource.mood_shift, 240),
      towardsPlayer: text(observableSource.towardsPlayer ?? observableSource.towards_player, 320)
    }),
    private: Object.freeze({
      thought: text(privateSource.thought ?? privateSource.innerThought ?? source.innerThought, 800)
    }),
    provenance: fallback ? 'director-fallback' : 'character-agent',
    fallbackReason: fallback ? text(source.fallbackReason ?? source.fallback_reason, 500) : '',
    evidenceRefs: Object.freeze(textList(source.evidenceRefs ?? source.evidence_refs, {
      maxItems: 80,
      maxChars: 240
    })),
    createdAt: Number(source.createdAt ?? source.created_at) || Date.now()
  });
}

export function assertCharacterDecision(value, options = {}) {
  const decision = normalizeCharacterDecision(value, options);
  const errors = [];
  if (!decision.npc) errors.push('npc is required');
  if (!decision.sceneId) errors.push('sceneId is required');
  if (!decision.observable.action && !decision.observable.dialogue) {
    errors.push('at least one observable action or dialogue is required');
  }
  if (decision.provenance === 'director-fallback' && !decision.fallbackReason) {
    errors.push('director fallback requires fallbackReason');
  }
  if (errors.length) throwContract('CharacterDecision', errors);
  return decision;
}

export function toWriterCharacterDecision(decision) {
  const normalized = assertCharacterDecision(decision);
  return Object.freeze({
    id: normalized.id,
    npc: normalized.npc,
    sceneId: normalized.sceneId,
    observable: clone(normalized.observable),
    provenance: normalized.provenance,
    fallbackReason: normalized.fallbackReason,
    evidenceRefs: clone(normalized.evidenceRefs)
  });
}

function normalizePlanDay(value, index) {
  const source = record(value) ? value : {};
  return Object.freeze({
    dayOffset: Number.isInteger(source.dayOffset ?? source.day_offset)
      ? Number(source.dayOffset ?? source.day_offset)
      : index,
    date: text(source.date, 80),
    pressures: Object.freeze(textList(source.pressures, { maxItems: 12, maxChars: 600 })),
    opportunities: Object.freeze(textList(source.opportunities, { maxItems: 12, maxChars: 600 })),
    triggers: Object.freeze(textList(source.triggers, { maxItems: 16, maxChars: 600 })),
    invalidationConditions: Object.freeze(textList(
      source.invalidationConditions ?? source.invalidation_conditions,
      { maxItems: 16, maxChars: 600 }
    ))
  });
}

export function normalizeStoryArcPlan(value = {}, options = {}) {
  const source = record(value) ? value : {};
  const days = (Array.isArray(source.days) ? source.days : []).slice(0, 3)
    .map((day, index) => normalizePlanDay(day, index));
  return Object.freeze({
    schema: AGENT_CONTRACT_SCHEMAS.storyArcPlan,
    id: text(source.id, 160) || `story-plan:${options.branchId || 'branch_main'}:${options.turn ?? 0}`,
    branchId: text(source.branchId ?? source.branch_id ?? options.branchId, 160) || 'branch_main',
    basedOnNodeId: text(source.basedOnNodeId ?? source.based_on_node_id ?? options.nodeId, 160),
    startDate: text(source.startDate ?? source.start_date ?? options.startDate, 80),
    premise: text(source.premise, 1200),
    days: Object.freeze(days),
    refreshTriggers: Object.freeze(textList(source.refreshTriggers ?? source.refresh_triggers, {
      maxItems: 20,
      maxChars: 500
    })),
    createdAt: Number(source.createdAt ?? source.created_at) || Date.now()
  });
}

export function assertStoryArcPlan(value, options = {}) {
  const errors = [];
  const forbidden = forbiddenKeys(value, FORBIDDEN_PLAN_KEYS);
  if (forbidden.length) errors.push(`forced outcomes/actions are forbidden: ${forbidden.join(', ')}`);
  const plan = normalizeStoryArcPlan(value, options);
  if (!plan.premise) errors.push('premise is required');
  if (plan.days.length !== 3) errors.push('exactly three in-game days are required');
  plan.days.forEach((day, index) => {
    if (day.dayOffset !== index) errors.push(`days[${index}].dayOffset must equal ${index}`);
    if (!day.pressures.length && !day.opportunities.length) {
      errors.push(`days[${index}] requires a pressure or opportunity`);
    }
    if (!day.triggers.length) errors.push(`days[${index}].triggers is required`);
    if (!day.invalidationConditions.length) {
      errors.push(`days[${index}].invalidationConditions is required`);
    }
  });
  if (errors.length) throwContract('StoryArcPlan', errors);
  return plan;
}

export function createTurnEnvelope(value = {}) {
  const decisions = (Array.isArray(value.characterDecisions) ? value.characterDecisions : [])
    .map(item => assertCharacterDecision(item));
  return Object.freeze({
    schema: AGENT_CONTRACT_SCHEMAS.turnEnvelope,
    turnId: text(value.turnId ?? value.turn_id, 180),
    branchId: text(value.branchId ?? value.branch_id, 160) || 'branch_main',
    nodeId: text(value.nodeId ?? value.node_id, 160),
    sceneBrief: value.sceneBrief ? assertSceneBrief(value.sceneBrief) : null,
    narrativeArtifact: clone(value.narrativeArtifact ?? null),
    characterDecisions: Object.freeze(decisions),
    characterDecisionRefs: Object.freeze(textList(
      value.characterDecisionRefs ?? decisions.map(item => item.id),
      { maxItems: 80, maxChars: 180 }
    )),
    staged: Object.freeze({
      variableUpdates: clone(value.staged?.variableUpdates ?? null),
      memory: clone(value.staged?.memory ?? null),
      shinobiDaily: clone(value.staged?.shinobiDaily ?? null)
    }),
    storyPlan: value.storyPlan ? assertStoryArcPlan(value.storyPlan) : null,
    trace: Object.freeze(clone(Array.isArray(value.trace) ? value.trace : [])),
    audit: value.audit ? clone(value.audit) : null
  });
}

export function auditTurnEnvelope(envelope, requirements = {}) {
  const errors = [];
  const warnings = [];
  let normalized;
  try { normalized = createTurnEnvelope(envelope); } catch (error) {
    errors.push(...(error.details || [error.message]));
    normalized = envelope || {};
  }
  const narrative = String(
    normalized?.narrativeArtifact?.displayText
    ?? normalized?.narrativeArtifact?.text
    ?? normalized?.narrativeArtifact
    ?? ''
  ).trim();
  if (!narrative) errors.push('visible narrative is missing');

  const decisions = Array.isArray(normalized?.characterDecisions)
    ? normalized.characterDecisions
    : [];
  const refs = new Set(normalized?.characterDecisionRefs || []);
  for (const decision of decisions) {
    if (!refs.has(decision.id)) warnings.push(`writer provenance missing for ${decision.npc}`);
    if (decision.provenance === 'director-fallback') {
      warnings.push(`director fallback used for ${decision.npc}: ${decision.fallbackReason}`);
    }
  }
  for (const npc of textList(requirements.requiredNpcs, { maxItems: 64, maxChars: 80 })) {
    if (!decisions.some(item => item.npc === npc)) warnings.push(`character decision missing for ${npc}`);
  }
  if (requirements.requireVariables && !normalized?.staged?.variableUpdates) {
    errors.push('staged variable updates are missing');
  }
  if (requirements.requireMemory && !normalized?.staged?.memory) errors.push('staged memory is missing');
  if (requirements.requireDaily && !normalized?.staged?.shinobiDaily) errors.push('staged Shinobi Daily is missing');
  if (requirements.requireStoryPlan && !normalized?.storyPlan) warnings.push('three-day story plan is missing');
  if (requirements.presetCompliant === false) warnings.push('preset review suggested changes');

  return Object.freeze({
    schema: AGENT_CONTRACT_SCHEMAS.auditReport,
    valid: errors.length === 0,
    errors: Object.freeze([...new Set(errors)]),
    warnings: Object.freeze([...new Set(warnings)]),
    checks: Object.freeze({
      narrative: Boolean(narrative),
      npcProvenance: ![...errors, ...warnings].some(item => item.includes('character decision') || item.includes('provenance')),
      variables: !requirements.requireVariables || Boolean(normalized?.staged?.variableUpdates),
      memory: !requirements.requireMemory || Boolean(normalized?.staged?.memory),
      shinobiDaily: !requirements.requireDaily || Boolean(normalized?.staged?.shinobiDaily),
      storyPlan: !requirements.requireStoryPlan || Boolean(normalized?.storyPlan),
      preset: requirements.presetCompliant !== false
    }),
    auditedAt: Date.now()
  });
}

export function assertAuditReport(report) {
  if (!report?.valid) throwContract('AuditReport', report?.errors || ['audit failed']);
  return report;
}

