import { deepClone, generateId, getValueByPath, setValueByPath, isSafePath, isSafePathKey } from '../utils/format.js';
import { eventBus } from './event-bus.js';
import {
  calendarMonthFromValue,
  coerceValue,
  getDefaults,
  isKnownKey,
  isNumeric,
  resolveAlias,
  validate,
  VAR_SCHEMA
} from '../data/var-schema.js';
import { normalizeStateCommands } from './state-command-normalizer.js';
import { createContinuityLedger, migrateLegacyMemory } from './continuity-ledger.js';

const DB_NAME = 'naruto_rpg';
const DB_VERSION = 1;
const STORE_NODES = 'timeline_nodes';
const STORE_BRANCHES = 'timeline_branches';
const STORE_META = 'timeline_meta';

class StateManager {
  constructor() {
    this.state = this._buildDefaultState();
    this._listeners = new Map();
    this._db = null;
    this._levelUpNotified = false;
    this._stateVersion = 0;
    this._getCache = { version: -1, state: null };
  }

  getDefaultState() {
    return this._buildDefaultState();
  }

  _buildDefaultState() {
    const flat = getDefaults();
    return {
      ...flat,
      _version: '5.0',
      _resource_model_version: 1,
      _meta: {
        current_node_id: null,
        active_branch: 'branch_main'
      },
      _agent_memories: {},
      _opening_contract: null,
      _combat: null,
      _missions: {
        active: {}, available: {}, completed: {}, failed: {},
        log: {}, stats: { total_done: 0, d_rank: 0, c_rank: 0, b_rank: 0, a_rank: 0, s_rank: 0 }
      },
      _relationships: {},
      _image_worldbook_overlay: { schema: 'naruto.image-worldbook/v1', version: 1, entries: [] },
      _continuity: createContinuityLedger(),
      _memory: {
        pins: '', facts: '', clues: '', long_term: '', archived: '',
        recent_summary: '', turn_summaries: '', compressed_summary: '', compression_count: 0,
        important_events: '', npc_notes: '',
        meta: { updated_at: null, sources: {} }
      },
      _map: {
        known_locations: {},
        active_pins: ''
      },
      _ui: {
        theme: 'dark', timeline_visible: true, panel_tab: 'attributes',
        settings: {
          themePreset: 'konoha', fontPreset: 'system',
          fontFamily: "'Noto Sans SC','Microsoft YaHei UI','PingFang SC','Segoe UI',system-ui,sans-serif",
          fontSize: 16, lineHeight: 1.85, chatMaxWidth: 800,
          textColor: '#e8e4d9', accentColor: '#eb613f', goldColor: '#c69c6d',
          backgroundColor: '#070a0e', backgroundImage: '', backgroundOpacity: 0.72,
          aiCardStyle: 'line', paragraphIndent: false, showVariableSummary: true,
          reasoningOpen: true, musicEnabled: true, musicVolume: 45, musicLoop: true,
          musicShuffle: false, bgmList: '', favorites: '', ambientList: '',
          presetCore: true, presetNumbers: true, presetOutput: true,
          presetStyle: true, presetWorld: true, presetAdapt: true,
          tacticalCombat: false, autoArchive: true
        }
      }
    };
  }

  get(path) {
    if (!path) {
      if (this._getCache.version === this._stateVersion) {
        return deepClone(this._getCache.state);
      }
      const state = deepClone(this.state);
      this._injectCompatProps(state);
      this._getCache = { version: this._stateVersion, state };
      return deepClone(state);
    }
    let val = getValueByPath(this.state, path);
    if (val === undefined) {
      if (this._getCache.version !== this._stateVersion) {
        const compat = deepClone(this.state);
        this._injectCompatProps(compat);
        this._getCache = { version: this._stateVersion, state: compat };
      }
      val = getValueByPath(this._getCache.state, path);
    }
    return deepClone(val);
  }

