import { projectNarrativeForMemory } from './narrative-memory.js';
import {
  CANON_DATABASE,
  formatCanonDate,
  normalizeCanonDate
} from '../data/canon-database.js';
import {
  formatOpeningContractPrompt,
  resolveOpeningContract
} from '../systems/opening-contract.js';
import { compileContinuityAnchors } from './continuity-ledger.js';
import { worldbookV2Resolver } from '../data/worldbook/runtime-resolver.js';
import { normalizeNpcIdentity } from '../data/npc-identity.js';

export const EVIDENCE_AUDIENCES = Object.freeze([
  'narrator',
  'writer',
  'updater',
  'reviewer',
  'planner',
  'npc'
]);

const PLAYER_FIELDS = Object.freeze([
  '玩家·姓名', '玩家·年龄', '玩家·性别', '玩家·忍阶', '玩家·正式忍阶',
  '玩家·战力等级', '玩家·所属村', '玩家·出身', '玩家·查克拉属性',
  '玩家·难度', '玩家·个性', '玩家·公开身份', '玩家·当前目标',
  '玩家·声望标签', '玩家·存活', '玩家·死因'
]);

const WORLD_FIELDS = Object.freeze([
  '世界·地点', '世界·时间', '世界·年代', '世界·月份', '世界·天气',
  '世界·已探索区域', '世界·活跃事件'
]);

const ATTRIBUTE_PREFIXES = Object.freeze(['属性·', '进度·']);
const ENTITY_PREFIXES = Object.freeze(['技能·', '物品·']);

export const UPDATE_OBLIGATION_DOMAINS = Object.freeze([
  Object.freeze({ id: 'world', label: '时间地点与地图' }),
  Object.freeze({ id: 'attributes', label: '资源属性与成长' }),
  Object.freeze({ id: 'skills', label: '技能与忍术' }),
  Object.freeze({ id: 'equipment', label: '物品金钱与装备' }),
  Object.freeze({ id: 'missions', label: '任务' }),
  Object.freeze({ id: 'relationships', label: '人物关系与NPC状态' }),
  Object.freeze({ id: 'combat', label: '战斗' }),
  Object.freeze({ id: 'events', label: '事件' })
]);

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

function compileContinuitySafely(ledger, options) {
  if (!ledger) return null;
  try {
    return compileContinuityAnchors(ledger, { minImportance: 0, limit: 64, ...options });
  } catch (error) {
    console.warn('[TurnEvidence] 连续性账本无效，本回合按空锚点降级:', error.message);
    return null;
  }
}

function pick(source, keys) {
  const result = {};
  for (const key of keys) {
    if (source?.[key] !== undefined && source[key] !== '') result[key] = clone(source[key]);
  }
  return result;
}

function pickPrefixes(source, prefixes) {
  const result = {};
  for (const [key, value] of Object.entries(source || {})) {
    if (prefixes.some(prefix => key.startsWith(prefix))) result[key] = clone(value);
  }
  return result;
}

function normalizedText(value) {
  return String(value || '').replace(/\s+/g, '').toLowerCase();
}

function textOverlaps(left, right) {
  const a = normalizedText(left);
  const b = normalizedText(right);
  if (!a || !b) return false;
  return a.includes(b) || b.includes(a);
}

function currentDateOf(state) {
  return normalizeCanonDate(state?.['世界·时间'] || state?.['世界·年代']);
}

function stateSkillNames(state) {
  const names = new Set();
  for (const key of Object.keys(state || {})) {
    const match = key.match(/^技能·[^·]+·(.+?)·名称$/);
    if (match && state[key]) names.add(String(state[key]));
    const pathMatch = key.match(/^技能·[^·]+·(.+?)·/);
    if (pathMatch) names.add(pathMatch[1]);
  }
  return names;
}

function relationshipNames(state) {
  return Object.keys(state?._relationships || {});
}

function nonEmptyText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function candidateAliases(value) {
  return [...new Set((Array.isArray(value) ? value : [])
    .map(normalizeNpcIdentity)
    .filter(alias => alias.length >= 2))];
}

