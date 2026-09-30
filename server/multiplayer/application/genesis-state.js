import { MULTIPLAYER_ROOM_STATE_SCHEMA } from '../contracts/state-contracts.js';
import { buildOpeningState } from '../../../js/systems/opening-draft.js';
import { detailedOpeningDraft } from '../../../js/multiplayer/opening-draft-bridge.js';
import {
  canonicalStringify,
  canonicalizeJson,
  sha256Hex
} from '../domain/canonical-json.js';
import { DomainError } from '../domain/errors.js';
import { assertTimelineSave } from '../../../js/core/timeline-save-schema.js';
import {
  ACTOR_ATTRIBUTES_SCHEMA,
  ACTOR_ITEMS_SCHEMA,
  ACTOR_PROFILE_SCHEMA,
  ACTOR_PROGRESSION_SCHEMA,
  ACTOR_SKILLS_SCHEMA,
  COMBAT_COLLECTION_SCHEMA,
  EVENT_COLLECTION_SCHEMA,
  MISSION_COLLECTION_SCHEMA,
  WORLD_CALENDAR_SCHEMA,
  WORLD_MAP_SCHEMA,
  WORLD_STATE_SCHEMA,
  assertReducerDomainState
} from '../domain/reducers/index.js';

export const SINGLEPLAYER_GENESIS_CODEC = 'naruto.singleplayer-to-multiplayer-genesis/v1';
export const GUEST_CHARACTER_IMPORT_SCHEMA = 'naruto.multiplayer-guest-character-import/v1';
export const IMPORTED_PRIVATE_RELATIONSHIPS_SCHEMA =
  'naruto.multiplayer-imported-private-relationships/v1';
export const INITIAL_GENESIS_COMPATIBILITY_POLICY =
  'naruto.multiplayer-initial-genesis-compatibility/v1';

const INITIAL_COMPATIBILITY_CATEGORIES = new Set([
  'era',
  'date',
  'rank',
  'unique_ability',
  'item',
  'resource',
  'actor_id'
]);

const SKILL_CATEGORY = Object.freeze({
  '忍术': 'NINJUTSU',
  '体术': 'TAIJUTSU',
  '幻术': 'GENJUTSU',
  '血继限界': 'BLOODLINE',
  '天赋': 'OTHER',
  '支援': 'OTHER'
});
const ITEM_CATEGORY = Object.freeze({
  '消耗品': 'CONSUMABLE',
  '武器': 'EQUIPMENT',
  '防具': 'EQUIPMENT',
  '装备': 'EQUIPMENT',
  '素材': 'MATERIAL',
  '材料': 'MATERIAL',
  '关键': 'KEY',
  '任务': 'KEY',
  '道具': 'MATERIAL'
});

function fail(code, message, details = {}, status = 400, cause = undefined) {
  throw new DomainError(code, message, details, { status, cause });
}

function compatibilityConflict(category) {
  if (!INITIAL_COMPATIBILITY_CATEGORIES.has(category)) {
    fail(
      'GENESIS_COMPATIBILITY_CONFIGURATION_INVALID',
      'initial genesis compatibility category is invalid',
      {},
      500
    );
  }
  fail(
    'GENESIS_IMPORT_COMPATIBILITY_CONFLICT',
    'the submitted character is incompatible with this initial multiplayer genesis',
    {
      compatibility_policy: INITIAL_GENESIS_COMPATIBILITY_POLICY,
      category
    },
    409
  );
}

function shortText(value, fallback, max, label) {
  const text = String(value ?? fallback).trim();
  if (!text || text.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) {
    fail('GENESIS_PROFILE_INVALID', `${label} is invalid`, { field: label });
  }
  return text;
}

function resources() {
  return [
    { resource_id: 'chakra', version: 0, current: 50, maximum: 50 },
    { resource_id: 'mental', version: 0, current: 50, maximum: 50 },
    { resource_id: 'money', version: 0, current: 0, maximum: 1_000_000 },
    { resource_id: 'stamina', version: 0, current: 50, maximum: 50 },
    { resource_id: 'vitality', version: 0, current: 100, maximum: 100 }
  ];
}

function record(value, label, code = 'SINGLEPLAYER_GENESIS_INVALID') {
  const prototype = value && typeof value === 'object' ? Object.getPrototypeOf(value) : null;
  if (!value || Array.isArray(value)
    || (prototype !== Object.prototype && prototype !== null)) {
    fail(code, `${label} must be a plain object`, { field: label });
  }
  return value;
}

function importedText(value, fallback, max, label) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'string') {
    fail('SINGLEPLAYER_GENESIS_INVALID', `${label} must be text`, { field: label });
  }
  return shortText(value, fallback, max, label);
}