  _injectCompatProps(state) {
    if (!state) return;
    
    const splitStr = (v) => {
      if (typeof v === 'string' && v.trim()) return v.split('，');
      if (Array.isArray(v)) return v;
      return [];
    };

    state.player = {
      name: state['玩家·姓名'] || '',
      age: state['玩家·年龄'] ?? 12,
      soul_age: state['玩家·灵魂年龄'] ?? 12,
      gender: state['玩家·性别'] || '',
      rank: state['玩家·忍阶'] || '忍校学生',
      official_rank: state['玩家·正式忍阶'] || '忍校学生',
      background: state['玩家·出身'] || '',
      chakra_nature: splitStr(state['玩家·查克拉属性']),
      difficulty: state['玩家·难度'] || '下忍',
      personality: splitStr(state['玩家·个性']),
      public_identity: state['玩家·公开身份'] || '忍校学生',
      current_goal: state['玩家·当前目标'] || '',
      reputation_tags: splitStr(state['玩家·声望标签']),
      alive: state['玩家·存活'] !== '否',
      death_cause: state['玩家·死因'] || ''
    };

    state.attributes = {
      chakra: state['属性·查克拉'] ?? 10,
      chakra_current: state['属性·当前查克拉'] ?? 10,
      spirit: state['属性·精神力'] ?? 10,
      spirit_current: state['属性·当前精神力'] ?? 10,
      vitality: state['属性·生命力'] ?? 100,
      vitality_current: state['属性·当前生命力'] ?? 100,
      stamina: state['属性·体力'] ?? 80,
      stamina_current: state['属性·当前体力'] ?? 80,
      speed: state['属性·速度'] ?? 5,
      luck: state['属性·幸运'] ?? 10
    };

    state.progression = {
      exp: state['进度·经验'] ?? 0,
      exp_to_next: state['进度·下一级经验'] ?? 100,
      jutsu_mastery: state['进度·忍术熟练度'] ?? 0,
      taijutsu_mastery: state['进度·体术熟练度'] ?? 0,
      genjutsu_mastery: state['进度·幻术熟练度'] ?? 0,
      defense_mastery: state['进度·防御熟练度'] ?? 0,
      missions_done: state['进度·已完成任务'] ?? 0,
      pending_breakthrough: state['进度·突破待处理'] ?? 0,
      titles: splitStr(state['进度·称号']),
      achievements: splitStr(state['进度·成就'])
    };

    state.world_state = {
      current_location: state['世界·地点'] ?? '木叶隐村',
      calendar: state['世界·时间'] ?? '木叶48年1月1日·清晨',
      timeline: state['世界·年代'] ?? '木叶48年',
      month: state['世界·月份'] ?? 1,
      weather: state['世界·天气'] ?? '晴'
    };

    const skills = { jutsu: {}, taijutsu: {}, genjutsu: {}, support: {}, kekkei_genkai: {}, talents: {} };
    for (const key of Object.keys(state)) {
      if (key.startsWith('技能·')) {
        const parts = key.split('·');
        if (parts[1] === '血继限界') {
          if (key === '技能·血继限界') {
            if (typeof state[key] === 'object' && state[key] !== null && !Array.isArray(state[key])) {
              Object.assign(skills.kekkei_genkai, state[key]);
            } else if (state[key] !== undefined && state[key] !== '') {
              skills.kekkei_genkai = state[key];
            }
            continue;
          }

          const prefix = '技能·血继限界·';
          const body = key.slice(prefix.length);
          const fields = new Map([
            ['名称', 'name'], ['等级', 'rank'], ['熟练度', 'mastery'],
            ['描述', 'description'], ['说明', 'description'], ['限制', 'limitations']
          ]);
          let bloodlineName = body;
          let targetField = null;
          for (const [field, normalized] of fields) {
            const suffix = `·${field}`;
            if (!body.endsWith(suffix)) continue;
            bloodlineName = body.slice(0, -suffix.length);
            targetField = normalized;
            break;
          }
          if (!bloodlineName) continue;
          if (typeof skills.kekkei_genkai !== 'object' || skills.kekkei_genkai === null || Array.isArray(skills.kekkei_genkai)) {
            skills.kekkei_genkai = {};
          }
          if (!skills.kekkei_genkai[bloodlineName] || typeof skills.kekkei_genkai[bloodlineName] !== 'object') {
            skills.kekkei_genkai[bloodlineName] = { name: bloodlineName };
          }
          if (!targetField) {
            if (typeof state[key] === 'object' && state[key] !== null && !Array.isArray(state[key])) {
              Object.assign(skills.kekkei_genkai[bloodlineName], state[key]);
              skills.kekkei_genkai[bloodlineName].name ||= bloodlineName;
            } else {
              skills.kekkei_genkai[bloodlineName].description = String(state[key] ?? '');
            }
          } else {
            skills.kekkei_genkai[bloodlineName][targetField] = state[key];
          }
        } else if (parts[1] === '天赋' && parts[2]) {
          const talentName = parts[2];
          if (!skills.talents[talentName]) skills.talents[talentName] = {};
          
          if (!parts[3]) {
            // Legacy root object: s['技能·天赋·暗部之姿'] = { ... }
            if (typeof state[key] === 'object' && state[key] !== null) {
              Object.assign(skills.talents[talentName], {
                name: state[key].name || talentName,
                description: state[key].description || '',
                mastery: state[key].mastery || 0,
                custom: state[key].custom || false,
                ...state[key]
              });
            } else {
              skills.talents[talentName].name = state[key];
            }
          } else {
            // Flat key: s['技能·天赋·暗部之姿·描述'] = '...'
            const field = parts[3];
            const fMap = { '名称': 'name', '描述': 'description', '熟练度': 'mastery' };
            const targetField = fMap[field] || field;
            skills.talents[talentName][targetField] = state[key];
          }
        } else {
          const typeMap = { '\u5fcd\u672f': 'jutsu', '\u4f53\u672f': 'taijutsu', '\u5e7b\u672f': 'genjutsu', '\u652f\u63f4': 'support' };
          const type = typeMap[parts[1]];
          if (type) {
            const prefix = '\u6280\u80fd\u00b7' + parts[1] + '\u00b7';
            const body = key.slice(prefix.length);
            const fields = new Map([
              ['\u540d\u79f0', 'name'], ['\u7b49\u7ea7', 'rank'], ['\u5c5e\u6027', 'element'], ['\u6d88\u8017', 'cost'],
              ['\u6d88\u8017\u8d44\u6e90', 'resource_type'], ['\u5a01\u529b', 'power'], ['\u719f\u7ec3\u5ea6', 'mastery'],
              ['\u63cf\u8ff0', 'description'], ['\u7c7b\u578b', 'type'], ['\u6570\u636e\u5e93ID', 'technique_id'], ['\u6765\u6e90', 'source']
            ]);
            let jutsuName = body;
            let targetField = null;
            for (const [field, normalized] of fields) {
              const suffix = '\u00b7' + field;
              if (!body.endsWith(suffix)) continue;
              jutsuName = body.slice(0, -suffix.length);
              targetField = normalized;
              break;
            }
            if (!skills[type][jutsuName]) skills[type][jutsuName] = {};
            if (!targetField) {
              if (typeof state[key] === 'object' && state[key] !== null) {
                Object.assign(skills[type][jutsuName], {
                  name: state[key].name || jutsuName,
                  rank: state[key].rank || 'E',
                  element: state[key].element || '',
                  cost: state[key].cost ?? 0,
                  resource_type: state[key].resource_type || state[key].resource || '',
                  power: state[key].power ?? 0,
                  mastery: state[key].mastery ?? 0,
                  description: state[key].description || '',
                  ...state[key]
                });
              } else {
                skills[type][jutsuName].name = state[key];
              }
            } else {
              skills[type][jutsuName][targetField] = state[key];
            }
          }
        }
      }
    }
    state.skills = skills;

    const equipment = { weapons: {}, armor: {}, tools: {}, consumables: {}, ryo: state['进度·金钱'] ?? 500, equipped: {} };
    for (const key of Object.keys(state)) {
      if (key.startsWith('物品·')) {
        const parts = key.split('·');
        if (parts[1] === '已装备' && parts[2]) {
          const eqMap = { '武器': 'weapon', '防具': 'armor', '饰品1': 'accessory1', '饰品2': 'accessory2' };
          const slot = eqMap[parts[2]];
          if (slot) equipment.equipped[slot] = state[key];
        } else if (parts[2]) {
          const typeMap = { '道具': 'tools', '消耗品': 'consumables', '武器': 'weapons', '防具': 'armor' };
          const type = typeMap[parts[1]];
          if (type) {
            const itemName = parts[2];
            const field = parts[3] || '数量';
            const fMap = { '数量': 'quantity', '品质': 'quality', '描述': 'description', '名称': 'name', '类型': 'type', '威力': 'power', '消耗': 'cost', '属性': 'element' };
            const targetField = fMap[field] || field;
            if (!equipment[type][itemName]) equipment[type][itemName] = {};
            equipment[type][itemName][targetField] = state[key];
          }
        }
      }
    }
    state.equipment = equipment;

    state.combat = state._combat || null;
    state.missions = this._restoreMissionsCompat(state._missions);
    state.relationships = state._relationships || {};
    state.memory = this._restoreMemoryCompat(state._memory);
  }

  _restoreMissionsCompat(mis) {
    if (!mis) return { active: [], available: [], completed: [], failed: [], log: [], stats: { total_done: 0 } };
    const arrFromObj = (obj) => obj ? Object.values(obj) : [];
    return {
      active: arrFromObj(mis.active),
      available: arrFromObj(mis.available),
      completed: arrFromObj(mis.completed),
      failed: arrFromObj(mis.failed),
      log: arrFromObj(mis.log),
      stats: mis.stats || { total_done: 0 }
    };
  }

  _restoreMemoryCompat(mem) {
    if (!mem) return { pins: '', facts: '', clues: '', long_term: '', archived: '', recent_summary: '', turn_summaries: '', compressed_summary: '', compression_count: 0, important_events: '', npc_notes: '' };
    return JSON.parse(JSON.stringify(mem));
  }