function publicTextList(value) {
  return (Array.isArray(value) ? value : []).map(nonEmptyText).filter(Boolean);
}

export function projectCharacterMemoryDeltaForUpdater(delta = null) {
  if (!isRecord(delta)) return null;
  const changes = {};
  for (const [key, value] of Object.entries(delta.changes || {})) {
    if (!isRecord(value)) continue;
    const npcName = normalizeNpcIdentity(value.npcName || key);
    const changeKey = normalizeNpcIdentity(key) || npcName;
    if (!npcName || !changeKey) continue;
    const aliases = candidateAliases(value.aliases).filter(alias => alias !== npcName);
    const currentMood = nonEmptyText(value.currentMood);
    const knownFactsAppend = publicTextList(value.knownFactsAppend);
    const recentActionsAppend = (Array.isArray(value.recentActionsAppend)
      ? value.recentActionsAppend
      : []).map(item => {
      if (!isRecord(item)) return null;
      const action = nonEmptyText(item.action);
      const dialogue = nonEmptyText(item.dialogue);
      if (!action && !dialogue) return null;
      const turn = Number(item.turn);
      return {
        ...(Number.isFinite(turn) ? { turn: Math.max(0, turn) } : {}),
        ...(action ? { action } : {}),
        ...(dialogue ? { dialogue } : {})
      };
    }).filter(Boolean);
    const relationShift = nonEmptyText(value.relationShift);
    changes[changeKey] = {
      npcName,
      ...(aliases.length ? { aliases } : {}),
      ...(currentMood ? { currentMood } : {}),
      ...(knownFactsAppend.length ? { knownFactsAppend } : {}),
      ...(recentActionsAppend.length ? { recentActionsAppend } : {}),
      ...(relationShift ? { relationShift } : {})
    };
  }
  const schema = nonEmptyText(delta.schema);
  const turn = Number(delta.turn);
  return {
    ...(schema ? { schema } : {}),
    ...(Number.isFinite(turn) ? { turn: Math.max(0, turn) } : {}),
    changes
  };
}

export function projectUpdaterObligations(value = null) {
  if (!isRecord(value)) return null;
  const fixedDomains = (Array.isArray(value.fixed_domains) ? value.fixed_domains : [])
    .map(item => {
      if (!isRecord(item)) return null;
      const id = nonEmptyText(item.id);
      if (!id) return null;
      const label = nonEmptyText(item.label);
      return { id, ...(label ? { label } : {}) };
    }).filter(Boolean);
  const presentNpcs = (Array.isArray(value.present_npcs) ? value.present_npcs : [])
    .map(item => {
      if (!isRecord(item)) return null;
      const npc = normalizeNpcIdentity(item.npc || item.name);
      if (!npc) return null;
      const aliases = candidateAliases(item.aliases).filter(alias => alias !== npc);
      const source = nonEmptyText(item.source);
      return {
        npc,
        ...(aliases.length ? { aliases } : {}),
        ...(typeof item.existing === 'boolean' ? { existing: item.existing } : {}),
        ...(source ? { source } : {})
      };
    }).filter(Boolean);
  const activeMissions = (Array.isArray(value.active_missions) ? value.active_missions : [])
    .map(item => {
      if (!isRecord(item)) return null;
      const id = nonEmptyText(item.id);
      if (!id) return null;
      const title = nonEmptyText(item.title || item.name);
      const status = nonEmptyText(item.status);
      const objective = nonEmptyText(item.objective);
      return {
        id,
        ...(title ? { title } : {}),
        ...(status ? { status } : {}),
        ...(objective ? { objective } : {}),
        ...(item.progress != null ? { progress: clone(item.progress) } : {})
      };
    }).filter(Boolean);
  return {
    ...(Array.isArray(value.fixed_domains) ? { fixed_domains: fixedDomains } : {}),
    present_npcs: presentNpcs,
    active_missions: activeMissions
  };
}

