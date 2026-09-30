import {
  CANON_DATABASE,
  normalizeCanonDate
} from '../../../js/data/canon-database.js';
import { worldbookV2Resolver } from '../../../js/data/worldbook/runtime-resolver.js';
import {
  authoritativeResolutionCheckRuleEvidence
} from '../domain/authoritative-resolution-check.js';
import { canonicalStringify, canonicalizeJson, sha256Hex } from '../domain/canonical-json.js';
import { assertReducerDomainState } from '../domain/reducers/index.js';

const EVIDENCE_SCHEMA = 'naruto.multiplayer-production-knowledge-evidence/v1';
const WORLDBOOK_EVIDENCE_SCHEMA = 'naruto.multiplayer-worldbook-evidence/v1';
const MAX_QUERY_LENGTH = 16_000;
const MAX_WORLDBOOK_ENTRIES = 12;
const MAX_WORLDBOOK_BYTES = 28_000;

function immutable(value) {
  const normalized = canonicalizeJson(value, { maxDepth: 96, maxNodes: 500_000 });
  const freeze = current => {
    if (current && typeof current === 'object' && !Object.isFrozen(current)) {
      for (const child of Object.values(current)) freeze(child);
      Object.freeze(current);
    }
    return current;
  };
  return freeze(normalized);
}

function strings(values) {
  return values
    .filter(value => typeof value === 'string' && value.trim())
    .map(value => value.trim());
}

function legacySearchState(state) {
  const primary = state.actors.A;
  const secondary = state.actors.B;
  const locations = state.shared_world.world_state.locations
    .map(item => item.location_id ?? item.display_name ?? item.entity_id)
    .filter(Boolean);
  const missions = [
    ...state.shared_world.shared_missions.entries,
    ...primary.missions.entries,
    ...secondary.missions.entries
  ];
  const projection = {
    '世界·时间': state.shared_world.calendar.display_date,
    '世界·年代': state.shared_world.calendar.display_date,
    '世界·地点': locations.join('、'),
    '玩家·姓名': primary.player.display_name,
    '玩家·忍阶': primary.player.rank,
    '联机角色B·姓名': secondary.player.display_name,
    '联机角色B·忍阶': secondary.player.rank,
    _missions: {
      active: Object.fromEntries(missions.map(mission => [mission.mission_id, {
        title: mission.title ?? mission.display_name ?? mission.mission_id,
        location: mission.location_id ?? null,
        objective: mission.objective ?? null
      }]))
    }
  };
  for (const seat of ['A', 'B']) {
    for (const skill of state.actors[seat].skills.entries) {
      const prefix = `技能·${seat}·${skill.display_name}`;
      projection[`${prefix}·名称`] = skill.display_name;
      projection[`${prefix}·等级`] = skill.rank;
      projection[`${prefix}·熟练度`] = skill.mastery;
      if (skill.canonical_ref) projection[`${prefix}·数据库ID`] = skill.canonical_ref;
    }
  }
  return projection;
}

function queryFor({ job, state, resolution = null }) {
  const parts = [
    ...(job?.actions ?? []).map(action => action.text),
    state.actors.A.player.display_name,
    state.actors.B.player.display_name,
    ...state.actors.A.skills.entries.flatMap(skill => [skill.display_name, skill.canonical_ref]),
    ...state.actors.B.skills.entries.flatMap(skill => [skill.display_name, skill.canonical_ref]),
    ...state.shared_world.world_state.npc_profiles.flatMap(profile => [
      profile.display_name,
      profile.npc_id
    ]),
    ...state.shared_world.world_state.locations.flatMap(location => [
      location.display_name,
      location.location_id,
      location.entity_id
    ]),
    ...(resolution?.events ?? []).map(event => event.summary)
  ];
  return strings(parts).join('\n').slice(0, MAX_QUERY_LENGTH);
}

function compactWorldbookEntry(entry) {
  return {
    id: entry.id,
    title: entry.title,
    category: entry.category,
    validity: entry.validity,
    knowledge: entry.knowledge,
    entity_ids: entry.entity_ids,
    organization_ids: entry.organization_ids,
    content: entry.content,
    character_profile: entry.character_profile,
    source: entry.source,
    safety: entry.safety
  };
}