  update(vars) {
    if (!Array.isArray(vars) || vars.length === 0) return;
    const applied = [];
    const oldValues = {};

    for (const raw of vars) {
      if (!raw || !raw.key) continue;
      const v = { ...raw, key: resolveAlias(raw.key) };
      const key = v.key;

      // B-01: 拒绝原型污染路径（__proto__/prototype/constructor）
      if (key.includes('.') || key.includes('[')) {
        if (!isSafePath(key)) {
          console.warn('[StateManager] reject forbidden path:', key);
          eventBus.emit('state:invalid-write', { key, reason: 'forbidden-path' });
          continue;
        }
      } else if (!isSafePathKey(key)) {
        console.warn('[StateManager] reject forbidden key:', key);
        eventBus.emit('state:invalid-write', { key, reason: 'forbidden-key' });
        continue;
      }

      // B-05: 未知键直接拒绝（不再静默写入 state）
      if (!(key in this.state) && !isKnownKey(key) && !key.includes('.')) {
        console.warn('[StateManager] reject unknown key:', key);
        eventBus.emit('state:invalid-write', { key, reason: 'unknown-key' });
        continue;
      }

      oldValues[key] = deepClone(this.state[key]);

      const rawVal = v.value;
      const current = this.state[key];

      switch (v.op) {
        case 'del':
        case 'delete':
        case 'remove': {
          if (key.includes('.')) {
            // Not supported for deep path deletion in flat updates right now, but we can do our best
          } else {
            delete this.state[key];
          }
          applied.push(v);
          break;
        }
        case '=': {
          const coerced = coerceValue(key, rawVal);
          // B-03: 类型断言——若 schema 要求 number 但 coerce 后仍非数字，拒绝写入
          const def = VAR_SCHEMA[key];
          if (def && def.type === 'number' && typeof coerced !== 'number') {
            console.warn('[StateManager] reject non-numeric value for number key:', key, rawVal);
            eventBus.emit('state:invalid-write', { key, reason: 'type-mismatch', rawValue: rawVal });
            continue;
          }
          // B-10: 接入 validate()，拒绝违反 allowed 枚举/min/max 的写入
          // path-based 写入（如 _combat.id 等子对象路径）不走 schema 校验
          if (!key.includes('.')) {
            const validation = validate(key, coerced);
            if (!validation.valid) {
              console.warn('[StateManager] validate failed:', key, validation.reason);
              eventBus.emit('state:invalid-write', { key, reason: validation.reason, rawValue: rawVal });
              continue;
            }
          }
          if (key.includes('.')) {
            setValueByPath(this.state, key, coerced);
          } else {
            // Delete skill prefix if setting base skill key to falsy (or 0)
            if (key.startsWith('技能·') && !key.split('·')[3] && (coerced === 0 || coerced === '' || coerced === '0' || coerced === '无' || coerced === false)) {
              for (const k in this.state) {
                if (k.startsWith(key + '·') || k === key) {
                  delete this.state[k];
                }
              }
            } else {
              this.state[key] = coerced;
            }
          }
          if (key === '世界·时间') {
            const month = calendarMonthFromValue(coerced);
            if (month != null && this.state['世界·月份'] !== month) {
              oldValues['世界·月份'] = deepClone(this.state['世界·月份']);
              this.state['世界·月份'] = month;
              applied.push({ key: '世界·月份', op: '=', value: month, derivedFrom: '世界·时间' });
            }
          }
          applied.push(v);
          break;
        }
        case '+':
        case '-': {
          if (!isNumeric(key)) {
            console.warn('[StateManager] 非数字变量不支持增减:', key);
            eventBus.emit('state:invalid-write', { key, reason: 'non-numeric-operation', rawValue: rawVal });
            continue;
          }
          const delta = Number(rawVal);
          if (!Number.isFinite(delta)) {
            console.warn('[StateManager] reject non-numeric delta:', key, rawVal);
            eventBus.emit('state:invalid-write', { key, reason: 'nan-delta', rawValue: rawVal });
            continue;
          }
          const currentVal = key.includes('.') ? getValueByPath(this.state, key) : current;
          let curNum = Number(currentVal);
          // 兜底: 状态中缺失但从 schema 声明为数字,取默认值或 0
          if (isNaN(curNum) && isKnownKey(key) && key in VAR_SCHEMA && VAR_SCHEMA[key]?.type === 'number') {
            curNum = VAR_SCHEMA[key].default ?? 0;
          }
          if (isNaN(curNum)) {
            console.warn('[StateManager] 非数字变量不支持增减:', key);
            continue;
          }
          const newVal = v.op === '-' ? Math.max(0, curNum - delta) : curNum + delta;
          if (key.includes('.')) {
            setValueByPath(this.state, key, newVal);
          } else {
            this.state[key] = newVal;
          }
          applied.push(v);
          break;
        }
        default:
          console.warn('[StateManager] 未知操作:', v.op);
      }
    }

    this._enforceBounds();
    this._checkAlive();

    for (const v of applied) {
      eventBus.emit('state:changed', {
        key: v.key, value: this.state[v.key], oldValue: oldValues[v.key], batched: true
      });
    }
    this._notifySubscribers(applied);
    eventBus.emit('state:batch-changed', { updates: applied });
    this._stateVersion++;
  }

  _deleteFlatEntity(baseKey) {
    const deletedKeys = Object.keys(this.state)
      .filter(stateKey => stateKey === baseKey || stateKey.startsWith(`${baseKey}·`));
    for (const stateKey of deletedKeys) {
      delete this.state[stateKey];
      eventBus.emit('state:changed', { key: stateKey, value: undefined, deleted: true });
    }
    return deletedKeys.length;
  }

  _applyNormalizedCommand(command) {
    if (!command) return;
    if (command.kind === 'delete-flat-entity') {
      this._deleteFlatEntity(command.baseKey);
      return;
    }
    if (command.kind === 'delete-flat-key') {
      if (!(command.key in this.state)) return;
      delete this.state[command.key];
      eventBus.emit('state:changed', { key: command.key, value: undefined, deleted: true });
      return;
    }
    if (command.kind === 'relationship-update') {
      const relationships = this.state._relationships || {};
      const relationship = relationships[command.npc];
      if (!relationship) return;
      if (command.field === '互动摘要' && relationship.history && relationship.history.length > 0) {
        relationship.history[0].summary = command.value;
      } else if (command.field === '好感') {
        relationship.affection = Number(command.value) || 0;
      } else if (command.field === '信任') {
        relationship.trust = Number(command.value) || 0;
      } else if (command.field === '敬畏') {
        relationship.respect = Number(command.value) || 0;
      }
      this.state._relationships = relationships;
      eventBus.emit('state:changed', { key: '_relationships', value: relationships });
      return;
    }
    if (command.kind === 'map-explored-update') {
      const regions = value => (Array.isArray(value) ? value : [value])
        .flatMap(part => String(part ?? '').split(/[，,]/))
        .map(part => part.trim()).filter(Boolean);
      const current = command.op === 'push' ? regions(this.state['世界·已探索区域']) : [];
      const value = [...new Set([...current, ...regions(command.value)])].join('，');
      this.update([{ key: '世界·已探索区域', op: '=', value }]);
      return;
    }
    if (command.kind === 'map-location-assign') {
      const map = this.state._map || { known_locations: {}, active_pins: '' };
      if (!map.known_locations || typeof map.known_locations !== 'object' || Array.isArray(map.known_locations)) {
        map.known_locations = {};
      }
      map.known_locations[command.key] = command.value;
      this.state._map = map;
      eventBus.emit('state:changed', { key: '_map', value: map });
      return;
    }
    if (command.kind === 'map-location-remove') {
      const map = this.state._map || { known_locations: {}, active_pins: '' };
      if (map.known_locations && Object.hasOwn(map.known_locations, command.key)) {
        delete map.known_locations[command.key];
        this.state._map = map;
        eventBus.emit('state:changed', { key: '_map', value: map });
      }
      this._applyNormalizedCommand({ kind: 'delete-flat-key', key: `世界·已知地点·${command.key}` });
    }
  }

  batchUpdate(vars) {
    if (!Array.isArray(vars) || vars.length === 0) return;

    const normalized = normalizeStateCommands(vars);
    for (const { path, reason } of normalized.invalid) {
      console.warn(`[StateManager] batchUpdate: reject ${reason}:`, path);
      eventBus.emit('state:invalid-write', { key: path, reason });
    }
    let pendingUpdates = [];
    const flushUpdates = () => {
      if (pendingUpdates.length) this.update(pendingUpdates);
      pendingUpdates = [];
    };
    for (const command of normalized.sequence) {
      if (command.kind === 'flat-update') {
        pendingUpdates.push(command.update);
      } else {
        flushUpdates();
        this._applyNormalizedCommand(command);
      }
    }
    flushUpdates();
    // Path commands mutate this.state directly, so invalidate get()'s cache.
    this._stateVersion++;
  }

  getSub(key) {
    if (key in this.state) return deepClone(this.state[key]);
    return undefined;
  }