export function buildUpdaterObligations({
  state = {}, narrativeResponse = '', evidencePacket = null, characterMemoryDelta = null
} = {}) {
  const narrative = projectNarrativeForMemory(narrativeResponse);
  const playerName = normalizeNpcIdentity(state?.['玩家·姓名']);
  const relationships = isRecord(state?._relationships) ? state._relationships : {};
  const candidates = new Map();
  const sourcePriority = { worldbook: 1, plot: 2, relationship: 3, combat: 4, agent: 5 };
  const addCandidate = (nameValue, source, aliases = []) => {
    const name = normalizeNpcIdentity(nameValue);
    if (!name || name === playerName || name.length < 2) return;
    const normalizedAliases = candidateAliases(aliases);
    let canonicalName = name;
    for (const [existingName, existing] of candidates) {
      if (existingName === name
        || existing.aliases.includes(name)
        || normalizedAliases.includes(existingName)) {
        canonicalName = existingName;
        break;
      }
    }
    const previous = candidates.get(canonicalName) || {
      npc: canonicalName,
      aliases: [],
      source
    };
    previous.aliases = [...new Set([
      ...previous.aliases,
      ...(canonicalName !== name ? [name] : []),
      ...normalizedAliases
    ])];
    if ((sourcePriority[source] || 0) >= (sourcePriority[previous.source] || 0)) previous.source = source;
    candidates.set(canonicalName, previous);
  };

  for (const [name, relationship] of Object.entries(relationships)) {
    addCandidate(name, 'relationship', relationship?.aliases || []);
  }
  if (state?._combat?.enemy_name) addCandidate(state._combat.enemy_name, 'combat');
  for (const scene of evidencePacket?.current_plot?.scenes || []) {
    for (const participant of scene?.participants || []) addCandidate(participant, 'plot');
  }
  for (const entry of evidencePacket?.worldbook_entries || []) {
    const profile = entry?.character_profile;
    if (!profile) continue;
    const profileNames = candidateAliases(profile.names || []);
    const canonical = profileNames[0];
    if (!canonical) continue;
    addCandidate(canonical, 'worldbook', profileNames.slice(1));
  }
  for (const mention of evidencePacket?.character_mentions || []) {
    const canonical = normalizeNpcIdentity(mention?.canonical_name);
    const names = (Array.isArray(mention?.names) ? mention.names : [])
      .map(normalizeNpcIdentity).filter(Boolean);
    addCandidate(canonical, 'worldbook', names.filter(name => name !== canonical));
  }
  const publicCharacterMemoryDelta = projectCharacterMemoryDeltaForUpdater(characterMemoryDelta);
  for (const [name, change] of Object.entries(publicCharacterMemoryDelta?.changes || {})) {
    addCandidate(change?.npcName || name, 'agent', change?.aliases || []);
  }

  const presentNpcs = [];
  for (const candidate of candidates.values()) {
    const matched = [candidate.npc, ...candidate.aliases]
      .some(token => token.length >= 2 && narrative.includes(token));
    if (!matched) continue;
    presentNpcs.push({
      npc: candidate.npc,
      ...(candidate.aliases.length ? { aliases: clone(candidate.aliases) } : {}),
      existing: Object.prototype.hasOwnProperty.call(relationships, candidate.npc),
      source: candidate.source
    });
  }

  const activeMissions = Object.entries(state?._missions?.active || {}).map(([key, mission]) => ({
    id: nonEmptyText(mission?.id) || key,
    title: nonEmptyText(mission?.title || mission?.name),
    status: nonEmptyText(mission?.status) || 'active',
    objective: nonEmptyText(mission?.objective),
    progress: clone(mission?.progress || null)
  })).filter(mission => mission.id);

  return {
    fixed_domains: UPDATE_OBLIGATION_DOMAINS.map(clone),
    present_npcs: presentNpcs,
    active_missions: activeMissions
  };
}