function boundedWorldbookResolution(resolution) {
  const entries = [];
  let used = 0;
  for (const value of resolution.entries) {
    if (entries.length >= MAX_WORLDBOOK_ENTRIES) break;
    const entry = compactWorldbookEntry(value);
    const cost = Buffer.byteLength(canonicalStringify(entry), 'utf8');
    if (entries.length > 0 && used + cost > MAX_WORLDBOOK_BYTES) continue;
    entries.push(entry);
    used += cost;
  }
  return immutable({
    schema: WORLDBOOK_EVIDENCE_SCHEMA,
    resolver_schema: resolution.schema,
    audience: resolution.audience,
    current_date: resolution.current_date,
    entries,
    selected_ids: entries.map(entry => entry.id),
    evidence_hash: `sha256:${sha256Hex({
      schema: WORLDBOOK_EVIDENCE_SCHEMA,
      current_date: resolution.current_date,
      entries
    })}`
  });
}

function resolveWorldbook({ query, searchState, currentDate, audience }) {
  return boundedWorldbookResolution(worldbookV2Resolver.resolve({
    query,
    state: searchState,
    currentDate,
    audience,
    maxEntries: MAX_WORLDBOOK_ENTRIES,
    budget: MAX_WORLDBOOK_BYTES
  }));
}

function publicWorldbookFacts(resolution) {
  return resolution.entries
    .filter(entry => entry.knowledge.visibility === 'public')
    .map(entry => ({
      fact_id: `public:worldbook:${entry.id}`,
      summary: entry.content,
      title: entry.title,
      canonical_source_ref: entry.id,
      audiences: ['seat:A', 'seat:B'],
      world_public: true
    }));
}

function explicitWorldPublicFacts(state) {
  const candidates = state.shared_world?.continuity_ledger?.world_public_facts;
  if (!Array.isArray(candidates)) return [];
  return candidates.filter(item => (
    item && typeof item === 'object' && !Array.isArray(item)
      && typeof item.fact_id === 'string'
      && typeof item.summary === 'string'
      && item.world_public === true
      && Array.isArray(item.audiences)
      && item.audiences.includes('seat:A')
      && item.audiences.includes('seat:B')
  )).map(item => ({
    fact_id: item.fact_id,
    summary: item.summary,
    audiences: ['seat:A', 'seat:B'],
    world_public: true
  }));
}

/**
 * Production adapter over the repository's existing canon database and V2
 * worldbook runtime resolver. It only receives the frozen checkpoint state;
 * browser overrides, current UI state and player-provided authority fields do
 * not enter this path.
 */
export function createProductionKnowledgeEvidence() {
  function authoritative({ job, state: stateValue }) {
    const state = assertReducerDomainState(stateValue);
    const searchState = legacySearchState(state);
    const query = queryFor({ job, state });
    const currentDate = normalizeCanonDate(state.shared_world.calendar.display_date);
    const canonContext = CANON_DATABASE.buildContext({
      query,
      state: searchState,
      maxTechniques: 8,
      budget: 8_000
    });
    const worldbook = resolveWorldbook({
      query,
      searchState,
      currentDate,
      audience: 'reviewer'
    });
    return immutable({
      schema: EVIDENCE_SCHEMA,
      frozen_state_revision: state.meta.state_revision,
      calendar: state.shared_world.calendar,
      actor_skill_summaries: Object.fromEntries(['A', 'B'].map(seat => [
        seat,
        state.actors[seat].skills.entries.map(skill => ({
          skill_id: skill.skill_id,
          display_name: skill.display_name,
          category: skill.category,
          rank: skill.rank,
          mastery: skill.mastery,
          canonical_ref: skill.canonical_ref
        }))
      ])),
      canon_database: {
        revision: CANON_DATABASE.revision,
        timeline_hash: CANON_DATABASE.meta.timelineHash,
        technique_hash: CANON_DATABASE.meta.techniqueHash,
        context: canonContext
      },
      worldbook,
      resolution_check_rules: authoritativeResolutionCheckRuleEvidence(),
      explicit_world_public_facts: explicitWorldPublicFacts(state)
    });
  }

  function worldPublicFacts({ job, state: stateValue, resolution = null }) {
    const state = assertReducerDomainState(stateValue);
    const searchState = legacySearchState(state);
    const query = queryFor({ job, state, resolution });
    const currentDate = normalizeCanonDate(state.shared_world.calendar.display_date);
    const worldbook = resolveWorldbook({
      query,
      searchState,
      currentDate,
      audience: 'writer'
    });
    const byId = new Map();
    for (const fact of [
      ...explicitWorldPublicFacts(state),
      ...publicWorldbookFacts(worldbook)
    ]) byId.set(fact.fact_id, fact);
    return immutable([...byId.values()].sort((left, right) => (
      left.fact_id.localeCompare(right.fact_id)
    )));
  }

  return Object.freeze({ authoritative, worldPublicFacts });
}