  // 注意：setSub 是"整段覆盖"语义。如果只想改子字段、保留其余，请用 mergeSub。
  setSub(key, value) {
    this.state[key] = value;
    this._stateVersion++;
    eventBus.emit('state:changed', { key, value });
  }

  // Atomically expose several internal substates before any listener runs.
  // Domain systems use this when one logical operation spans related stores
  // (for example, an NPC rename touches relationships, memories and combat).
  setSubBatch(changes) {
    if (!changes || typeof changes !== 'object' || Array.isArray(changes)) {
      throw new TypeError('setSubBatch changes 必须是对象');
    }
    const entries = Object.entries(changes);
    if (!entries.length) return;
    for (const [key] of entries) {
      if (!isSafePathKey(key) || !key.startsWith('_')) {
        throw new TypeError(`setSubBatch 拒绝非内部状态键: ${key}`);
      }
    }
    for (const [key, value] of entries) this.state[key] = value;
    this._stateVersion++;
    for (const [key, value] of entries) {
      eventBus.emit('state:changed', { key, value, batched: true });
    }
    eventBus.emit('state:sub-batch-changed', {
      keys: entries.map(([key]) => key),
      changes: Object.fromEntries(entries)
    });
  }

  // B-12: 浅 patch 顶层 sub 对象，避免多写入路径互相覆盖
  mergeSub(key, partial) {
    if (!partial || typeof partial !== 'object' || Array.isArray(partial)) {
      console.warn('[StateManager] mergeSub: partial must be an object', key);
      return;
    }
    const cur = this.state[key];
    if (!cur || typeof cur !== 'object' || Array.isArray(cur)) {
      this.state[key] = { ...partial };
    } else {
      this.state[key] = { ...cur, ...partial };
    }
    this._stateVersion++;
    eventBus.emit('state:changed', { key, value: this.state[key] });
  }

  snapshot() {
    return deepClone(this.state);
  }

  // S-02: 旧存档迁移——把 "物品·已装备·道具1/2" 迁移到 "物品·已装备·饰品1/2"
  _migrateEquipmentSlots(state) {
    if (!state || typeof state !== 'object') return state;
    const legacy = ['道具1', '道具2'];
    const target = ['饰品1', '饰品2'];
    for (let i = 0; i < legacy.length; i++) {
      const oldKey = `物品·已装备·${legacy[i]}`;
      const newKey = `物品·已装备·${target[i]}`;
      if (oldKey in state) {
        if (!state[newKey]) state[newKey] = state[oldKey];
        delete state[oldKey];
      }
    }
    return state;
  }

  _migrateV4toV5(snapshot) {
    const state = deepClone(snapshot);
    const oldVitality = state['属性·体力'];
    const oldVitalityCurrent = state['属性·当前体力'];
    const oldStamina = state['属性·意志力'];
    const oldStaminaCurrent = state['属性·当前意志力'];

    state['属性·生命力'] = oldVitality ?? 100;
    state['属性·当前生命力'] = oldVitalityCurrent ?? state['属性·生命力'];
    state['属性·体力'] = oldStamina ?? 80;
    state['属性·当前体力'] = oldStaminaCurrent ?? state['属性·体力'];
    delete state['属性·意志力'];
    delete state['属性·当前意志力'];

    const relationships = state._relationships;
    if (relationships && typeof relationships === 'object') {
      for (const relationship of Object.values(relationships)) {
        const card = relationship?.combat_stats;
        if (!card || typeof card !== 'object') continue;
        const hpMax = card.体力上限;
        const hpCurrent = card.体力;
        const staminaMax = card.意志力;
        card.生命力上限 = hpMax ?? 100;
        card.生命力 = hpCurrent ?? card.生命力上限;
        card.体力上限 = staminaMax ?? 80;
        card.体力 = staminaMax ?? card.体力上限;
        card.精神力上限 = card.精神力上限 ?? card.精神力 ?? 10;
        card.精神力 = Math.min(card.精神力 ?? card.精神力上限, card.精神力上限);
        delete card.意志力;
      }
    }

    const combat = state._combat;
    if (combat && typeof combat === 'object') {
      combat.enemy_vitality = combat.enemy_vitality ?? combat.enemy_stamina ?? 0;
      combat.enemy_vitality_max = combat.enemy_vitality_max ?? combat.enemy_stamina_max ?? combat.enemy_vitality;
      combat.enemy_stamina = combat.enemy_willpower ?? combat.enemy_stamina_resource ?? 0;
      combat.enemy_stamina_max = combat.enemy_stamina_max_resource ?? combat.enemy_stamina;
      combat.enemy_spirit_max = combat.enemy_spirit_max ?? combat.enemy_spirit ?? 0;
      delete combat.enemy_willpower;
      delete combat.enemy_stamina_resource;
      delete combat.enemy_stamina_max_resource;
    }

    const openingAttributes = state._opening_contract?.raw?.power?.attributes;
    if (openingAttributes && typeof openingAttributes === 'object' && !('vitality' in openingAttributes)) {
      const oldOpeningHp = openingAttributes.stamina;
      const oldOpeningStamina = openingAttributes.willpower;
      openingAttributes.vitality = oldOpeningHp ?? 100;
      openingAttributes.stamina = oldOpeningStamina ?? 80;
      delete openingAttributes.willpower;
    }

    state._version = '5.0';
    state._resource_model_version = 1;
    return state;
  }

  // B-06: 深合并——保留 snapshot 中存在的字段，对缺失的嵌套字段用 defaults 补齐
  // 数组/原始值/null 按 snapshot 覆盖；对象递归合并
  _deepMerge(defaults, snapshot) {
    if (snapshot === null || snapshot === undefined) return defaults;
    if (Array.isArray(snapshot)) return snapshot;
    // 存档中的非对象值不可覆盖一个有结构的默认对象（典型：_combat: true）
    if (typeof snapshot !== 'object') {
      if (defaults !== null && defaults !== undefined && typeof defaults === 'object' && !Array.isArray(defaults)) {
        console.warn('[StateManager] restore ignored non-object value for structured key');
        return defaults;
      }
      return snapshot;
    }
    if (defaults === null || defaults === undefined || typeof defaults !== 'object' || Array.isArray(defaults)) {
      return snapshot;
    }
    const result = { ...defaults };
    for (const key of Object.keys(snapshot)) {
      if (!isSafePathKey(key)) {
        throw new Error(`状态还原失败: 状态快照包含不安全键 (${key})`);
      }
      if (Object.prototype.hasOwnProperty.call(defaults, key)) {
        result[key] = this._deepMerge(defaults[key], snapshot[key]);
      } else {
        result[key] = snapshot[key];
      }
    }
    return result;
  }

  _assertSafeSnapshotStructure(snapshot) {
    const visiting = new WeakSet();
    const visited = new WeakSet();
    const stack = [{ value: snapshot, path: '$', exiting: false }];
    while (stack.length) {
      const { value, path, exiting } = stack.pop();
      if (!value || typeof value !== 'object') continue;
      if (exiting) {
        visiting.delete(value);
        visited.add(value);
        continue;
      }
      if (visited.has(value)) continue;
      if (visiting.has(value)) throw new Error(`状态还原失败: 状态快照包含循环引用 (${path})`);
      visiting.add(value);
      stack.push({ value, path, exiting: true });
      for (const key of Object.keys(value)) {
        if (!isSafePathKey(key)) {
          throw new Error(`状态还原失败: 状态快照包含不安全键 (${path}.${key})`);
        }
        const child = value[key];
        if (child && typeof child === 'object') {
          stack.push({ value: child, path: `${path}.${key}`, exiting: false });
        }
      }
    }
  }