function sceneMatches(scene, { location, query, names, activeSceneIds }) {
  if (activeSceneIds.has(scene?.id)) return true;
  if (location && textOverlaps(scene?.location, location)) return true;
  const queryText = String(query || '');
  for (const participant of scene?.participants || []) {
    if (queryText.includes(participant) || names.has(participant)) return true;
  }
  return false;
}

function observableScene(scene, { includeIds = false } = {}) {
  if (!scene) return null;
  const value = {
    title: scene.title,
    thread: scene.thread_id || scene.thread,
    location: scene.location,
    participants: clone(scene.participants || []),
    resolution_mode: scene.resolution_mode,
    requirements: clone(scene.requirements || []),
    blockers: clone(scene.blockers || []),
    setup: scene.setup,
    beats: (scene.beats || []).map(beat => ({
      ...(includeIds ? { id: beat.id } : {}),
      order: beat.order,
      summary: beat.summary,
      causal_role: beat.causal_role
    })),
    stop_condition: scene.stop_condition,
    fallbacks: clone(scene.fallbacks || []),
    reference_facts: clone(scene.reference_facts || [])
  };
  if (includeIds && scene.id) value.id = scene.id;
  return value;
}

function compileCurrentPlot(plotContext, state, userInput) {
  if (!plotContext?.day) return null;
  const location = state?.['世界·地点'] || '';
  const names = new Set(relationshipNames(state));
  if (state?._combat?.enemy_name) names.add(state._combat.enemy_name);
  const activeSceneIds = new Set([
    ...(state?._canon?.active_scene_ids || []),
    ...(state?._timeline?.active_scene_ids || [])
  ]);
  const allScenes = plotContext.day.scenes || [];
  let selected = allScenes.filter(scene => sceneMatches(scene, {
    location,
    query: userInput,
    names,
    activeSceneIds
  }));
  if (!selected.length && (plotContext.is_future || allScenes.length === 1)) selected = allScenes;
  const targetDate = plotContext.target_date || plotContext.day.date || plotContext.current_date;
  return {
    date: targetDate,
    current_date: plotContext.current_date,
    target_date: targetDate,
    days_until: Math.max(0, Number(plotContext.days_until) || 0),
    date_relation: plotContext.date_relation === 'future'
      ? 'nearest_future'
      : (plotContext.date_relation || (plotContext.is_future ? 'nearest_future' : 'current')),
    day_id: plotContext.day.id,
    title: plotContext.day.title,
    day_goal: plotContext.day.day_goal,
    start_state: clone(plotContext.day.start_state || []),
    reference_facts: clone(plotContext.day.reference_facts || []),
    matched_scene_count: selected.length,
    total_scene_count: allScenes.length,
    matched_scene_ids: selected.map(scene => scene.id).filter(Boolean),
    scenes: allScenes.map(scene => observableScene(scene, { includeIds: true }))
  };
}

function relevantSnapshot(snapshotContext, state, userInput) {
  if (!snapshotContext?.snapshot) return null;
  const query = String(userInput || '');
  const location = state?.['世界·地点'] || '';
  const names = new Set(relationshipNames(state));
  if (state?._combat?.enemy_name) names.add(state._combat.enemy_name);
  const characters = (snapshotContext.snapshot.characters || []).filter(character => (
    names.has(character.name)
    || query.includes(character.name)
    || textOverlaps(character.public_state?.location, location)
  )).slice(0, 16);
  const factions = (snapshotContext.snapshot.factions || []).filter(faction => (
    query.includes(faction.name)
    || textOverlaps(faction.location, location)
    || faction.visibility === 'public'
  )).slice(0, 16);
  return {
    as_of: snapshotContext.snapshot_date,
    current_date: snapshotContext.current_date,
    public_characters: characters.map(character => ({
      entity_id: character.entity_id,
      name: character.name,
      age: clone(character.age),
      public_state: clone(character.public_state)
    })),
    public_factions: factions.filter(faction => faction.visibility === 'public').map(clone),
    restricted_factions: factions.filter(faction => faction.visibility !== 'public').map(clone),
    backstage_truth: characters.filter(character => character.actual_state).map(character => ({
      entity_id: character.entity_id,
      name: character.name,
      actual_state: clone(character.actual_state)
    }))
  };
}

