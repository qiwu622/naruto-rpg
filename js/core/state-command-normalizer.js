import {
  normalizeStructuredVariableUpdate,
  STRUCTURED_SCALAR_PATH_MAP
} from '../data/var-schema.js';
import { isSafePath, isSafePathKey } from '../utils/format.js';

const OP_MAP = Object.freeze({ set: '=', add: '+', sub: '-' });

const PATH_MAP = Object.freeze({
  ...STRUCTURED_SCALAR_PATH_MAP,
  // Read old secondary-updater output without advertising this whole-collection path
  // in the current structured-variable contract.
  'skills.kekkei_genkai': '技能·血继限界'
});

const SKILL_TYPE_MAP = Object.freeze({
  jutsu: '忍术',
  taijutsu: '体术',
  genjutsu: '幻术',
  support: '支援',
  talents: '天赋',
  kekkei_genkai: '血继限界'
});

const SKILL_FIELD_MAP = Object.freeze({
  name: '名称',
  rank: '等级',
  element: '属性',
  cost: '消耗',
  resource: '消耗资源',
  resource_type: '消耗资源',
  power: '威力',
  mastery: '熟练度',
  description: '描述',
  type: '类型',
  technique_id: '数据库ID',
  source: '来源'
});

const ITEM_TYPE_MAP = Object.freeze({
  weapons: '武器',
  armor: '防具',
  tools: '道具',
  consumables: '消耗品'
});

const ITEM_FIELD_MAP = Object.freeze({
  quantity: '数量',
  quality: '品质',
  description: '描述',
  name: '名称',
  type: '类型',
  power: '威力',
  cost: '消耗',
  element: '属性'
});

const SKILL_COLLECTION_CATEGORIES = Object.freeze({
  jutsu: ['忍术'],
  taijutsu: ['体术'],
  genjutsu: ['幻术'],
  support: ['支援', '辅助'],
  talents: ['天赋'],
  kekkei_genkai: ['血继限界']
});

const EQUIPPED_SLOT_MAP = Object.freeze({
  weapon: '武器',
  armor: '防具',
  accessory1: '饰品1',
  accessory2: '饰品2'
});

/**
 * Convert the two variable protocols used by the app into state commands.
 *
 * The normalizer is deliberately side-effect free. It never mutates state,
 * emits events, or decides whether a command is valid
 * against the state schema. StateManager remains the only write authority.
 */