  prepareRestore(snapshot) {
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
      throw new TypeError('状态还原失败: 快照非法');
    }
    const liveBackgroundImage = typeof this.state?._ui?.settings?.backgroundImage === 'string'
      ? this.state._ui.settings.backgroundImage
      : '';
    this._assertSafeSnapshotStructure(snapshot);
    const source = deepClone(snapshot);
    const supportedVersions = new Set(['3.0', '4.0', '5.0']);
    if (!supportedVersions.has(source._version)) {
      const version = source._version == null ? '缺失' : String(source._version);
      throw new Error(`状态还原失败: 状态快照版本不受支持 (${version})`);
    }
    let normalized;
    if (source._version === '5.0') {
      // B-06: 用深合并替代浅合并，保证 Schema 新增的嵌套字段在旧存档中也有默认值
      normalized = this._deepMerge(this._buildDefaultState(), source);
      // S-02: 装备槽位旧键名"道具1/2"迁移到"饰品1/2"
      this._migrateEquipmentSlots(normalized);
    } else {
      const v4 = source._version === '4.0' ? source : this._migrateV3toV4(source);
      normalized = this._migrateV4toV5(v4);
      normalized = this._deepMerge(this._buildDefaultState(), normalized);
    }
    // 内部结构键消毒：坏存档/劣质写入可能把 _combat 等污染成 true/字符串等标量，
    // 战斗系统随后 combat.state='peace' 会抛 "Cannot create property 'state' on boolean"。
    // 可空对象键 → 归 null；必须为对象的键 → 归默认值。放在 continuity 迁移之前，
    // 因为迁移本身要读 _memory/_meta。
    for (const key of ['_combat', '_opening_contract']) {
      if (normalized[key] !== null && (typeof normalized[key] !== 'object' || Array.isArray(normalized[key]))) {
        console.warn(`[StateManager] restore sanitized non-object ${key}:`, typeof normalized[key]);
        normalized[key] = null;
      }
    }
    const structuredDefaults = this._buildDefaultState();
    for (const key of ['_relationships', '_missions', '_memory', '_map', '_meta', '_agent_memories']) {
      if (!normalized[key] || typeof normalized[key] !== 'object' || Array.isArray(normalized[key])) {
        console.warn(`[StateManager] restore sanitized non-object ${key}:`, typeof normalized[key]);
        normalized[key] = structuredDefaults[key];
      }
    }
    normalized._continuity = migrateLegacyMemory(normalized._continuity, normalized._memory, {
      nodeId: normalized._meta?.current_node_id || 'legacy_restore',
      branchId: normalized._meta?.active_branch || 'branch_main',
      turn: Number.isInteger(normalized['系统·回合数']) ? normalized['系统·回合数'] : 0,
      gameTime: normalized['世界·时间'] || '',
      source: 'state_restore',
      recordedAt: 0
    }).ledger;
    // UI preferences are local runtime state. Timeline snapshots deliberately
    // strip data/blob-backed images, so jumping/importing a save must not wipe
    // a custom background that is already active on this device.
    if (liveBackgroundImage && normalized._ui?.settings) {
      normalized._ui.settings.backgroundImage = liveBackgroundImage;
    }
    const levelUpEvents = [];
    this._enforceBounds(normalized, { levelUpEvents, updateGuard: false });
    return { state: normalized, levelUpEvents };
  }

  commitPreparedRestore(prepared) {
    if (!prepared?.state || typeof prepared.state !== 'object' || Array.isArray(prepared.state)) {
      throw new TypeError('状态还原失败: 预处理快照非法');
    }
    this.state = prepared.state;
    this._levelUpNotified = false;
    this._stateVersion++;
    for (const detail of prepared.levelUpEvents || []) {
      eventBus.emit('attribute:level-up', detail);
    }
    eventBus.emit('state:restored', this.state);
  }

  restore(snapshot) {
    this.commitPreparedRestore(this.prepareRestore(snapshot));
  }

  _migrateV3toV4(old) {
    const base = this._buildDefaultState();
    const p = old.player || {};
    const a = old.attributes || {};
    const pr = old.progression || {};
    const w = old.world_state || {};
    const eq = old.equipment || {};
    const sk = old.skills || {};
    const rel = old.relationships || {};
    const mem = old.memory || {};
    const mis = old.missions || {};

    const mapStr = (v) => {
      if (Array.isArray(v)) return v.join('，');
      if (typeof v === 'string') return v;
      return '';
    };
    const objToLines = (arr) => {
      if (!arr || !Array.isArray(arr)) return '';
      return arr.map(x => typeof x === 'string' ? x : x?.summary || x?.content || JSON.stringify(x)).join('\n');
    };

    return {
      ...base,
      _version: '4.0',
      '玩家·姓名': p.name ?? '',
      '玩家·年龄': p.age ?? 12,
      '玩家·灵魂年龄': p.soul_age ?? 12,
      '玩家·性别': p.gender ?? '',
      '玩家·忍阶': p.rank ?? '忍校学生',
      '玩家·正式忍阶': p.official_rank ?? p.rank ?? '忍校学生',
      '玩家·战力等级': p.power_level ?? 'E级',
      '玩家·所属村': p.village ?? '木叶隐村',
      '玩家·出身': p.background ?? '',
      '玩家·查克拉属性': mapStr(p.chakra_nature),
      '玩家·难度': p.difficulty ?? '下忍',
      '玩家·个性': mapStr(p.personality),
      '玩家·公开身份': p.public_identity ?? '忍校学生',
      '玩家·当前目标': p.current_goal ?? '',
      '玩家·声望标签': mapStr(p.reputation_tags),
      '玩家·标志': mapStr(Object.keys(p.flags || {})),
      '玩家·存活': p.alive === false ? '否' : '是',
      '玩家·死因': p.death_cause ?? '',

      '属性·查克拉': a.chakra ?? 10,
      '属性·当前查克拉': a.chakra_current ?? 10,
      '属性·精神力': a.spirit ?? 10,
      '属性·当前精神力': a.spirit_current ?? 10,
      '属性·意志力': a.willpower ?? 80,
      '属性·当前意志力': a.willpower_current ?? 80,
      '属性·体力': a.stamina ?? 100,
      '属性·当前体力': a.stamina_current ?? 100,
      '属性·速度': a.speed ?? 5,
      '属性·幸运': a.luck ?? 10,

      '进度·经验': pr.exp ?? 0,
      '进度·下一级经验': pr.exp_to_next ?? 100,
      '进度·忍术熟练度': pr.jutsu_mastery ?? 0,
      '进度·体术熟练度': pr.taijutsu_mastery ?? 0,
      '进度·幻术熟练度': pr.genjutsu_mastery ?? 0,
      '进度·防御熟练度': pr.defense_mastery ?? 0,
      '进度·已完成任务': pr.missions_done ?? 0,
      '进度·突破待处理': pr.pending_breakthrough ?? 0,
      '进度·金钱': eq.ryo ?? 500,
      '进度·称号': mapStr(pr.titles),
      '进度·成就': mapStr(pr.achievements),

      '世界·地点': w.current_location ?? '木叶隐村',
      '世界·时间': w.calendar ?? '木叶48年1月1日·清晨',
      '世界·年代': w.timeline ?? '木叶48年',
      '世界·月份': w.month ?? 1,
      '世界·天气': w.weather ?? '晴',
      '世界·已探索区域': mapStr(w.map?.explored_regions),
      '世界·活跃事件': objToLines(w.active_events),

      '系统·回合数': old._meta?.turn_count ?? 0,

      _meta: {
        current_node_id: old._meta?.current_node_id ?? null,
        active_branch: old._meta?.active_branch ?? 'branch_main'
      },
      _combat: old.combat ?? null,
      _opening_contract: old.opening_contract ?? null,
      _missions: this._migrateMissions(mis),
      _relationships: rel,
      _memory: {
        pins: objToLines(mem.pins),
        facts: objToLines(mem.facts),
        clues: objToLines(mem.clues),
        long_term: objToLines(mem.long_term),
        archived: objToLines(mem.archived_facts),
        recent_summary: mem.recent_summary ?? '',
        turn_summaries: objToLines(mem.turn_summaries),
        compressed_summary: mem.compressed_summary ?? '',
        compression_count: mem.compression_count ?? 0,
        important_events: objToLines(mem.important_events),
        npc_notes: typeof mem.npc_notes === 'object' ? Object.entries(mem.npc_notes || {}).map(([k, v]) => `${k}: ${v}`).join('\n') : '',
        meta: mem.meta || { updated_at: null, sources: {} }
      },
      _map: {
        known_locations: w.map?.known_locations ?? {},
        active_pins: w.map?.active_pins ?? ''
      },
      _ui: old.ui_prefs || base._ui,
    };
  }

  _migrateMissions(mis) {
    const objFromArr = (arr) => {
      const o = {};
      if (!Array.isArray(arr)) return o;
      for (const m of arr) {
        if (m?.id) o[m.id] = m;
      }
      return o;
    };
    const logFromArr = (arr) => {
      if (!Array.isArray(arr)) return {};
      const o = {};
      arr.forEach((e, i) => { o[`log_${i}`] = e; });
      return o;
    };
    return {
      active: objFromArr(mis?.active),
      available: objFromArr(mis?.available),
      completed: objFromArr(mis?.completed),
      failed: objFromArr(mis?.failed),
      log: logFromArr(mis?.log),
      stats: mis?.stats ?? { total_done: 0, d_rank: 0, c_rank: 0, b_rank: 0, a_rank: 0, s_rank: 0 }
    };
  }

  _enforceBounds(state = this.state, { levelUpEvents = null, updateGuard = state === this.state } = {}) {
    const s = state;

    const boundedPairs = [
      ['属性·当前查克拉', '属性·查克拉'],
      ['属性·当前精神力', '属性·精神力'],
      ['属性·当前生命力', '属性·生命力'],
      ['属性·当前体力', '属性·体力']
    ];
    for (const [curKey, maxKey] of boundedPairs) {
      if (typeof s[curKey] !== 'number' || isNaN(s[curKey])) continue;
      const mx = Math.max(0, Number(s[maxKey]) || 0);
      s[curKey] = Math.max(0, Math.min(s[curKey], mx));
    }
    // Recovery ends the knockout exemption, including restored snapshots.
    if (s._combat?.player_incapacitated === true && s['属性·当前生命力'] > 0) {
      delete s._combat.player_incapacitated;
    }

    const clamp = (key, min, max) => {
      if (typeof s[key] !== 'number' || isNaN(s[key])) return;
      s[key] = Math.max(min, Math.min(max, s[key]));
    };

    // B-11: 遍历 VAR_SCHEMA，对所有 number 字段统一钳制（不再硬编码字段列表）
    for (const [key, def] of Object.entries(VAR_SCHEMA)) {
      if (def.type !== 'number') continue;
      if (typeof s[key] !== 'number' || isNaN(s[key])) continue;
      const min = def.min != null ? def.min : -Infinity;
      const max = def.max != null ? def.max : Infinity;
      s[key] = Math.max(min, Math.min(max, s[key]));
    }

    // B-04: 单回合多级升级——while 循环消化所有可升级的经验
    let levelGuard = 0;
    while (
      typeof s['进度·经验'] === 'number'
      && typeof s['进度·下一级经验'] === 'number'
      && s['进度·经验'] >= s['进度·下一级经验']
      && levelGuard < 50
    ) {
      const needed = s['进度·下一级经验'];
      s['进度·经验'] = Math.max(0, s['进度·经验'] - needed);
      s['进度·下一级经验'] = Math.max(1, Math.round(needed * 1.4));
      s['进度·突破待处理'] = (s['进度·突破待处理'] || 0) + 1;
      const detail = { exp: s['进度·经验'], needed: s['进度·下一级经验'] };
      if (Array.isArray(levelUpEvents)) levelUpEvents.push(detail);
      else eventBus.emit('attribute:level-up', detail);
      levelGuard++;
    }
    // 钳制后若 exp 小于 needed，则清除升级 guard（不再需要，但保持向后兼容）
    if (typeof s['进度·经验'] === 'number'
        && typeof s['进度·下一级经验'] === 'number'
        && s['进度·经验'] < s['进度·下一级经验']) {
      if (updateGuard) this._levelUpNotified = false;
    }

    for (const key of Object.keys(s)) {
      if (key.startsWith('物品·') && key.endsWith('·数量')) {
        clamp(key, 0, 99);
        if (s[key] > 0) continue;
        const prefix = key.slice(0, -'·数量'.length);
        for (const sibling of Object.keys(s)) {
          if (sibling === prefix || sibling === key || sibling.startsWith(`${prefix}·`)) delete s[sibling];
        }
      }
      if (key.startsWith('技能·') && key.endsWith('·熟练度')) {
        clamp(key, 0, 100);
      }
    }

    const rel = s._relationships;
    if (rel && typeof rel === 'object') {
      for (const r of Object.values(rel)) {
        if (!r || typeof r !== 'object') continue;
        if (typeof r.affection === 'number') r.affection = Math.max(-100, Math.min(100, r.affection));
        if (typeof r.trust === 'number') r.trust = Math.max(-100, Math.min(100, r.trust));
        if (typeof r.respect === 'number') r.respect = Math.max(-100, Math.min(100, r.respect));
      }
    }
  }

  _checkAlive() {
    const alive = this.state['玩家·存活'];
    const vitalityCur = this.state['属性·当前生命力'];
    const combat = this.state._combat;
    // Tactical defeat is incapacitation. Death still requires an explicit
    // narrative consequence, rather than being caused by a sparring HP bar.
    if (combat?.rules_version === 'tactical-v1' && combat.player_incapacitated === true
      && combat.result === 'defeat' && alive !== '否') return;
    if (alive !== '否' && typeof vitalityCur === 'number' && vitalityCur <= 0) {
      this.state['玩家·存活'] = '否';
      this.state['玩家·死因'] = this.state['玩家·死因'] || '生命力归零';
      console.warn('[StateManager] 玩家死亡:', this.state['玩家·死因']);
      eventBus.emit('player:died', { cause: this.state['玩家·死因'] });
    }
  }

  reset() {
    this.state = this._buildDefaultState();
    this._levelUpNotified = false;
    this._stateVersion++;
    eventBus.emit('state:reset', this.state);
  }

  resetLevelUpGuard() {
    this._levelUpNotified = false;
  }

  subscribe(key, callback) {
    const k = typeof key === 'string' ? key : '*';
    if (!this._listeners.has(k)) this._listeners.set(k, new Set());
    this._listeners.get(k).add(callback);
    return () => { this._listeners.get(k)?.delete(callback); };
  }

  _notifySubscribers(applied) {
    for (const v of applied) {
      const listeners = this._listeners.get(v.key);
      if (listeners) {
        for (const cb of listeners) {
          try { cb(this.state[v.key]); } catch (e) { console.warn('[StateManager] 监听器错误:', e.message); }
        }
      }
      const wildcards = this._listeners.get('*');
      if (wildcards) {
        for (const cb of wildcards) {
          try { cb(v.key, this.state[v.key]); } catch (e) { console.warn('[StateManager] 通配监听器错误:', e.message); }
        }
      }
    }
  }

  async initDB() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE_NODES)) {
          const nodesStore = db.createObjectStore(STORE_NODES, { keyPath: 'id' });
          nodesStore.createIndex('parent_id', 'parent_id', { unique: false });
          nodesStore.createIndex('branch_id', 'branch_id', { unique: false });
          nodesStore.createIndex('turn_number', 'turn_number', { unique: false });
          nodesStore.createIndex('real_timestamp', 'real_timestamp', { unique: false });
        }
        if (!db.objectStoreNames.contains(STORE_BRANCHES)) {
          const branchesStore = db.createObjectStore(STORE_BRANCHES, { keyPath: 'id' });
          branchesStore.createIndex('is_active', 'is_active', { unique: false });
        }
        if (!db.objectStoreNames.contains(STORE_META)) {
          db.createObjectStore(STORE_META, { keyPath: 'key' });
        }
      };
      request.onsuccess = (e) => { this._db = e.target.result; resolve(this._db); };
      request.onerror = (e) => reject(e.target.error);
    });
  }

  async dbPut(storeName, data) {
    if (!this._db) await this.initDB();
    return new Promise((resolve, reject) => {
      const tx = this._db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      const request = store.put(data);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async dbGet(storeName, key) {
    if (!this._db) await this.initDB();
    return new Promise((resolve, reject) => {
      const tx = this._db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const request = store.get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async dbGetAll(storeName, query) {
    if (!this._db) await this.initDB();
    return new Promise((resolve, reject) => {
      const tx = this._db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const request = query ? store.getAll(query) : store.getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async dbDelete(storeName, key) {
    if (!this._db) await this.initDB();
    return new Promise((resolve, reject) => {
      const tx = this._db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      const request = store.delete(key);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  async dbClear(storeName) {
    if (!this._db) await this.initDB();
    return new Promise((resolve, reject) => {
      const tx = this._db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      const request = store.clear();
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  async dbReplaceTimeline({ nodes, branches, meta }) {
    if (!this._db) await this.initDB();
    return new Promise((resolve, reject) => {
      const tx = this._db.transaction([STORE_NODES, STORE_BRANCHES, STORE_META], 'readwrite');
      let settled = false;
      const fail = () => {
        if (settled) return;
        settled = true;
        reject(tx.error || new Error('时间线事务写入失败'));
      };
      tx.oncomplete = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      tx.onerror = fail;
      tx.onabort = fail;

      try {
        const nodeStore = tx.objectStore(STORE_NODES);
        const branchStore = tx.objectStore(STORE_BRANCHES);
        const metaStore = tx.objectStore(STORE_META);
        nodeStore.clear();
        branchStore.clear();
        metaStore.clear();
        for (const node of nodes) nodeStore.put(node);
        for (const branch of branches) branchStore.put(branch);
        if (meta) metaStore.put(meta);
      } catch (error) {
        try { tx.abort(); } catch { /* transaction may already be inactive */ }
        if (!settled) {
          settled = true;
          reject(error);
        }
      }
    });
  }

  async dbCommitTimeline({ nodes = [], branches = [], meta = null }) {
    if (!this._db) await this.initDB();
    return new Promise((resolve, reject) => {
      const tx = this._db.transaction([STORE_NODES, STORE_BRANCHES, STORE_META], 'readwrite');
      let settled = false;
      const fail = () => {
        if (settled) return;
        settled = true;
        reject(tx.error || new Error('时间线事务写入失败'));
      };
      tx.oncomplete = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      tx.onerror = fail;
      tx.onabort = fail;

      try {
        const nodeStore = tx.objectStore(STORE_NODES);
        const branchStore = tx.objectStore(STORE_BRANCHES);
        const metaStore = tx.objectStore(STORE_META);
        for (const node of nodes) nodeStore.put(node);
        for (const branch of branches) branchStore.put(branch);
        if (meta) metaStore.put(meta);
      } catch (error) {
        try { tx.abort(); } catch { /* transaction may already be inactive */ }
        if (!settled) {
          settled = true;
          reject(error);
        }
      }
    });
  }

  async dbMutateTimeline(mutator, { nodeKeys = null, branchKeys = null, validateCurrent = null } = {}) {
    if (typeof mutator !== 'function') throw new TypeError('时间线事务需要同步变更函数');
    if (!this._db) await this.initDB();
    return new Promise((resolve, reject) => {
      const tx = this._db.transaction([STORE_NODES, STORE_BRANCHES, STORE_META], 'readwrite');
      const nodeStore = tx.objectStore(STORE_NODES);
      const branchStore = tx.objectStore(STORE_BRANCHES);
      const metaStore = tx.objectStore(STORE_META);
      let settled = false;
      let mutationError = null;
      let mutationResult;
      let pendingReads = 0;
      let stopGuard = () => {};

      const fail = () => {
        if (settled) return;
        settled = true;
        stopGuard();
        reject(mutationError || tx.error || new Error('时间线事务写入失败'));
      };
      const abortWith = error => {
        if (mutationError) return;
        mutationError = error instanceof Error ? error : new Error(String(error));
        try { tx.abort(); } catch { fail(); }
      };

      tx.oncomplete = () => {
        if (settled) return;
        settled = true;
        stopGuard();
        resolve(mutationResult);
      };
      tx.onerror = fail;
      tx.onabort = fail;
      if (typeof validateCurrent === 'function') {
        const check = () => {
          try { validateCurrent(); } catch (error) { abortWith(error); }
        };
        const guards = ['state:changed', 'state:restored', 'state:reset', 'timeline:jumped', 'timeline:branch-switched']
          .map(event => eventBus.on(event, check));
        stopGuard = () => guards.forEach(stop => stop());
        check();
      }

      let nodes = [];
      let branches = [];
      let meta = null;
      const applyMutation = () => {
        if (mutationError) return;
        try {
          validateCurrent?.();
          const mutation = mutator({
            nodes: nodes.filter(Boolean),
            branches: branches.filter(Boolean),
            meta
          });
          if (mutationError) return;
          if (mutation && typeof mutation.then === 'function') {
            throw new TypeError('时间线事务变更函数不能是异步函数');
          }
          if (!mutation || typeof mutation !== 'object') {
            throw new TypeError('时间线事务变更函数必须返回变更对象');
          }

          if (mutation.replace === true) {
            nodeStore.clear();
            branchStore.clear();
            metaStore.clear();
          }
          for (const id of mutation.deleteNodeIds || []) nodeStore.delete(id);
          for (const id of mutation.deleteBranchIds || []) branchStore.delete(id);
          for (const key of mutation.deleteMetaKeys || []) metaStore.delete(key);
          for (const node of mutation.nodes || []) nodeStore.put(node);
          for (const branch of mutation.branches || []) branchStore.put(branch);
          if (mutation.meta) metaStore.put(mutation.meta);
          mutationResult = mutation.result;
        } catch (error) {
          abortWith(error);
        }
      };

      try {
        const reads = [];
        if (Array.isArray(nodeKeys)) {
          const nodeResults = new Array(nodeKeys.length);
          nodeKeys.forEach((key, index) => {
            const request = nodeStore.get(key);
            reads.push({ request, accept: result => { nodeResults[index] = result; } });
          });
          nodes = nodeResults;
        } else {
          const request = nodeStore.getAll();
          reads.push({ request, accept: result => { nodes = result || []; } });
        }
        if (Array.isArray(branchKeys)) {
          const branchResults = new Array(branchKeys.length);
          branchKeys.forEach((key, index) => {
            const request = branchStore.get(key);
            reads.push({ request, accept: result => { branchResults[index] = result; } });
          });
          branches = branchResults;
        } else {
          const request = branchStore.getAll();
          reads.push({ request, accept: result => { branches = result || []; } });
        }
        const metaRequest = metaStore.get('root');
        reads.push({ request: metaRequest, accept: result => { meta = result || null; } });

        pendingReads = reads.length;
        for (const { request, accept } of reads) {
          request.onsuccess = () => {
            accept(request.result);
            pendingReads--;
            if (pendingReads === 0) applyMutation();
          };
          request.onerror = () => abortWith(request.error || new Error('时间线事务读取失败'));
        }
      } catch (error) {
        abortWith(error);
      }
    });
  }

  // B-14: localStorage 配额超限时降级到 IndexedDB
  _handleLocalStorageSet(key, value) {
    try {
      localStorage.setItem(key, value);
      return true;
    } catch (e) {
      if (e.name === 'QuotaExceededError' || e.message?.includes('quota')) {
        console.warn(`[StateManager] localStorage quota exceeded for ${key}, falling back to IndexedDB`);
        return false;
      }
      console.warn(`[StateManager] localStorage setItem failed for ${key}:`, e.message);
      return false;
    }

  }

  getDisplayConfig() {
    try {
      const saved = localStorage.getItem('naruto_rpg_display_config');
      if (saved) return JSON.parse(saved);
    } catch(e) {
      console.warn('[StateManager] Failed to parse display config:', e);
    }
    return { dialogueColor: '#bae6fd', thoughtColor: '#c4b5fd' };
  }

  saveDisplayConfig(config) {
    if (!config || typeof config !== 'object') return;
    try {
      localStorage.setItem('naruto_rpg_display_config', JSON.stringify(config));
    } catch(e) {
      console.warn('[StateManager] Failed to save display config:', e);
    }
  }

  async saveAPIConfig(config) {
    if (!config || typeof config !== 'object') {
      console.warn('[StateManager] Invalid API config, not saving');
      return;
    }

    const persistedConfig = { ...config };
    delete persistedConfig.futurePlanner;

    // HTTP 后端强制走同源代理；酒馆通过 iframe 桥接，不能误送进 HTTP 代理。
    persistedConfig.useProxy = persistedConfig.backend !== 'tavern';
    
    // Update in-memory cache with plain config
    this._apiConfigCache = { ...persistedConfig };

    try {
      const { saveApiConfigSecure } = await import('../utils/api-crypto.js');
      await saveApiConfigSecure(persistedConfig);
    } catch (e) {
      console.warn('[StateManager] Encrypted API save failed, fallback to plain:', e.message);
      const safeConfig = {
        apiUrl: String(persistedConfig.apiUrl || ''),
        apiKey: String(persistedConfig.apiKey || ''),
        model: String(persistedConfig.model || ''),
        backend: String(persistedConfig.backend || 'openai'),
        disableStreaming: Boolean(persistedConfig.disableStreaming),
        adaptationMode: persistedConfig.adaptationMode,
        deepseekThinking: persistedConfig.deepseekThinking,
        promptPreset: persistedConfig.promptPreset,
        variableUpdater: persistedConfig.variableUpdater,
        narrativeReview: persistedConfig.narrativeReview,
        aiCallPolicy: persistedConfig.aiCallPolicy,
        useProxy: persistedConfig.backend !== 'tavern',
      };
      this._handleLocalStorageSet('naruto_api_config', JSON.stringify(safeConfig));
    }
  }

  getAPIConfig() {
    if (this._apiConfigCache) return this._apiConfigCache;
    
    try {
      const local = localStorage.getItem('naruto_api_config');
      if (!local) return null;
      const parsed = JSON.parse(local);
      if (!parsed || typeof parsed !== 'object') return null;
      delete parsed.futurePlanner;
      // 老配置迁移：HTTP 后端强制走代理，酒馆始终走 iframe 桥接。
      if (parsed.backend === 'tavern') {
        parsed.useProxy = false;
      } else if (parsed.apiKey && parsed.useProxy !== false) {
        parsed.useProxy = true;
      }
      return parsed;
    } catch (e) {
      console.warn('[StateManager] API config parse error:', e.message);
      return null;
    }
  }

  async getAPIConfigAsync() {
    try {
      const { loadApiConfigSecure } = await import('../utils/api-crypto.js');
      const secure = await loadApiConfigSecure();
      if (secure) {
        delete secure.futurePlanner;
        this._apiConfigCache = secure;
        return secure;
      }
    } catch (e) {
      console.warn('[StateManager] Encrypted API load failed:', e.message);
    }
    // Fallback to plain localStorage
    const local = this.getAPIConfig();
    if (local) {
      this._apiConfigCache = local;
      return local;
    }
    try {
      const meta = await this.dbGet(STORE_META, 'naruto_api_config');
      if (meta?.value) {
        const parsed = JSON.parse(meta.value);
        delete parsed.futurePlanner;
        parsed.useProxy = parsed.backend === 'tavern' ? false : Boolean(parsed.apiKey);
        return parsed;
      }
    } catch { }
    return null;
  }

  async loadUIPrefs() {
    try {
      let saved = null;
      try {
        const raw = localStorage.getItem('naruto_ui_prefs');
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === 'object') saved = parsed;
        }
      } catch (e) {
        console.warn('[StateManager] UI prefs parse error:', e.message);
      }
      // B-14: IndexedDB 降级读取
      if (!saved) {
        try {
          const meta = await this.dbGet(STORE_META, 'naruto_ui_prefs');
          if (meta?.value && typeof meta.value === 'string') {
            const parsed = JSON.parse(meta.value);
            if (parsed && typeof parsed === 'object') saved = parsed;
          }
        } catch (e) {
          console.warn('[StateManager] UI prefs DB read error:', e.message);
        }
      }
      if (!saved) return;
      this.state._ui = { ...this._buildDefaultState()._ui, ...saved };
      eventBus.emit('state:changed', { key: '_ui', value: this.state._ui });

      const settings = this.state._ui?.settings;
      if (!settings?.backgroundImage) {
        const legacyBg = localStorage.getItem('naruto_bg_image');
        if (legacyBg) {
          try {
            const decoded = JSON.parse(legacyBg);
            if (decoded && typeof decoded === 'string' && decoded.startsWith('data:image/') && settings) {
              settings.backgroundImage = decoded;
              await this.dbPut(STORE_META, { key: 'naruto_bg_image', value: decoded });
              localStorage.removeItem('naruto_bg_image');
            }
          } catch (e) {
            console.warn('[StateManager] Legacy bg parse error:', e.message);
          }
        } else {
          try {
            const meta = await this.dbGet(STORE_META, 'naruto_bg_image');
            if (meta?.value && settings) settings.backgroundImage = meta.value;
          } catch { }
        }
      }
    } catch (e) { console.warn('[StateManager] UI偏好加载失败:', e.message); }
  }

  async saveUIPrefs() {
    try {
      const ui = this.state._ui || {};
      const bg = ui.settings?.backgroundImage;
      if (bg && bg.length > 50000) {
        const smallJson = JSON.stringify({ ...ui, settings: { ...ui.settings, backgroundImage: '' } });
        this._handleLocalStorageSet('naruto_ui_prefs', smallJson);
        await this.dbPut(STORE_META, { key: 'naruto_bg_image', value: bg });
      } else {
        const json = JSON.stringify(ui);
        const ok = this._handleLocalStorageSet('naruto_ui_prefs', json);
        if (!ok) {
          await this.dbPut(STORE_META, { key: 'naruto_ui_prefs', value: json });
        }
        await this.dbPut(STORE_META, { key: 'naruto_bg_image', value: null });
      }
    } catch (e) { console.warn('[StateManager] UI偏好保存失败:', e.message); }
  }

  async saveLargeUIPrefs() { await this.saveUIPrefs(); }

  getDB() { return this._db; }
}

export const stateManager = new StateManager();
export default stateManager;