function techniqueIsAvailable(technique, currentDate, learnedNames) {
  const displayNames = [technique.name, ...(technique.aliases || []), ...(technique.lookup_aliases || [])]
    .filter(Boolean).map(String);
  if (displayNames.some(name => learnedNames.has(name))) return true;
  const earliest = normalizeCanonDate(technique.availability?.earliest_confirmed_date);
  if (!earliest || !currentDate) return true;
  return earliest.localeCompare(currentDate) <= 0;
}

function compactTechnique(technique, learnedNames) {
  const names = [technique.name, ...(technique.aliases || []), ...(technique.lookup_aliases || [])]
    .filter(Boolean).map(String);
  return {
    id: technique.id,
    name: technique.name,
    aliases: clone(technique.aliases || []),
    type: technique.type,
    rank: technique.rank,
    element: clone(technique.element || technique.elements || null),
    resource: technique.resource,
    cost: technique.cost,
    power: technique.power,
    summary: technique.summary,
    access: clone(technique.access || {}),
    availability: clone(technique.availability || {}),
    mastered_in_state: names.some(name => learnedNames.has(name)),
    known_users_are_reference_only: true
  };
}

function compactRelationshipEntries(value, limit) {
  if (Array.isArray(value)) return clone(value.slice(0, limit));
  const summary = nonEmptyText(value);
  return summary ? [{ turn: 0, time: '', summary }] : [];
}

function compactRelationships(state) {
  const result = {};
  for (const [name, relationship] of Object.entries(state?._relationships || {})) {
    result[name] = {
      entity_id: relationship.entity_id || relationship.npc_id || null,
      role: relationship.role || '',
      faction: relationship.faction || '',
      status: relationship.status || '',
      location: relationship.location || '',
      combatant: relationship.combatant === true ? true : relationship.combatant === false ? false : null,
      affection: Number(relationship.affection) || 0,
      trust: Number(relationship.trust) || 0,
      respect: Number(relationship.respect) || 0,
      last_interaction: relationship.last_interaction || '',
      promises: clone(relationship.promises || []),
      debts: clone(relationship.debts || []),
      known_secrets: clone(relationship.known_secrets || []),
      grand_summary: relationship.grand_summary || '',
      history: compactRelationshipEntries(relationship.history, 3),
      inner_thoughts: compactRelationshipEntries(relationship.inner_thoughts, 5),
      combat_stats: clone(relationship.combat_stats || null)
    };
  }
  return result;
}

export function buildCurrentStateEvidence(state = {}) {
  return {
    version: state._version || null,
    branch_id: state?._meta?.active_branch || state['系统·当前分支'] || 'branch_main',
    node_id: state?._meta?.current_node_id || state['系统·当前节点'] || null,
    turn: Number(state['系统·回合数']) || 0,
    player: pick(state, PLAYER_FIELDS),
    world: pick(state, WORLD_FIELDS),
    attributes_and_progression: pickPrefixes(state, ATTRIBUTE_PREFIXES),
    skills_and_equipment: pickPrefixes(state, ENTITY_PREFIXES),
    missions: clone(state._missions || {}),
    relationships: compactRelationships(state),
    combat: clone(state._combat || null),
    map: {
      known_locations: clone(state?._map?.known_locations || {}),
      active_pins: clone(state?._map?.active_pins || '')
    }
  };
}

function normalizeCharacterMentions(value) {
  if (!Array.isArray(value)) return [];
  const mentions = new Map();
  for (const item of value) {
    const canonicalName = normalizeNpcIdentity(item?.canonical_name);
    if (!canonicalName) continue;
    const names = [...new Set([
      canonicalName,
      ...(Array.isArray(item?.names) ? item.names.map(normalizeNpcIdentity) : [])
    ].filter(Boolean))];
    const entityId = nonEmptyText(item?.entity_id);
    const key = entityId || canonicalName;
    mentions.set(key, {
      ...(entityId ? { entity_id: entityId } : {}),
      canonical_name: canonicalName,
      names
    });
  }
  return [...mentions.values()];
}

