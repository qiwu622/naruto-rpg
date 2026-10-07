import { stateManager } from '../core/state-manager.js';
import { eventBus } from '../core/event-bus.js';
import { getElementMultiplier } from '../utils/format.js';
import { GAME_DATA, getMasteryTier } from '../data/game-data.js';
import { COMBAT_STATES, normalizeCombatState } from '../data/instruction-contract.js';
import {
  normalizeNpcCombatStats,
  resolveTechniqueUsage
} from './npc-balance.js';

const PLAYER_RESOURCE_FIELDS = Object.freeze({
  查克拉: '属性·当前查克拉',
  精神力: '属性·当前精神力',
  体力: '属性·当前体力'
});

const ENEMY_RESOURCE_FIELDS = Object.freeze({
  查克拉: 'enemy_chakra',
  精神力: 'enemy_spirit',
  体力: 'enemy_stamina'
});

class CombatSystem {
  constructor() {
    this._combatLog = [];
  }

  processInstruction(combatData) {
    if (!combatData || typeof combatData !== 'object') {
      console.warn('[CombatSystem] Invalid combat instruction:', typeof combatData);
      return;
    }
    const normalizedState = normalizeCombatState(combatData.state);
    if (normalizedState !== combatData.state) {
      combatData = { ...combatData, state: normalizedState };
    }
    if (!COMBAT_STATES.includes(combatData.state)) {
      console.warn('[CombatSystem] Unsupported combat state:', combatData.state);
      return;
    }

    switch (combatData.state) {
      case 'start':
        this._startCombat(combatData);
        break;
      case 'round_start':
      case 'player_turn':
        this._playerTurn(combatData);
        break;
      case 'enemy_turn':
        this._enemyTurn(combatData);
        break;
      case 'in_progress':
        if (combatData.actor === 'enemy') this._enemyTurn(combatData);
        else if (combatData.actor === 'player') this._playerTurn(combatData);
        else this._updateCombatState(combatData);
        break;
      case 'victory':
      case 'defeat':
      case 'retreat':
        this._endCombat(combatData);
        break;
    }
  }

  _startCombat(data) {
    const combat = this.createCombatState(data, stateManager.get());
    stateManager.setSub('_combat', combat);
    this._syncEnemyRelationship(combat);
    eventBus.emit('combat:started', { ...data, combat });
  }

  // Build an encounter without mutating live state. Tactical previews and
  // narrative generation use this draft until the timeline transaction commits.
  createCombatState(data, snapshot = stateManager.get()) {
    const enemyName = data.enemy_name || '不明敌人';
    const relationships = snapshot._relationships || {};
    const knownCard = relationships[enemyName]?.combat_stats;
    const source = knownCard || data;
    const card = normalizeNpcCombatStats(source, null, {
      fallbackRank: data.enemy_rank || snapshot['玩家·忍阶'] || '下忍',
      difficulty: snapshot['玩家·难度']
    });
    const combat = {
      id: `battle:${snapshot._meta?.current_node_id || snapshot._meta?.active_branch || 'local'}:${snapshot['系统·回合数'] || 0}:${enemyName}`,
      rules_version: snapshot._ui?.settings?.tacticalCombat ? 'tactical-v1' : 0,
      // A model-owned NPC card is not proof that the player knows its numbers.
      enemy_known: data.enemy_known === true || ['known', 'full'].includes(data.enemy_intel)
        || relationships[enemyName]?.combat_intel === 'known',
      objective: data.objective || '击退对手',
      distance: data.distance || '中',
      state: 'initiating',
      turn: 0,
      is_active: true,
      enemy_name: enemyName,
      enemy_rank: card.忍阶,
      enemy_combat_level: card.战力等级,
      enemy_chakra: card.查克拉,
      enemy_chakra_max: card.查克拉上限,
      enemy_vitality: card.生命力,
      enemy_vitality_max: card.生命力上限,
      enemy_stamina: card.体力,
      enemy_stamina_max: card.体力上限,
      enemy_spirit: card.精神力,
      enemy_spirit_max: card.精神力上限,
      enemy_speed: card.速度,
      enemy_luck: card.幸运,
      enemy_ninjutsu: card.忍术造诣,
      enemy_taijutsu: card.体术造诣,
      enemy_genjutsu: card.幻术造诣,
      enemy_defense: this._defenseFromNpcCard(card),
      enemy_element: card.查克拉属性[0] || data.enemy_element || '无',
      enemy_jutsu: card.忍术,
      enemy_style: data.enemy_style || '均衡型',
      enemy_status: data.enemy_status || [],
      environment: data.environment || {},
      log: [],
      player_buffs: [],
      player_debuffs: [],
      enemy_buffs: [],
      enemy_debuffs: [],
      result: null
    };
    return combat;
  }