export function normalizeStateCommands(vars) {
  if (!Array.isArray(vars) || vars.length === 0) {
    return { flatUpdates: [], commands: [], sequence: [], invalid: [] };
  }

  const flatUpdates = [];
  const commands = [];
  const sequence = [];
  const invalid = [];
  const queueCommand = command => {
    commands.push(command);
    sequence.push(command);
  };
  const queueFlatUpdate = update => {
    flatUpdates.push(update);
    sequence.push({ kind: 'flat-update', update });
  };
  const deleteFlatEntity = baseKey => queueCommand({ kind: 'delete-flat-entity', baseKey });

  for (const rawUpdate of vars) {
    if (!rawUpdate) continue;
    const update = rawUpdate.path ? normalizeStructuredVariableUpdate(rawUpdate) : rawUpdate;

    // Already in flat format.
    if (update.key && ['=', '+', '-'].includes(update.op)) {
      queueFlatUpdate(update);
      continue;
    }

    if (!update.path || !update.op) continue;
    const path = update.path;
    const op = update.op;
    const value = update.value;

    if (typeof path !== 'string') {
      invalid.push({ path, reason: 'invalid-path' });
      continue;
    }
    if (!isSafePath(path)) {
      invalid.push({ path, reason: 'forbidden-path' });
      continue;
    }
    if (update.key !== undefined && !isSafePathKey(update.key)) {
      invalid.push({ path, reason: 'forbidden-key' });
      continue;
    }

    // Collection removal protocol used by both AI prompt modes:
    // { path: 'skills.jutsu', op: 'remove', key: '技能名' }
    const skillCollectionMatch = path.match(/^skills\.(jutsu|taijutsu|genjutsu|support|talents|kekkei_genkai)$/);
    if (skillCollectionMatch && op === 'remove' && update.key) {
      for (const category of SKILL_COLLECTION_CATEGORIES[skillCollectionMatch[1]]) {
        deleteFlatEntity(`技能·${category}·${update.key}`);
      }
      continue;
    }

    const equipmentCollectionMatch = path.match(/^equipment\.(weapons|armor|tools|consumables)$/);
    if (equipmentCollectionMatch && op === 'remove' && update.key) {
      deleteFlatEntity(`物品·${ITEM_TYPE_MAP[equipmentCollectionMatch[1]]}·${update.key}`);
      continue;
    }

    // Direct path mapping for scalar fields.
    if (PATH_MAP[path]) {
      queueFlatUpdate({ key: PATH_MAP[path], op: OP_MAP[op] || '=', value });
      continue;
    }

    // Skills: skills.jutsu.火遁·豪火球 -> 技能·忍术·火遁·豪火球·*
    const skillsMatch = path.match(/^skills\.(jutsu|taijutsu|genjutsu|support|talents|kekkei_genkai)\.(.+?)(?:\.(.+))?$/);
    if (skillsMatch) {
      const type = SKILL_TYPE_MAP[skillsMatch[1]] || skillsMatch[1];
      const skillName = skillsMatch[2];
      const field = skillsMatch[3];

      if (op === 'set' && !field && value !== null && typeof value === 'object' && !Array.isArray(value)) {
        for (const [key, fieldValue] of Object.entries(value)) {
          queueFlatUpdate({
            key: `技能·${type}·${skillName}·${SKILL_FIELD_MAP[key] || key}`,
            op: '=',
            value: fieldValue
          });
        }
      } else if (op === 'set' && !field && (typeof value === 'string' || typeof value === 'number')) {
        // 字符串/数字值（如血继限界"写轮眼·二勾玉"）→ 存入描述。
        queueFlatUpdate({ key: `技能·${type}·${skillName}·描述`, op: '=', value: String(value) });
      } else if (op === 'assign' && update.key && value !== undefined) {
        queueFlatUpdate({
          key: `技能·${type}·${skillName}·${SKILL_FIELD_MAP[update.key] || update.key}`,
          op: '=',
          value
        });
      } else if (field) {
        queueFlatUpdate({
          key: `技能·${type}·${skillName}·${SKILL_FIELD_MAP[field] || field}`,
          op: OP_MAP[op] || '=',
          value
        });
      } else if (op === 'remove') {
        deleteFlatEntity(`技能·${type}·${update.key || skillName}`);
      }
      continue;
    }

    // Equipment: equipment.consumables.绷带 -> 物品·消耗品·绷带·*
    const equipmentMatch = path.match(/^equipment\.(weapons|armor|tools|consumables)\.(.+?)(?:\.(.+))?$/);
    if (equipmentMatch) {
      const type = ITEM_TYPE_MAP[equipmentMatch[1]] || equipmentMatch[1];
      const itemName = equipmentMatch[2];
      const field = equipmentMatch[3];

      if (op === 'set' && !field && value !== null && typeof value === 'object' && !Array.isArray(value)) {
        for (const [key, fieldValue] of Object.entries(value)) {
          queueFlatUpdate({
            key: `物品·${type}·${itemName}·${ITEM_FIELD_MAP[key] || key}`,
            op: '=',
            value: fieldValue
          });
        }
      } else if (field) {
        queueFlatUpdate({
          key: `物品·${type}·${itemName}·${ITEM_FIELD_MAP[field] || field}`,
          op: OP_MAP[op] || '=',
          value
        });
      } else if (op === 'remove') {
        deleteFlatEntity(`物品·${type}·${update.key || itemName}`);
      }
      continue;
    }

    // Equipped slots.
    const equippedMatch = path.match(/^equipment\.equipped\.(.+)$/);
    if (equippedMatch) {
      const slot = EQUIPPED_SLOT_MAP[equippedMatch[1]] || equippedMatch[1];
      if (op === 'remove') {
        queueCommand({ kind: 'delete-flat-key', key: `物品·已装备·${slot}` });
      } else {
        queueFlatUpdate({ key: `物品·已装备·${slot}`, op: '=', value });
      }
      continue;
    }

    // Reputation: progression.reputation.木叶隐村 -> 进度·声望·木叶隐村
    if (path === 'progression.reputation' && op === 'remove' && update.key) {
      queueCommand({ kind: 'delete-flat-key', key: `进度·声望·${update.key}` });
      continue;
    }
    const reputationMatch = path.match(/^progression\.reputation\.(.+)$/);
    if (reputationMatch) {
      queueFlatUpdate({ key: `进度·声望·${reputationMatch[1]}`, op: OP_MAP[op] || '=', value });
      continue;
    }

    // Relationship summary UI editing fallback.
    const relationshipMatch = (update.key || path).match(/^关系·(.+)·(互动摘要|好感|信任|敬畏)$/);
    if (relationshipMatch && (op === '=' || op === 'set')) {
      if (!isSafePathKey(relationshipMatch[1])) {
        invalid.push({ path, reason: 'forbidden-key' });
        continue;
      }
      queueCommand({
        kind: 'relationship-update',
        npc: relationshipMatch[1],
        field: relationshipMatch[2],
        value
      });
      queueFlatUpdate({ key: update.key || path, op: '=', value });
      continue;
    }

    // World map: world_state.map.explored_regions / known_locations.
    if (path === 'world_state.map.explored_regions') {
      queueCommand({ kind: 'map-explored-update', op, value });
      continue;
    }
    const knownLocationMatch = path === 'world_state.map.known_locations';
    if (knownLocationMatch && op === 'assign' && update.key) {
      queueCommand({ kind: 'map-location-assign', key: update.key, value });
      continue;
    }
    if (knownLocationMatch && op === 'remove' && update.key) {
      queueCommand({ kind: 'map-location-remove', key: update.key });
      continue;
    }

    // Memory updates are handled by memory-system to avoid competing writers.
    if (path.startsWith('memory.') || path === 'memory') continue;

    // Unknown paths must not create a second, non-schema state model.
    invalid.push({
      path,
      reason: path.startsWith('_') ? 'internal-path' : 'unknown-path'
    });
  }

  return { flatUpdates, commands, sequence, invalid };
}