function normalizeWorldbookResolution(value) {
  if (!value) return { entries: [], character_mentions: [] };
  if (Array.isArray(value)) return { entries: clone(value), character_mentions: [] };
  return {
    entries: Array.isArray(value.entries) ? clone(value.entries) : [],
    character_mentions: normalizeCharacterMentions(value.character_mentions)
  };
}

function worldbookVisibility(entry) {
  return entry?.knowledge?.visibility || entry?.visibility || 'public';
}

function projectWorldbook(entries, audience, entityId, npcName = '') {
  if (audience === 'planner') return clone(entries);
  return entries.filter(entry => {
    const systemAudiences = entry?.knowledge?.audience;
    if (Array.isArray(systemAudiences) && !systemAudiences.includes(audience)) return false;
    const visibility = worldbookVisibility(entry);
    if (visibility === 'backstage' || visibility === 'secret') return false;
    if (audience === 'npc' && entry?.character_profile) {
      const profileNames = [
        ...(entry.character_profile.names || []),
        ...(entry.character_profile.aliases || [])
      ];
      const isOwnProfile = Boolean(entityId) && (entry.entity_ids || []).includes(entityId)
        || Boolean(npcName) && profileNames.includes(npcName);
      if (!isOwnProfile) return false;
    }
    if (visibility === 'public') return true;
    const allowed = entry?.knowledge?.audience?.entity_ids || entry?.audience?.entity_ids || [];
    return Boolean(entityId) && allowed.includes(entityId);
  }).map(clone);
}

function redactStateForNpc(currentState, entityId, npcName) {
  const ownRelationship = Object.entries(currentState.relationships || {}).find(([name, relationship]) => (
    relationship.entity_id === entityId || name === npcName
  ));
  return {
    branch_id: currentState.branch_id,
    node_id: currentState.node_id,
    turn: currentState.turn,
    player: {
      '玩家·姓名': currentState.player?.['玩家·姓名'],
      '玩家·性别': currentState.player?.['玩家·性别'],
      '玩家·忍阶': currentState.player?.['玩家·忍阶'],
      '玩家·所属村': currentState.player?.['玩家·所属村'],
      '玩家·公开身份': currentState.player?.['玩家·公开身份']
    },
    world: currentState.world,
    relationship_to_player: ownRelationship ? { name: ownRelationship[0], ...ownRelationship[1] } : null,
    combat: currentState.combat
  };
}

function redactCharacterPrivateState(currentState) {
  const safe = clone(currentState);
  for (const relationship of Object.values(safe?.relationships || {})) {
    if (!relationship || typeof relationship !== 'object') continue;
    delete relationship.inner_thoughts;
  }
  return safe;
}

export class TurnEvidenceCompiler {
  constructor({
    canonDatabase = CANON_DATABASE,
    worldbookResolver = worldbookV2Resolver,
    continuityLedger = null
  } = {}) {
    this.canonDatabase = canonDatabase;
    this.worldbookResolver = worldbookResolver;
    this.continuityLedger = continuityLedger;
  }