  commitTacticalRound(plan) {
    if (!plan?.nextCombat || plan.replayed) return false;
    const wasActive = this.isInCombat();
    const combat = structuredClone(plan.nextCombat);
    if (combat.result === 'defeat') combat.player_incapacitated = true;
    stateManager.setSub('_combat', combat);
    stateManager.update([...(plan.updates || []), ...(plan.inventoryUpdates || [])]);
    // Exact settled resource values may include healing. The legacy card
    // normalizer deliberately only decreases current values, so don't run it
    // over an authoritative tactical result.
    const relationships = stateManager.getSub('_relationships') || {};
    const relationship = relationships[combat.enemy_name];
    if (relationship?.combat_stats) {
      Object.assign(relationship.combat_stats, {
        生命力: combat.enemy_vitality, 查克拉: combat.enemy_chakra,
        体力: combat.enemy_stamina, 精神力: combat.enemy_spirit
      });
      stateManager.setSub('_relationships', relationships);
    }
    // Notifications are emitted by the pipeline only after durable commit.
    return { started: !wasActive, ended: !combat.is_active, combat };
  }

  _playerTurn(data) {
    const combat = stateManager.getSub('_combat');
    if (!combat || typeof combat !== 'object' || Array.isArray(combat)) {
      console.warn('[CombatSystem] _playerTurn called but _combat is not a valid object', typeof combat);
      return;
    }
    const turn = (combat.turn || 0) + 1;

    combat.state = 'player_turn';
    combat.turn = turn;

    const usage = this._resolvePlayerActionUsage(data);
    const settlement = this._settlePlayerResource(usage);
    combat.last_player_resource = usage.resource;
    combat.last_player_resource_cost = settlement.spent;
    combat.last_player_required_cost = usage.cost;
    combat.last_player_chakra_cost = usage.resource === '查克拉' ? settlement.spent : 0;
    combat.player_resource_insufficient = !settlement.succeeded;
    combat.player_chakra_insufficient = usage.resource === '查克拉' && !settlement.succeeded;

    const damageToEnemy = settlement.succeeded ? Math.max(0, Number(data.damage_to_enemy) || 0) : 0;
    if (damageToEnemy > 0) {
      combat.enemy_vitality = Math.max(0, (Number(combat.enemy_vitality) || 0) - damageToEnemy);
    } else if (settlement.succeeded && (data.enemy_vitality !== undefined || data.enemy_hp !== undefined)) {
      const reported = Math.max(0, Number(data.enemy_vitality ?? data.enemy_hp) || 0);
      combat.enemy_vitality = Math.min(Number(combat.enemy_vitality) || 0, reported);
    }

    if (data.log) {
      const entry = {
        turn,
        actor: 'player',
        action_type: data.action_type || 'attack',
        action_name: data.action_name || '攻击',
        result: settlement.succeeded ? (data.result || '') : `${usage.resource}不足，招式失败`,
        damage: damageToEnemy,
        resource: usage.resource,
        resource_cost: settlement.spent,
        required_cost: usage.cost,
        chakra_cost: combat.last_player_chakra_cost
      };
      combat.log = [...(combat.log || []), entry];
    }

    if (data.state === 'enemy_turn') {
      combat.state = 'enemy_turn';
    }

    stateManager.setSub('_combat', combat);
    this._syncEnemyRelationship(combat);
  }