function boundedInteger(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const number = typeof value === 'string' && /^-?\d+$/u.test(value.trim())
    ? Number(value)
    : value;
  if (!Number.isSafeInteger(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function exactImportedInteger(value) {
  const number = typeof value === 'string' && /^-?\d+$/u.test(value.trim())
    ? Number(value)
    : value;
  return Number.isSafeInteger(number) ? number : null;
}

function optionalImportedInteger(snapshot, key, {
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
  category = 'resource'
} = {}) {
  const value = snapshot[key];
  if (value === undefined || value === null || value === '') return null;
  const number = exactImportedInteger(value);
  if (number === null || number < min || number > max) compatibilityConflict(category);
  return number;
}

function parsedSkillRecords(snapshot) {
  const parsed = new Map();
  for (const [key, value] of Object.entries(snapshot)) {
    const match = key.match(/^技能·(忍术|体术|幻术|血继限界|天赋|支援)·(.+)·(名称|等级|熟练度|数据库ID)$/u);
    if (!match) continue;
    const [, label, embeddedName, field] = match;
    const mapKey = `${label}\u0000${embeddedName}`;
    const current = parsed.get(mapKey) ?? { label, embedded_name: embeddedName };
    current[field] = value;
    parsed.set(mapKey, current);
  }
  return [...parsed.values()];
}

function parsedItemRecords(snapshot) {
  const parsed = new Map();
  for (const [key, value] of Object.entries(snapshot)) {
    const match = key.match(/^物品·(消耗品|武器|防具|装备|素材|材料|关键|任务|道具)·(.+)·(数量|描述)$/u);
    if (!match) continue;
    const [, label, displayName, field] = match;
    const mapKey = `${label}\u0000${displayName}`;
    const current = parsed.get(mapKey) ?? { label, display_name: displayName };
    current[field] = value;
    parsed.set(mapKey, current);
  }
  return [...parsed.values()];
}

function canonicalSkillRef(recordValue) {
  const value = recordValue['数据库ID'];
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') compatibilityConflict('unique_ability');
  const ref = value.trim();
  if (!ref || ref.length > 160) compatibilityConflict('unique_ability');
  return ref;
}

function canonicalItemRef(recordValue) {
  const description = recordValue['描述'];
  if (typeof description !== 'string' || !description.startsWith('规范引用：')) return null;
  const ref = description.slice('规范引用：'.length).trim();
  if (!ref || ref.length > 160) compatibilityConflict('item');
  return ref;
}

function temporalReferenceCategory(value) {
  const ref = String(value ?? '').trim().toLowerCase();
  if (/^(?:canon:)?era:/u.test(ref)) return 'era';
  if (/^(?:canon:)?date:/u.test(ref)) return 'date';
  return null;
}

function isExplicitUniqueReference(value) {
  const ref = String(value ?? '').trim().toLowerCase();
  return ref.startsWith('unique:') || ref.startsWith('canon:unique:');
}

function selectedImportedRank(snapshot) {
  const formal = snapshot['玩家·正式忍阶'];
  return formal === undefined || formal === null || formal === ''
    ? snapshot['玩家·忍阶']
    : formal;
}

function validateStrictImportSnapshot(snapshot, { guest = false } = {}) {
  const resourceDefinitions = [
    ['属性·当前查克拉', '属性·查克拉', 50],
    ['属性·当前精神力', '属性·精神力', 50],
    ['属性·当前体力', '属性·体力', 50],
    ['属性·当前生命力', '属性·生命力', 100]
  ];
  for (const [currentKey, maximumKey, fallback] of resourceDefinitions) {
    const maximum = optionalImportedInteger(snapshot, maximumKey, {
      min: 1,
      max: 1_000_000,
      category: 'resource'
    }) ?? fallback;
    const current = optionalImportedInteger(snapshot, currentKey, {
      max: 1_000_000,
      category: 'resource'
    });
    if (current !== null && current > maximum) compatibilityConflict('resource');
  }
  optionalImportedInteger(snapshot, '进度·金钱', {
    max: 1_000_000,
    category: 'resource'
  });
  optionalImportedInteger(snapshot, '进度·经验', { category: 'resource' });
  optionalImportedInteger(snapshot, '进度·等级', {
    min: 1,
    max: 1_000_000,
    category: 'rank'
  });
  optionalImportedInteger(snapshot, '进度·声望', {
    min: -1_000_000,
    max: 1_000_000,
    category: 'resource'
  });

  const rank = selectedImportedRank(snapshot);
  if (rank !== undefined && rank !== null && rank !== '') {
    if (typeof rank !== 'string'
      || !rank.trim()
      || rank.trim().length > 80
      || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(rank)) {
      compatibilityConflict('rank');
    }
  }

  const skills = parsedSkillRecords(snapshot);
  if (skills.length > 2_000) compatibilityConflict('unique_ability');
  const uniqueReferences = [];
  const skillIdentities = new Set();
  for (const skill of skills) {
    optionalImportedInteger(skill, '熟练度', {
      max: 100,
      category: 'unique_ability'
    });
    const ref = canonicalSkillRef(skill);
    const skillIdentity = `${SKILL_CATEGORY[skill.label]}\u0000${importedText(
      skill['名称'],
      skill.embedded_name,
      160,
      'skill.display_name'
    )}`;
    if (skillIdentities.has(skillIdentity)) compatibilityConflict('unique_ability');
    skillIdentities.add(skillIdentity);
    const temporalCategory = guest ? temporalReferenceCategory(ref) : null;
    if (temporalCategory) compatibilityConflict(temporalCategory);
    if (isExplicitUniqueReference(ref)) {
      uniqueReferences.push({ kind: 'skill', ref: ref.toLowerCase() });
    }
  }

  const items = parsedItemRecords(snapshot);
  if (items.length > 5_000) compatibilityConflict('item');
  const importedEquipmentByName = new Map();
  const itemIdentities = new Set();
  for (const item of items) {
    const quantity = optionalImportedInteger(item, '数量', {
      max: 1_000_000,
      category: 'item'
    }) ?? 1;
    const ref = canonicalItemRef(item);
    const itemName = importedText(item.display_name, '未命名物品', 160, 'item.display_name');
    const itemIdentity = `${ITEM_CATEGORY[item.label]}\u0000${itemName}`;
    if (itemIdentities.has(itemIdentity)) compatibilityConflict('item');
    itemIdentities.add(itemIdentity);
    const temporalCategory = guest ? temporalReferenceCategory(ref) : null;
    if (temporalCategory) compatibilityConflict(temporalCategory);
    if (isExplicitUniqueReference(ref)) {
      uniqueReferences.push({ kind: 'item', ref: ref.toLowerCase() });
    }
    if (quantity > 0 && ITEM_CATEGORY[item.label] === 'EQUIPMENT') {
      const name = itemName;
      const matching = importedEquipmentByName.get(name) ?? [];
      matching.push(item);
      importedEquipmentByName.set(name, matching);
    }
  }

  const slotsByName = new Map();
  for (const [field, slot] of [
    ['物品·已装备·武器', 'weapon'],
    ['物品·已装备·防具', 'armor'],
    ['物品·已装备·饰品1', 'accessory'],
    ['物品·已装备·饰品2', 'tool']
  ]) {
    const raw = snapshot[field];
    if (raw === undefined || raw === null || raw === '') continue;
    if (typeof raw !== 'string' || !raw.trim()) compatibilityConflict('item');
    const name = raw.trim();
    const prior = slotsByName.get(name);
    if (prior && prior !== slot) compatibilityConflict('item');
    slotsByName.set(name, slot);
    if ((importedEquipmentByName.get(name) ?? []).length !== 1) {
      compatibilityConflict('item');
    }
  }

  const seenUnique = new Map();
  for (const entry of uniqueReferences) {
    if (seenUnique.has(entry.ref)) {
      compatibilityConflict(entry.kind === 'skill' ? 'unique_ability' : 'item');
    }
    seenUnique.set(entry.ref, entry.kind);
  }
  return Object.freeze({ unique_references: Object.freeze(uniqueReferences) });
}

function importedBoolean(value, fallback = true) {
  if (value === true || value === '是' || value === 'true' || value === 1) return true;
  if (value === false || value === '否' || value === 'false' || value === 0) return false;
  return fallback;
}

function stableImportedId(prefix, material) {
  return `${prefix}import_${sha256Hex(canonicalStringify(material)).slice(0, 32)}`;
}

function selectedTimelineMeta(timeline) {
  return timeline.meta?.value ?? timeline.timeline?.meta ?? timeline.meta;
}

/**
 * Selects the real S0 single-player snapshot. A detached body-level `state`
 * is only a consistency copy and must be canonically identical to the chosen
 * active branch head; it can never substitute a fabricated reducer state.
 */
export function selectSingleplayerGenesisSnapshot({
  source_timeline,
  source_branch_id,
  source_node_id,
  state
}) {
  let timeline;
  try {
    timeline = canonicalizeJson(source_timeline);
    assertTimelineSave(timeline);
  } catch (error) {
    fail(
      'SOURCE_OWNER_TIMELINE_INVALID',
      'source_timeline failed the existing single-player timeline constraints',
      {},
      400,
      error
    );
  }
  const meta = selectedTimelineMeta(timeline);
  const branch = timeline.branches.find(item => item.id === source_branch_id);
  const node = timeline.nodes.find(item => item.id === source_node_id);
  if (!branch || !node
    || branch.head_node_id !== source_node_id
    || node.branch_id !== source_branch_id
    || meta?.active_branch !== source_branch_id
    || meta?.current_id !== source_node_id
    || !node.state_snapshot) {
    fail(
      'SOURCE_OWNER_TIMELINE_CHANGED',
      'source branch and node must be the selected active branch head',
      { source_branch_id, source_node_id },
      409
    );
  }
  const selected = canonicalizeJson(node.state_snapshot);
  if (state !== undefined
    && canonicalStringify(canonicalizeJson(state)) !== canonicalStringify(selected)) {
    fail(
      'SOURCE_OWNER_STATE_CHANGED',
      'body state does not match the selected timeline node snapshot',
      { source_branch_id, source_node_id },
      409
    );
  }
  return Object.freeze({ state: selected, timeline });
}

function parseDelimitedIdentities(value, prefix) {
  const names = Array.isArray(value)
    ? value
    : String(value ?? '').split(/[，,、|\n]/u);
  const unique = [...new Set(names.map(item => String(item ?? '').trim()).filter(Boolean))];
  return unique.slice(0, 256).map(displayName => ({
    id: stableImportedId(prefix, displayName),
    display_name: displayName.slice(0, 160)
  }));
}

function importedResources(snapshot) {
  const definitions = [
    ['chakra', '属性·当前查克拉', '属性·查克拉', 50],
    ['mental', '属性·当前精神力', '属性·精神力', 50],
    ['stamina', '属性·当前体力', '属性·体力', 50],
    ['vitality', '属性·当前生命力', '属性·生命力', 100],
    ['money', '进度·金钱', null, 0]
  ];
  return definitions.map(([resourceId, currentKey, maximumKey, fallback]) => {
    const maximum = maximumKey === null
      ? Math.max(1, boundedInteger(snapshot[currentKey], fallback, { max: 1_000_000 }))
      : Math.max(1, boundedInteger(snapshot[maximumKey], fallback, { max: 1_000_000 }));
    const current = boundedInteger(snapshot[currentKey], maximumKey === null ? fallback : maximum, {
      max: maximum
    });
    return { resource_id: resourceId, version: 0, current, maximum };
  });
}

function importedSkills(snapshot) {
  return parsedSkillRecords(snapshot).map(item => {
    const displayName = importedText(item['名称'], item.embedded_name, 160, 'skill.display_name');
    const canonicalRef = canonicalSkillRef(item);
    return {
      skill_id: stableImportedId('skill:', {
        category: SKILL_CATEGORY[item.label],
        display_name: displayName,
        canonical_ref: canonicalRef
      }),
      version: 1,
      display_name: displayName,
      category: SKILL_CATEGORY[item.label],
      rank: importedText(item['等级'], 'E', 40, 'skill.rank'),
      mastery: boundedInteger(item['熟练度'], 0, { max: 100 }),
      canonical_ref: canonicalRef
    };
  }).sort((left, right) => left.skill_id.localeCompare(right.skill_id));
}

function importedItems(snapshot) {
  const equippedSlots = new Map([
    [String(snapshot['物品·已装备·武器'] ?? '').trim(), 'weapon'],
    [String(snapshot['物品·已装备·防具'] ?? '').trim(), 'armor'],
    [String(snapshot['物品·已装备·饰品1'] ?? '').trim(), 'accessory'],
    [String(snapshot['物品·已装备·饰品2'] ?? '').trim(), 'tool']
  ].filter(([name]) => name));
  return parsedItemRecords(snapshot).flatMap(item => {
    const quantity = boundedInteger(item['数量'], 1, { min: 0, max: 1_000_000 });
    if (quantity < 1) return [];
    const category = ITEM_CATEGORY[item.label];
    const displayName = importedText(item.display_name, '未命名物品', 160, 'item.display_name');
    const canonicalRef = canonicalItemRef(item);
    const equippedSlot = category === 'EQUIPMENT'
      ? (equippedSlots.get(displayName) ?? null)
      : null;
    return [{
      item_id: stableImportedId('item:', { category, display_name: displayName }),
      version: 1,
      display_name: displayName,
      category,
      quantity,
      canonical_ref: canonicalRef || null,
      equipped_slot: equippedSlot
    }];
  }).sort((left, right) => left.item_id.localeCompare(right.item_id));
}

function importedActor(snapshotValue, seat, roomActorId) {
  const snapshot = record(snapshotValue, `${seat} single-player character`);
  if (!['3.0', '4.0', '5.0'].includes(snapshot._version)) {
    fail(
      'SINGLEPLAYER_GENESIS_VERSION_UNSUPPORTED',
      'single-player character snapshot version is unsupported',
      { version: snapshot._version ?? null }
    );
  }
  const alive = importedBoolean(snapshot['玩家·存活'], true);
  const displayName = importedText(
    snapshot['玩家·姓名'],
    seat === 'A' ? '来源玩家' : '客方玩家',
    80,
    `actors.${seat}.display_name`
  );
  return {
    room_actor_id: roomActorId,
    player: {
      schema: ACTOR_PROFILE_SCHEMA,
      version: 0,
      display_name: displayName,
      rank: importedText(
        selectedImportedRank(snapshot),
        '下忍',
        80,
        `actors.${seat}.rank`
      ),
      goal: importedText(
        snapshot['玩家·当前目标'],
        '在忍界中写下自己的故事',
        1_000,
        `actors.${seat}.goal`
      ),
      alive,
      status: alive ? 'ACTIVE' : 'DECEASED'
    },
    attributes: {
      schema: ACTOR_ATTRIBUTES_SCHEMA,
      resources: importedResources(snapshot),
      injuries: [],
      persistent_statuses: []
    },
    progression: {
      schema: ACTOR_PROGRESSION_SCHEMA,
      version: 0,
      experience: boundedInteger(snapshot['进度·经验'], 0),
      level: Math.max(1, boundedInteger(snapshot['进度·等级'], 1, { min: 1, max: 1_000_000 })),
      reputation: boundedInteger(snapshot['进度·声望'], 0, {
        min: -1_000_000,
        max: 1_000_000
      }),
      titles: parseDelimitedIdentities(snapshot['进度·称号'], 'title:'),
      achievements: parseDelimitedIdentities(snapshot['进度·成就'], 'achievement:')
    },
    skills: { schema: ACTOR_SKILLS_SCHEMA, entries: importedSkills(snapshot) },
    equipment: { schema: ACTOR_ITEMS_SCHEMA, entries: importedItems(snapshot) },
    missions: { schema: MISSION_COLLECTION_SCHEMA, entries: [] },
    private_knowledge: {
      seat,
      facts: [
        ['background', snapshot['玩家·出身']],
        ['personality', snapshot['玩家·个性']],
        ['private_identity', snapshot['玩家·公开身份']],
        ['chakra_nature', snapshot['玩家·查克拉属性']]
      ].flatMap(([kind, value]) => (typeof value === 'string' && value.trim()
        ? [{ kind, summary: value.trim().slice(0, 2_000) }]
        : []))
    }
  };
}

function calendarPhase(displayDate) {
  if (/夜|深夜|午夜/u.test(displayDate)) return 'NIGHT';
  if (/黄昏|傍晚|夕/u.test(displayDate)) return 'DUSK';
  if (/清晨|黎明|晨/u.test(displayDate)) return 'DAWN';
  return 'DAY';
}

function importedMissionEntries(snapshot, actorId) {
  const missions = snapshot._missions;
  if (!missions || typeof missions !== 'object' || Array.isArray(missions)) return [];
  const statusGroups = [
    ['available', 'OFFERED'],
    ['active', 'ACTIVE'],
    ['completed', 'COMPLETED'],
    ['failed', 'FAILED']
  ];
  const entries = [];
  for (const [group, status] of statusGroups) {
    const values = missions[group];
    if (!values || typeof values !== 'object' || Array.isArray(values)) continue;
    for (const [sourceId, value] of Object.entries(values)) {
      if (entries.length >= 5_000) break;
      const item = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
      const title = importedText(item.title, sourceId, 240, 'mission.title');
      const total = Math.max(1, boundedInteger(
        item.progress_total ?? item.total,
        1,
        { min: 1, max: 1_000_000 }
      ));
      entries.push({
        mission_id: stableImportedId('mission:', { group, source_id: sourceId, title }),
        version: 1,
        scope: 'actor:A',
        title,
        status,
        progress_current: boundedInteger(
          item.progress ?? item.progress_current,
          status === 'COMPLETED' ? total : 0,
          { max: total }
        ),
        progress_total: total,
        assignee_actor_ids: [actorId]
      });
    }
  }
  return entries.sort((left, right) => left.mission_id.localeCompare(right.mission_id));
}

function relationshipKind(value) {
  const role = String(value?.role ?? value?.relation ?? '').toLowerCase();
  if (/师|mentor|老师|师父/u.test(role)) return 'MENTOR';
  if (/敌|hostile|仇/u.test(role)) return 'HOSTILE';
  if (/ rival|竞争|对手/u.test(` ${role}`)) return 'RIVAL';
  const score = Math.max(
    Number(value?.affection) || 0,
    Number(value?.trust) || 0,
    Number(value?.respect) || 0
  );
  return score > 0 ? 'ALLY' : 'NEUTRAL';
}

function importedPrivateRelationships(snapshot, sourceActor) {
  const relationships = snapshot._relationships;
  const entries = [];
  if (relationships && typeof relationships === 'object' && !Array.isArray(relationships)) {
    for (const [displayNameValue, value] of Object.entries(relationships).slice(0, 2_000)) {
      const displayName = importedText(displayNameValue, '未命名人物', 160, 'npc.display_name');
      const npcId = stableImportedId('npc:', displayName);
      const alive = importedBoolean(value?.alive ?? value?.存活, true);
      const rawScore = Math.max(
        Number(value?.affection) || 0,
        Number(value?.trust) || 0,
        Number(value?.respect) || 0
      );
      entries.push({
        subject_id: npcId,
        display_name: displayName,
        known_profile: {
          faction: importedText(value?.faction ?? value?.所属, '未知', 160, 'npc.faction'),
          rank: importedText(value?.rank ?? value?.忍阶, '未知', 80, 'npc.rank'),
          observed_status: alive ? 'ACTIVE' : 'DECEASED'
        },
        directed_relationship: {
          source_actor_id: sourceActor.room_actor_id,
          kind: relationshipKind(value),
          score: Math.max(-100, Math.min(100, Math.trunc(rawScore))),
          label: importedText(
            value?.role ?? value?.info,
            '已知人物',
            160,
            'relationship.label'
          )
        }
      });
    }
  }
  return {
    schema: IMPORTED_PRIVATE_RELATIONSHIPS_SCHEMA,
    entries: entries.sort((left, right) => left.subject_id.localeCompare(right.subject_id))
  };
}

function importedWorld(state, snapshot) {
  const sourceActor = state.actors.A;
  const eventId = stableImportedId('event_', {
    codec: SINGLEPLAYER_GENESIS_CODEC,
    actor: sourceActor.room_actor_id
  });
  state.shared_world.canonical_events.entries = [{
    event_id: eventId,
    version: 1,
    status: 'RESOLVED',
    title: '单机来源节点已导入为联机起点',
    scheduled_ordinal_minutes: 0,
    resolution_summary: '服务端按版本化单机 genesis codec 重建了联机权威状态。',
    evidence_event_ids: [eventId]
  }];
  const displayDate = importedText(
    snapshot['世界·时间'] ?? snapshot['世界·年代'],
    '木叶纪元',
    160,
    'world.display_date'
  );
  state.shared_world.calendar = {
    schema: WORLD_CALENDAR_SCHEMA,
    calendar_id: 'calendar:main',
    version: 0,
    ordinal_minutes: 0,
    display_date: displayDate,
    phase: calendarPhase(displayDate)
  };
  const locationLabel = importedText(snapshot['世界·地点'], '未知地点', 160, 'world.location');
  const locationId = stableImportedId('location:', locationLabel);
  state.shared_world.world_state.locations = ['A', 'B'].map(seat => ({
    entity_id: state.actors[seat].room_actor_id,
    version: 1,
    location_id: locationId
  }));
  const weather = importedText(snapshot['世界·天气'], '未知', 80, 'world.weather');
  state.shared_world.world_state.weather = [{
    region_id: 'region:genesis',
    version: 1,
    weather_code: weather
  }];
  state.shared_world.map.markers = [{
    marker_id: stableImportedId('marker:', locationId),
    version: 1,
    location_id: locationId,
    label: locationLabel,
    visible: true
  }];
  const activeEvents = String(snapshot['世界·活跃事件'] ?? '')
    .split(/[\n，,|]/u).map(item => item.trim()).filter(Boolean).slice(0, 256);
  state.shared_world.world_state.flags = activeEvents.map(summary => ({
    flag_id: stableImportedId('flag:', summary),
    version: 1,
    enabled: true
  }));
  state.actors.A.missions.entries = importedMissionEntries(
    snapshot,
    sourceActor.room_actor_id
  );

  // Legacy single-player `_relationships` has no authenticated visibility or
  // world-public policy. Treating it as shared would expose source-only NPC
  // names, exact counts and relationship values to the guest. Preserve the
  // previously imported profile/edge fields as structured actor-A continuity;
  // a later canonical event may explicitly publish an NPC through the normal
  // relationship reducer.
  sourceActor.private_knowledge.imported_relationships =
    importedPrivateRelationships(snapshot, sourceActor);

  const memory = snapshot._memory;
  const memorySummary = memory && typeof memory === 'object' && !Array.isArray(memory)
    ? ['pins', 'facts', 'clues', 'long_term', 'archived', 'recent_summary', 'compressed_summary']
      .map(key => memory[key]).filter(value => typeof value === 'string' && value.trim())
      .join('\n').slice(0, 20_000)
    : '';
  if (memorySummary) {
    const artifactHash = `sha256:${sha256Hex(memorySummary)}`;
    state.memories['actor:A'].entries.push({
      memory_id: stableImportedId('memory:', { actor: sourceActor.room_actor_id, artifactHash }),
      source_turn_id: 'genesis:singleplayer',
      target_binding: 'actor:A',
      artifact_hash: artifactHash,
      summary: memorySummary.slice(0, 2_000),
      entries: [{ entry_id: 'entry:source_memory', summary: memorySummary }],
      supersede_entry_ids: [],
      retract_entry_ids: []
    });
  }
  const npcNotes = memory && typeof memory?.npc_notes === 'string'
    ? memory.npc_notes.trim().slice(0, 20_000)
    : '';
  if (npcNotes) {
    const artifactHash = `sha256:${sha256Hex(npcNotes)}`;
    state.memories.npc_private.entries.push({
      memory_id: stableImportedId('memory:', { partition: 'npc_private', artifactHash }),
      source_turn_id: 'genesis:singleplayer',
      target_binding: 'npc:imported',
      artifact_hash: artifactHash,
      summary: npcNotes.slice(0, 2_000),
      entries: [{ entry_id: 'entry:npc_source_memory', summary: npcNotes }],
      supersede_entry_ids: [],
      retract_entry_ids: []
    });
  }
}

function actor(seat, roomActorId, profile = {}) {
  if (profile.detailed_draft) {
    const draft = detailedOpeningDraft(profile);
    const snapshot = buildOpeningState(draft, { _version: '5.0' });
    for (const item of draft.equipment) {
      const slot = { weapon: '武器', armor: '防具', accessory1: '饰品1', accessory2: '饰品2' }[item.equippedSlot];
      if (slot) snapshot[`物品·已装备·${slot}`] = item.name;
    }
    const result = importedActor(snapshot, seat, roomActorId);
    result.private_knowledge.facts.push(...[
      ['affiliation', profile.affiliation], ['opening_hook', profile.opening_hook],
      ['identity_secret', draft.identity.secrets], ['appearance', draft.identity.appearance],
      ['body_setting', draft.identity.bodySetting], ['address', draft.identity.address],
      ['chakra_nature', draft.power.chakraNatures.join('、')]
    ].filter(([, value]) => value).map(([kind, summary]) => ({ kind, summary })));
    result.private_knowledge.imported_relationships = importedPrivateRelationships(snapshot, result);
    return result;
  }
  return {
    room_actor_id: roomActorId,
    player: {
      schema: ACTOR_PROFILE_SCHEMA,
      version: 0,
      display_name: shortText(profile.display_name, seat === 'A' ? '玩家一' : '玩家二', 80,
        `actors.${seat}.display_name`),
      rank: shortText(profile.rank, '下忍', 80, `actors.${seat}.rank`),
      goal: shortText(profile.goal, '在忍界中写下自己的故事', 1_000, `actors.${seat}.goal`),
      alive: true,
      status: 'ACTIVE'
    },
    attributes: {
      schema: ACTOR_ATTRIBUTES_SCHEMA,
      resources: resources(),
      injuries: [],
      persistent_statuses: []
    },
    progression: {
      schema: ACTOR_PROGRESSION_SCHEMA,
      version: 0,
      experience: 0,
      level: 1,
      reputation: 0,
      titles: [],
      achievements: []
    },
    skills: { schema: ACTOR_SKILLS_SCHEMA, entries: [] },
    equipment: { schema: ACTOR_ITEMS_SCHEMA, entries: [] },
    missions: { schema: MISSION_COLLECTION_SCHEMA, entries: [] },
    private_knowledge: {
      seat,
      facts: [
        {
          kind: 'affiliation',
          summary: shortText(
            profile.affiliation,
            '木叶隐村',
            160,
            `actors.${seat}.affiliation`
          )
        },
        {
          kind: 'background',
          summary: shortText(
            profile.background,
            '一名刚刚踏上忍者道路的年轻忍者。',
            2_000,
            `actors.${seat}.background`
          )
        },
        {
          kind: 'opening_hook',
          summary: shortText(
            profile.opening_hook,
            '从一个看似平常的清晨开始。',
            2_000,
            `actors.${seat}.opening_hook`
          )
        }
      ]
    }
  };
}

function genesisOpeningDraft(seat, value = {}, fallbackTime = undefined) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('GENESIS_PROFILE_INVALID', `opening_drafts.${seat} must be an object`);
  }
  const start = value.start_time ?? fallbackTime ?? {
    year: 48,
    month: 1,
    day: 1,
    phase: 'DAWN'
  };
  if (!start || typeof start !== 'object' || Array.isArray(start)
    || !Number.isSafeInteger(start.year) || start.year < 0 || start.year > 9_999
    || !Number.isSafeInteger(start.month) || start.month < 1 || start.month > 12
    || !Number.isSafeInteger(start.day) || start.day < 1 || start.day > 31
    || !['DAWN', 'DAY', 'DUSK', 'NIGHT'].includes(start.phase)) {
    fail('GENESIS_PROFILE_INVALID', `opening_drafts.${seat}.start_time is invalid`);
  }
  return canonicalizeJson({
    start_time: start,
    ...(value.detailed_draft ? { detailed_draft: detailedOpeningDraft({ ...value, start_time: start }) } : {}),
    display_name: shortText(
      value.display_name,
      seat === 'A' ? '玩家一' : '玩家二',
      80,
      `opening_drafts.${seat}.display_name`
    ),
    rank: shortText(value.rank, '下忍', 80, `opening_drafts.${seat}.rank`),
    affiliation: shortText(
      value.affiliation,
      '木叶隐村',
      160,
      `opening_drafts.${seat}.affiliation`
    ),
    background: shortText(
      value.background,
      '一名刚刚踏上忍者道路的年轻忍者。',
      2_000,
      `opening_drafts.${seat}.background`
    ),
    location: shortText(value.location, '木叶隐村', 160, `opening_drafts.${seat}.location`),
    goal: shortText(
      value.goal,
      '在忍界中写下自己的故事',
      1_000,
      `opening_drafts.${seat}.goal`
    ),
    opening_hook: shortText(
      value.opening_hook,
      '从一个看似平常的清晨开始。',
      2_000,
      `opening_drafts.${seat}.opening_hook`
    )
  });
}

export function createNewMultiplayerGenesisState({
  new_world_profile = {},
  opening_drafts = null,
  actor_ids = { A: 'actor:A', B: 'actor:B' }
} = {}) {
  if (!new_world_profile || typeof new_world_profile !== 'object'
    || Array.isArray(new_world_profile)) {
    fail('GENESIS_PROFILE_INVALID', 'new_world_profile must be an object');
  }
  const openingA = genesisOpeningDraft('A', opening_drafts?.A ?? new_world_profile.actor_a);
  const openingB = genesisOpeningDraft(
    'B',
    opening_drafts?.B ?? new_world_profile.actor_b,
    openingA.start_time
  );
  if (canonicalStringify(openingA.start_time) !== canonicalStringify(openingB.start_time)) {
    fail('GENESIS_PROFILE_INVALID', 'A and B opening times must be identical', {
      field: 'opening_drafts.start_time'
    });
  }
  const start = openingA.start_time;
  const displayDate = `木叶${start.year}年${start.month}月${start.day}日`;
  const era = shortText(new_world_profile.era, displayDate, 160, 'new_world_profile.era');
  const presetId = shortText(
    new_world_profile.preset_id,
    'preset:default',
    160,
    'new_world_profile.preset_id'
  );
  const state = {
    schema: MULTIPLAYER_ROOM_STATE_SCHEMA,
    meta: { state_revision: 0 },
    shared_world: {
      world_state: {
        schema: WORLD_STATE_SCHEMA,
        locations: [
          {
            entity_id: actor_ids.A,
            version: 1,
            location_id: stableImportedId('location:', openingA.location)
          },
          {
            entity_id: actor_ids.B,
            version: 1,
            location_id: stableImportedId('location:', openingB.location)
          }
        ],
        weather: [],
        flags: [],
        npc_profiles: []
      },
      calendar: {
        schema: WORLD_CALENDAR_SCHEMA,
        calendar_id: 'calendar:main',
        version: 0,
        ordinal_minutes: (((start.year * 12 + (start.month - 1)) * 31
          + (start.day - 1)) * 1_440)
          + ({ DAWN: 360, DAY: 720, DUSK: 1_080, NIGHT: 1_320 }[start.phase]),
        display_date: era,
        phase: start.phase
      },
      map: {
        schema: WORLD_MAP_SCHEMA,
        markers: [...new Map([
          [openingA.location, openingA],
          [openingB.location, openingB]
        ]).entries()].map(([location]) => ({
          marker_id: stableImportedId('marker:', location),
          version: 1,
          location_id: stableImportedId('location:', location),
          label: location,
          visible: true
        }))
      },
      canonical_events: { schema: EVENT_COLLECTION_SCHEMA, entries: [] },
      shared_missions: { schema: MISSION_COLLECTION_SCHEMA, entries: [] },
      shared_combat: { schema: COMBAT_COLLECTION_SCHEMA, entries: [] },
      continuity_ledger: { revision: 0 }
    },
    actors: {
      A: actor('A', actor_ids.A, openingA),
      B: actor('B', actor_ids.B, openingB)
    },
    relationships: [],
    memories: {
      canonical: { entries: [] },
      shared: { entries: [] },
      'actor:A': { entries: [] },
      'actor:B': { entries: [] },
      npc_private: { entries: [] }
    },
    agent_internal: {
      story_plan: {
        era,
        preset_id: presetId,
        openings: { A: openingA, B: openingB }
      },
      audit_state: { genesis_kind: 'new_multiplayer_save' }
    }
  };
  return assertReducerDomainState(state);
}

function assertActorIds(value) {
  const actorIds = record(value, 'actor_ids');
  for (const seat of ['A', 'B']) {
    if (typeof actorIds[seat] !== 'string'
      || !/^actor:[A-Za-z0-9:_-]+$/u.test(actorIds[seat])) {
      compatibilityConflict('actor_id');
    }
  }
  if (actorIds.A === actorIds.B) {
    compatibilityConflict('actor_id');
  }
  return actorIds;
}

export function assertInitialGenesisCompatibilityState(value) {
  const state = assertReducerDomainState(value);
  if (state.actors.A.room_actor_id === state.actors.B.room_actor_id) {
    compatibilityConflict('actor_id');
  }
  const unique = new Map();
  for (const seat of ['A', 'B']) {
    const actor = state.actors[seat];
    if (!actor.player.rank.trim()) compatibilityConflict('rank');
    for (const resource of actor.attributes.resources) {
      if (resource.current > resource.maximum) compatibilityConflict('resource');
    }
    for (const skill of actor.skills.entries) {
      if (seat === 'B') {
        const temporalCategory = temporalReferenceCategory(skill.canonical_ref);
        if (temporalCategory) compatibilityConflict(temporalCategory);
      }
      if (!isExplicitUniqueReference(skill.canonical_ref)) continue;
      const ref = skill.canonical_ref.toLowerCase();
      if (unique.has(ref)) compatibilityConflict('unique_ability');
      unique.set(ref, 'skill');
    }
    for (const item of actor.equipment.entries) {
      if (seat === 'B') {
        const temporalCategory = temporalReferenceCategory(item.canonical_ref);
        if (temporalCategory) compatibilityConflict(temporalCategory);
      }
      if (!isExplicitUniqueReference(item.canonical_ref)) continue;
      const ref = item.canonical_ref.toLowerCase();
      if (unique.has(ref)) compatibilityConflict('item');
      unique.set(ref, 'item');
    }
  }
  return state;
}

export function stableRoomGenesisActorIds(roomId) {
  if (typeof roomId !== 'string' || !/^[A-Za-z][A-Za-z0-9:_-]{1,255}$/u.test(roomId)) {
    fail('GENESIS_ACTOR_ID_INVALID', 'room_id is invalid');
  }
  return Object.freeze({
    A: stableImportedId('actor:', { room_id: roomId, seat: 'A' }),
    B: stableImportedId('actor:', { room_id: roomId, seat: 'B' })
  });
}

function guestSnapshot(value) {
  const input = record(value, 'guest_character');
  const allowed = new Set(['schema', 'state_snapshot']);
  const unknown = Object.keys(input).find(key => !allowed.has(key));
  if (unknown) {
    fail('GUEST_CHARACTER_IMPORT_INVALID', 'guest character import contains an unknown field', {
      field: unknown
    });
  }
  if (input.schema !== GUEST_CHARACTER_IMPORT_SCHEMA) {
    fail(
      'GUEST_CHARACTER_IMPORT_INVALID',
      `guest character schema must be ${GUEST_CHARACTER_IMPORT_SCHEMA}`
    );
  }
  return canonicalizeJson(record(input.state_snapshot, 'guest_character.state_snapshot'));
}

/**
 * Versioned one-way codec. `source_state` supplies the only world baseline;
 * `guest_character` contributes only actor B profile/mechanics/private
 * background. No guest missions, relationships, memories, world or meta are
 * read, and no client agent_internal field is accepted or copied.
 */
export function createExistingSaveGenesisState({
  source_state,
  guest_character = null,
  actor_ids = { A: 'actor:source_import_A', B: 'actor:guest_import_B' }
}) {
  const source = canonicalizeJson(record(source_state, 'source_state'));
  const actorIds = assertActorIds(actor_ids);
  if (!['3.0', '4.0', '5.0'].includes(source._version)) {
    fail(
      'SINGLEPLAYER_GENESIS_VERSION_UNSUPPORTED',
      'source_state must be a supported single-player state snapshot',
      { version: source._version ?? null }
    );
  }
  const sourceCompatibility = validateStrictImportSnapshot(source);
  const guest = guest_character === null ? null : guestSnapshot(guest_character);
  const guestCompatibility = guest === null
    ? Object.freeze({ unique_references: Object.freeze([]) })
    : validateStrictImportSnapshot(guest, { guest: true });
  const sourceUniqueRefs = new Map(
    sourceCompatibility.unique_references.map(entry => [entry.ref, entry.kind])
  );
  for (const entry of guestCompatibility.unique_references) {
    if (sourceUniqueRefs.has(entry.ref)) {
      compatibilityConflict(entry.kind === 'skill' ? 'unique_ability' : 'item');
    }
  }
  const state = canonicalizeJson(createNewMultiplayerGenesisState({ actor_ids: actorIds }));
  state.actors.A = importedActor(source, 'A', actorIds.A);
  if (guest !== null) {
    state.actors.B = importedActor(guest, 'B', actorIds.B);
  }
  importedWorld(state, source);
  const era = importedText(
    source['世界·年代'] ?? source['世界·时间'],
    '木叶纪元',
    160,
    'source_state.world_era'
  );
  state.meta.state_revision = 0;
  state.agent_internal = {
    story_plan: {
      era,
      preset_id: 'preset:singleplayer-import-v1'
    },
    audit_state: {
      genesis_kind: 'existing_save_derived',
      genesis_codec: SINGLEPLAYER_GENESIS_CODEC,
      guest_character_attached: guest_character !== null
    }
  };
  return assertInitialGenesisCompatibilityState(state);
}

/**
 * Backward export name retained for callers, but its authority meaning is now
 * intentionally different: it accepts a single-player snapshot and rebuilds
 * the reducer state. A client-supplied multiplayer reducer snapshot fails the
 * required single-player version check instead of carrying agent_internal in.
 */
export function normalizeImportedMultiplayerGenesisState(value, options = {}) {
  return createExistingSaveGenesisState({
    source_state: value,
    guest_character: options.guest_character ?? null,
    actor_ids: options.actor_ids
  });
}