  compile({
    state = {}, userInput = '', nodeId = null, branchId = null, updateObligations = null
  } = {}) {
    if (state._memory?.corrections?.length) state = {
      ...state, _memory: projectCorrectedMemory(state._memory),
      _continuity: projectCorrectedLedger(state._continuity, state._memory)
    };
    const currentDate = currentDateOf(state);
    const plotContext = currentDate ? this.canonDatabase.getPlotDayContext({ state }) : null;
    const snapshotContext = currentDate ? this.canonDatabase.getYearSnapshotContext({ state }) : null;
    const learnedNames = stateSkillNames(state);
    const techniques = this.canonDatabase.searchTechniques({ query: userInput, state, limit: 10 })
      .filter(technique => techniqueIsAvailable(technique, currentDate, learnedNames))
      .map(technique => compactTechnique(technique, learnedNames));

    let worldbookEntries = [];
    let characterMentions = [];
    if (this.worldbookResolver?.resolve) {
      const resolution = normalizeWorldbookResolution(this.worldbookResolver.resolve({
        query: userInput,
        state,
        currentDate,
        audience: 'planner'
      }));
      worldbookEntries = resolution.entries;
      characterMentions = resolution.character_mentions;
    } else if (this.worldbookResolver?.search) {
      const resolution = normalizeWorldbookResolution(
        this.worldbookResolver.search(userInput, { state, memory: state._memory || {} })
      );
      worldbookEntries = resolution.entries;
      characterMentions = resolution.character_mentions;
    }

    const resolvedNodeId = nodeId || state?._meta?.current_node_id || null;
    const resolvedBranchId = branchId || state?._meta?.active_branch || 'branch_main';
    const continuitySource = state?._continuity || null;
    const continuity = this.continuityLedger?.compileAnchors?.({
      state,
      nodeId: resolvedNodeId,
      branchId: resolvedBranchId,
      gameTime: currentDate,
      query: userInput,
      audienceId: 'writer'
    }) || compileContinuitySafely(continuitySource, {
      nodeId: resolvedNodeId,
      branchId: resolvedBranchId,
      gameTime: currentDate,
      audienceId: 'writer'
    });

    const openingContract = resolveOpeningContract(state);
    return {
      schema: 'naruto.turn-evidence/v2',
      compiled_at: Date.now(),
      node_id: resolvedNodeId,
      branch_id: resolvedBranchId,
      current_date: currentDate,
      user_input: String(userInput || ''),
      current_state: buildCurrentStateEvidence(state),
      opening_contract: clone(openingContract),
      continuity_anchors: clone(continuity),
      _continuity_ledger: clone(continuitySource),
      worldbook_entries: worldbookEntries,
      character_mentions: characterMentions,
      year_snapshot: relevantSnapshot(snapshotContext, state, userInput),
      current_plot: compileCurrentPlot(plotContext, state, userInput),
      update_obligations: updateObligations ? projectUpdaterObligations(updateObligations) : null,
      technique_definitions: techniques,
      conflicts: [],
      provenance: {
        state: 'runtime-state',
        opening: openingContract ? 'opening-contract' : null,
        worldbook: worldbookEntries.map(entry => entry.id || entry.title).filter(Boolean),
        plot: plotContext?.day?.id || null,
        techniques: techniques.map(item => item.id),
        continuity: continuity?.event_ids || []
      }
    };
  }