  _enemyTurn(data) {
    const combat = stateManager.getSub('_combat');
    if (!combat || typeof combat !== 'object' || Array.isArray(combat) || !combat.is_active) {
      console.warn('[CombatSystem] _enemyTurn called but no valid active combat state exists', typeof combat);
      return;
    }
    combat.state = 'enemy_turn';

    const usage = this._resolveEnemyActionUsage(data, combat);
    const settlement = this._settleEnemyResource(combat, usage);
    combat.last_enemy_resource = usage.resource;
    combat.last_enemy_resource_cost = settlement.spent;
    combat.last_enemy_required_cost = usage.cost;
    combat.last_enemy_chakra_cost = usage.resource === '查克拉' ? settlement.spent : 0;
    combat.enemy_resource_insufficient = !settlement.succeeded;
    combat.enemy_chakra_insufficient = usage.resource === '查克拉' && !settlement.succeeded;

    if (settlement.succeeded && Number(data.damage_to_player) > 0) {
      const currentVitality = stateManager.get('属性·当前生命力') || 0;
      const newVitality = Math.max(0, currentVitality - Number(data.damage_to_player));
      stateManager.update([
        { key: '属性·当前生命力', op: '=', value: newVitality }
      ]);
    }

    if (data.log) {
      const entry = {
        turn: combat.turn || 0,
        actor: 'enemy',
        action_type: data.action_type || 'attack',
        action_name: data.action_name || '攻击',
        result: settlement.succeeded ? (data.result || '') : `${usage.resource}不足，招式失败`,
        damage: settlement.succeeded ? (data.damage_to_player || 0) : 0,
        resource: usage.resource,
        resource_cost: settlement.spent,
        required_cost: usage.cost,
        chakra_cost: combat.last_enemy_chakra_cost
      };
      combat.log = [...(combat.log || []), entry];
    }

    if (data.state === 'player_turn') {
      combat.state = 'player_turn';
    }

    stateManager.setSub('_combat', combat);
    this._syncEnemyRelationship(combat);
  }

  _updateCombatState(data) {
    const combat = stateManager.getSub('_combat');
    if (!combat || typeof combat !== 'object' || Array.isArray(combat)) return;
    if (data.enemy_vitality !== undefined || data.enemy_hp !== undefined) {
      const reported = Math.max(0, Number(data.enemy_vitality ?? data.enemy_hp) || 0);
      combat.enemy_vitality = Math.min(Number(combat.enemy_vitality) || 0, reported);
    }
    stateManager.setSub('_combat', combat);
    this._syncEnemyRelationship(combat);
  }

  _resolvePlayerActionUsage(data) {
    if (!data?.action_name && data?.resource_cost === undefined && data?.cost === undefined && data?.chakra_cost === undefined) return 0;
    const technique = this._findPlayerTechnique(data.action_name);
    if (technique) return resolveTechniqueUsage(technique);
    return this._resolveDeclaredActionUsage(data);
  }

  _resolveEnemyActionUsage(data, combat) {
    if (!data?.action_name && data?.resource_cost === undefined && data?.cost === undefined && data?.chakra_cost === undefined) return 0;
    const technique = this._findTechnique(combat.enemy_jutsu, data.action_name);
    if (technique) return resolveTechniqueUsage(technique);
    return this._resolveDeclaredActionUsage(data);
  }

  _resolveDeclaredActionUsage(data) {
    return resolveTechniqueUsage({
      action_name: data.action_name,
      action_rank: data.action_rank || data.rank || 'D',
      mastery: data.mastery ?? 60,
      action_type: data.action_type || '忍术',
      resource_type: data.resource_type || data.resource,
      resource_cost: data.resource_cost ?? data.cost ?? data.chakra_cost
    });
  }

  _settlePlayerResource(usage = {}) {
    const cost = Math.max(0, Number(usage.cost) || 0);
    const key = PLAYER_RESOURCE_FIELDS[usage.resource] || PLAYER_RESOURCE_FIELDS.查克拉;
    const current = Math.max(0, Number(stateManager.get(key)) || 0);
    if (current < cost) return { succeeded: false, spent: 0, current, key };
    if (cost > 0) stateManager.update([{ key, op: '=', value: current - cost }]);
    return { succeeded: true, spent: cost, current: current - cost, key };
  }

  _settleEnemyResource(combat, usage = {}) {
    const cost = Math.max(0, Number(usage.cost) || 0);
    const key = ENEMY_RESOURCE_FIELDS[usage.resource] || ENEMY_RESOURCE_FIELDS.查克拉;
    const current = Math.max(0, Number(combat[key]) || 0);
    if (current < cost) return { succeeded: false, spent: 0, current, key };
    combat[key] = current - cost;
    return { succeeded: true, spent: cost, current: combat[key], key };
  }

  _findPlayerTechnique(actionName) {
    const groups = { 忍术: {}, 体术: {}, 幻术: {}, 支援: {} };
    for (const [key, value] of Object.entries(stateManager.state)) {
      const match = key.match(/^技能·(忍术|体术|幻术|支援)·(.+)·(名称|等级|属性|消耗|消耗资源|威力|熟练度|描述|类型)$/);
      if (!match) continue;
      const [, category, name, field] = match;
      groups[category][name] ||= { 名称: name, 类型: category };
      groups[category][name][field] = value;
    }
    return this._findTechnique(Object.values(groups).flatMap(group => Object.values(group)), actionName);
  }