  project(packet, {
    audience = 'writer', entityId = null, npcName = '', includeOperationalIds = false
  } = {}) {
    if (!EVIDENCE_AUDIENCES.includes(audience)) throw new Error(`未知证据受众: ${audience}`);
    const isNpc = audience === 'npc';
    const isPlanner = audience === 'planner';
    const includeIds = audience === 'updater' || isPlanner
      || (audience === 'writer' && includeOperationalIds === true);
    const currentPlot = packet.current_plot ? clone(packet.current_plot) : null;
    if (currentPlot) {
      if (audience !== 'updater' && !isPlanner) {
        const matchedIds = new Set(currentPlot.matched_scene_ids || []);
        currentPlot.scenes = currentPlot.scenes.filter(scene => matchedIds.has(scene.id));
      }
      delete currentPlot.matched_scene_ids;
      if (!includeIds) {
        delete currentPlot.day_id;
        currentPlot.scenes = currentPlot.scenes.map(scene => observableScene(scene, { includeIds: false }));
      }
    }
    const yearSnapshot = packet.year_snapshot ? clone(packet.year_snapshot) : null;
    if (yearSnapshot && !isPlanner) {
      delete yearSnapshot.backstage_truth;
      delete yearSnapshot.restricted_factions;
    }
    const openingPrompt = formatOpeningContractPrompt(packet.opening_contract, {
      compact: audience !== 'narrator',
      audience: isNpc ? 'npc' : 'narrator'
    });
    let continuityAnchors = clone(packet.continuity_anchors);
    if (packet._continuity_ledger) {
      const audienceId = isPlanner
        ? 'narrator'
        : (isNpc ? (entityId || `npc:${npcName || 'unknown'}`) : audience);
      continuityAnchors = compileContinuitySafely(packet._continuity_ledger, {
        nodeId: packet.node_id,
        branchId: packet.branch_id,
        gameTime: packet.current_date,
        audienceId,
        includeBackstage: isPlanner
      });
    }
    const worldbookEntries = projectWorldbook(packet.worldbook_entries || [], audience, entityId, npcName);
    const provenance = clone(packet.provenance || {});
    provenance.worldbook = worldbookEntries.map(entry => entry.id || entry.title).filter(Boolean);
    if (audience !== 'updater' && !isPlanner) provenance.plot = null;
    return {
      schema: 'naruto.evidence-view/v2',
      audience,
      entity_id: entityId,
      node_id: packet.node_id,
      branch_id: packet.branch_id,
      current_date: packet.current_date,
      authority_policy: {
        current_branch_facts: 'current_state + confirmed_continuity',
        player_identity_and_agency: 'opening_contract',
        personality_and_world_lore: 'worldbook',
        date_age_faction_and_plot: 'project_timeline',
        technique_definition: 'JT database',
        player_input: 'intent_or_claim_only',
        pretrained_knowledge: 'style_only; unknown facts stay unknown'
      },
      current_state: isNpc
        ? redactStateForNpc(packet.current_state, entityId, npcName)
        : (audience === 'updater' || isPlanner
          ? clone(packet.current_state)
          : redactCharacterPrivateState(packet.current_state)),
      opening_contract: openingPrompt || '',
      continuity_anchors: continuityAnchors,
      worldbook_entries: worldbookEntries,
      ...(audience === 'updater'
        ? { character_mentions: clone(packet.character_mentions || []) }
        : {}),
      year_snapshot: yearSnapshot,
      current_plot: isNpc ? null : currentPlot,
      technique_definitions: clone(packet.technique_definitions || []),
      ...(audience === 'updater' && packet.update_obligations
        ? { update_obligations: projectUpdaterObligations(packet.update_obligations) }
        : {}),
      conflicts: clone(packet.conflicts || []),
      provenance
    };
  }
}

function jsonBlock(label, value) {
  if (value == null || value === '' || (Array.isArray(value) && !value.length)) return '';
  return `[${label}]\n${typeof value === 'string' ? value : JSON.stringify(value)}`;
}

export function renderEvidenceView(view, { stage = 'main' } = {}) {
  const blocks = [
    `[可信回合证据 · ${stage} · audience=${view.audience}]`,
    jsonBlock('字段权威', view.authority_policy),
    jsonBlock('开局契约', view.opening_contract),
    jsonBlock('当前状态', view.current_state),
    jsonBlock('连续性锚点', view.continuity_anchors),
    jsonBlock('当前日期年度公开状态', view.year_snapshot),
    jsonBlock('相关世界书', view.worldbook_entries),
    jsonBlock('当前可接续剧情', view.current_plot),
    jsonBlock('本回合更新义务', view.update_obligations),
    jsonBlock('相关忍术定义', view.technique_definitions),
    jsonBlock('待裁决冲突', view.conflicts)
  ].filter(Boolean);
  if (view.current_date) blocks.splice(1, 0, `当前项目日期: ${formatCanonDate(view.current_date)}`);
  blocks.push('[使用约束]\n只使用本证据视图允许的事实。未提供的设定保持未知；不得从预训练知识补成确定事实。最近剧情日属于可按当前分支引用、执行和改写的普通剧情上下文；仍须遵守人物知识权限与结构化数据契约。');
  return blocks.join('\n\n');
}

export const turnEvidenceCompiler = new TurnEvidenceCompiler();

export default turnEvidenceCompiler;
import { projectCorrectedLedger, projectCorrectedMemory } from './memory-corrections.js';