  _findTechnique(techniques, actionName) {
    if (!Array.isArray(techniques) || !actionName) return null;
    const target = this._normalizeActionName(actionName);
    return techniques.find(item => {
      const name = this._normalizeActionName(item?.名称 || item?.name);
      return name && (name === target || name.includes(target) || target.includes(name));
    }) || null;
  }

  _normalizeActionName(value) {
    return String(value || '').replace(/[\s·:：,，。!！?？]/g, '').replace(/之术$/u, '').trim();
  }

  _defenseFromNpcCard(card) {
    return Math.round((card.生命力上限 || 0) * 0.18 + (card.体力上限 || 0) * 0.25);
  }

  _syncEnemyRelationship(combat) {
    if (!combat?.enemy_name) return;
    const relationships = stateManager.getSub('_relationships') || {};
    const relationship = relationships[combat.enemy_name];
    if (!relationship?.combat_stats) return;
    relationship.combat_stats = normalizeNpcCombatStats({
      忍阶: combat.enemy_rank,
      查克拉: combat.enemy_chakra,
      查克拉上限: combat.enemy_chakra_max,
      生命力: combat.enemy_vitality,
      生命力上限: combat.enemy_vitality_max,
      体力: combat.enemy_stamina,
      体力上限: combat.enemy_stamina_max,
      速度: combat.enemy_speed,
      精神力: combat.enemy_spirit,
      精神力上限: combat.enemy_spirit_max,
      幸运: combat.enemy_luck,
      忍术造诣: combat.enemy_ninjutsu,
      体术造诣: combat.enemy_taijutsu,
      幻术造诣: combat.enemy_genjutsu,
      查克拉属性: combat.enemy_element,
      忍术: combat.enemy_jutsu
    }, relationship.combat_stats);
    relationships[combat.enemy_name] = relationship;
    stateManager.setSub('_relationships', relationships);
  }

  _endCombat(data) {
    const result = data.state;
    // 防御坏存档/劣质写入：_combat 可能被污染成 true 等非对象值，直接在其上写属性会抛
    // "Cannot create property 'state' on boolean 'true'"，导致战斗永远无法结算。
    const existing = stateManager.getSub('_combat');
    const combat = (existing && typeof existing === 'object' && !Array.isArray(existing)) ? existing : {};

    combat.state = 'peace';
    combat.is_active = false;
    combat.result = result;
    stateManager.setSub('_combat', combat);

    if (result === 'victory' && data.exp_reward) {
      stateManager.update([
        { key: '进度·经验', op: '+', value: data.exp_reward }
      ]);
    }

    eventBus.emit('combat:ended', { result, data, combat });
  }

  calculateDamage(attacker, defender, attack) {
    const attackType = attack.type || 'ninjutsu';
    const mastery = attack.mastery || 0;
    let basePower = attack.power || this._basePowerFromRank(attack.rank || 'D');

    if (attacker) {
      if (attackType === 'taijutsu') {
        basePower += (attacker.speed || 0) * 0.25 + (attacker.stamina || 0) * 0.16;
      } else if (attackType === 'genjutsu') {
        basePower += (attacker.spirit || 0) * 0.25 + (attacker.chakra || 0) * 0.05;
      } else {
        basePower += (attacker.chakra || 0) * 0.12 + (attacker.spirit || 0) * 0.08;
      }
    }

    const tier = getMasteryTier(mastery);
    basePower *= tier.power_multiplier;

    if (attack.element && defender.element) {
      const mult = getElementMultiplier(attack.element, defender.element);
      basePower *= mult;
    }

    const randomFactor = 0.85 + Math.random() * 0.3;
    basePower *= randomFactor;

    const defense = defender?.defense ?? defender?.enemy_defense ?? this._estimateDefense(defender);
    basePower = Math.max(1, basePower - defense * 0.45);

    return Math.round(basePower);
  }

  _basePowerFromRank(rank) {
    const table = { E: 8, D: 16, C: 34, B: 62, A: 105, S: 180 };
    return table[String(rank || 'D').toUpperCase()] || table.D;
  }

  _estimateDefense(defender = {}) {
    return Math.round(
      (defender.vitality || defender.enemy_vitality_max || 100) * 0.18
      + (defender.stamina || defender.enemy_stamina_max || 30) * 0.25
    );
  }

  getCombatState() {
    return stateManager.getSub('_combat');
  }

  isInCombat() {
    const combat = stateManager.getSub('_combat');
    return combat?.is_active === true;
  }

  getCombatLog() {
    const combat = stateManager.getSub('_combat');
    return combat?.log || [];
  }
}

export const combatSystem = new CombatSystem();
export default combatSystem;
