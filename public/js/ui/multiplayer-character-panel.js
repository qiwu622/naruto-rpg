import { projectedAuthoritativeState } from '../multiplayer/ui-projection.js';
import { escHtml } from '../utils/format.js';
import { gradeAttributes } from './grade-effects.js';
import { multiplayerCharacterStyles } from '../../css/components/multiplayer-character-panel.css.js';

const TABS = Object.freeze([
  Object.freeze({ id: 'attributes', label: '状态' }),
  Object.freeze({ id: 'skills', label: '技能' }),
  Object.freeze({ id: 'equipment', label: '装备' }),
  Object.freeze({ id: 'missions', label: '任务' }),
  Object.freeze({ id: 'relations', label: '关系' })
]);

const RESOURCE_LABELS = Object.freeze({
  chakra: '查克拉',
  mental: '精神力',
  money: '资金',
  stamina: '体力',
  vitality: '生命力'
});

const RESOURCE_COLORS = Object.freeze({
  chakra: '#78b7d9',
  mental: '#b7a3d3',
  stamina: '#d7ad73',
  vitality: '#80cba6'
});

const PHASE_LABELS = Object.freeze({
  DAWN: '黎明',
  DAY: '白昼',
  DUSK: '黄昏',
  NIGHT: '夜晚'
});

const STATUS_LABELS = Object.freeze({
  ACTIVE: '状态良好',
  INCAPACITATED: '失去行动能力',
  MISSING: '下落不明',
  DECEASED: '已死亡'
});

const CATEGORY_LABELS = Object.freeze({
  NINJUTSU: '忍术',
  TAIJUTSU: '体术',
  GENJUTSU: '幻术',
  BLOODLINE: '血继',
  OTHER: '其他',
  CONSUMABLE: '消耗品',
  EQUIPMENT: '装备',
  MATERIAL: '材料',
  KEY: '关键物品',
  OFFERED: '待接受',
  ACCEPTED: '已接受',
  ACTIVE: '进行中',
  COMPLETED: '已完成',
  FAILED: '失败',
  ABANDONED: '已放弃'
});

function entries(value) {
  return Array.isArray(value?.entries) ? value.entries : [];
}

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function displayText(value, fallback = '—') {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return fallback;
}

function escaped(value, fallback = '—') {
  return escHtml(displayText(value, fallback));
}

function timeLabel(opening, projection) {
  const calendar = projection?.shared_world?.calendar;
  if (calendar?.display_date) {
    const phase = PHASE_LABELS[calendar.phase] ?? displayText(calendar.phase, '');
    return `${displayText(calendar.display_date)}${phase ? ` · ${phase}` : ''}`;
  }
  const start = opening?.start_time;
  if (!start) return '共同时间已确认';
  return `木叶${start.year}年${start.month}月${start.day}日 · ${PHASE_LABELS[start.phase] ?? start.phase}`;
}

function actorLocation(projection, actorId, fallback) {
  const location = projection?.shared_world?.world_state?.locations?.find(item => (
    item?.entity_id === actorId
  ));
  const marker = projection?.shared_world?.map?.markers?.find(item => (
    item?.location_id === location?.location_id
  ));
  return displayText(marker?.label, displayText(fallback, '地点待确认'));
}

function itemTitle(item, fallback) {
  return displayText(
    item?.display_name ?? item?.title ?? item?.label ?? item?.name,
    fallback
  );
}

export class MultiplayerCharacterPanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._state = null;
    this._projection = null;
    this._roomId = null;
    this._tab = 'attributes';
    this.shadowRoot.addEventListener('click', event => {
      const tab = event.target.closest('[data-tab]');
      if (tab) this.openTab(tab.dataset.tab);
      if (event.target.closest('[data-close-panel]')) {
        this.dispatchEvent(new CustomEvent('panel:close', { bubbles: true, composed: true }));
      }
    });
  }

  connectedCallback() {
    this.render();
  }

  setSessionState(state) {
    const active = state?.room?.lifecycle === 'ACTIVE';
    if (!active) {
      this._state = null;
      this._projection = null;
      this._roomId = null;
      this.render();
      return;
    }
    const roomId = state.room.room_id;
    if (this._roomId !== roomId) {
      this._roomId = roomId;
      this._projection = null;
      this._tab = 'attributes';
    }
    const committedProjection = projectedAuthoritativeState(state.latestCommittedTurn ?? state.turn);
    if (committedProjection) this._projection = committedProjection;
    this._state = state;
    this.render();
  }

  openTab(tab = 'attributes') {
    if (!TABS.some(item => item.id === tab)) {
      throw new TypeError('不支持的联机角色面板分区');
    }
    this._tab = tab;
    this.render();
    return { opened: true, area: 'multiplayer-character-panel', tab };
  }

  _context() {
    const state = this._state;
    const seat = state?.room?.viewer_seat ?? this._projection?.viewer_seat ?? 'A';
    const opening = state?.room?.opening?.drafts?.[seat]?.draft ?? null;
    const actor = this._projection?.actors?.[seat] ?? null;
    return Object.freeze({
      state,
      seat,
      opening,
      actor,
      player: actor?.player ?? null,
      projection: this._projection
    });
  }

  _renderAttributes(context) {
    const { actor, opening, player, projection } = context;
    const resources = Array.isArray(actor?.attributes?.resources)
      ? actor.attributes.resources
      : [];
    const bars = resources.filter(item => item?.resource_id !== 'money');
    const money = resources.find(item => item?.resource_id === 'money');
    const progression = actor?.progression ?? null;
    const privateFacts = Array.isArray(actor?.private_knowledge?.facts)
      ? actor.private_knowledge.facts
      : [];
    const identityName = player?.display_name ?? opening?.display_name;
    const rank = player?.rank ?? opening?.rank;
    const goal = player?.goal ?? opening?.goal;
    const status = STATUS_LABELS[player?.status] ?? displayText(player?.status, '等待首回合结算');
    const location = actorLocation(projection, actor?.room_actor_id, opening?.location);
    return `
      <section class="identity-card">
        <div class="identity-topline"><span class="eyebrow">玩家 ${escaped(context.seat)}</span><span class="readonly-badge">只读档案</span></div>
        <strong class="identity-name">${escaped(identityName, context.seat === 'A' ? '玩家一' : '玩家二')}</strong>
        <div class="identity-meta"><span class="rank-badge grade-badge" ${gradeAttributes(rank, 'ninja')}>${escaped(rank, '下忍')}</span><span>${escaped(status)}</span></div>
      </section>
      <section class="quick-grid" aria-label="角色当前信息">
        <article class="wide"><span>所在位置</span><strong>${escaped(location)}</strong></article>
        <article class="wide"><span>当前时间</span><strong>${escaped(timeLabel(opening, projection))}</strong></article>
        <article><span>等级</span><strong>${escaped(progression?.level, '1')}</strong></article>
        <article><span>资金</span><strong>${escaped(money?.current, '0')}</strong></article>
      </section>
      <section class="section">
        <h3>状态资源<span>当前 / 上限</span></h3>
        ${bars.length ? `<div class="resource-list">${bars.map(item => {
          const current = finiteNumber(item.current);
          const maximum = Math.max(0, finiteNumber(item.maximum));
          const width = maximum > 0 ? Math.max(0, Math.min(100, (current / maximum) * 100)) : 0;
          const color = RESOURCE_COLORS[item.resource_id] ?? '#c69c6d';
          return `<div class="resource">
            <div><span>${escaped(RESOURCE_LABELS[item.resource_id] ?? item.resource_id)}</span><strong>${escaped(current)} / ${escaped(maximum)}</strong></div>
            <i><b style="width:${width}%;background:${color};color:${color}"></b></i>
          </div>`;
        }).join('')}</div>` : '<p class="empty">首回合结算后显示完整状态。</p>'}
      </section>
      <section class="section compact">
        <h3>当前目标</h3>
        <p>${escaped(goal, '在忍界中写下自己的故事')}</p>
      </section>
      ${opening?.background || opening?.affiliation ? `<section class="section compact">
        <h3>角色资料</h3>
        ${opening.affiliation ? `<p><span class="subtle">所属</span>${escaped(opening.affiliation)}</p>` : ''}
        ${opening.background ? `<p><span class="subtle">背景</span>${escaped(opening.background)}</p>` : ''}
      </section>` : ''}
      ${privateFacts.length ? `<section class="section compact">
        <h3>本人情报</h3>
        ${privateFacts.map(fact => `<p><span class="subtle">${escaped(fact?.kind, '记录')}</span>${escaped(fact?.summary)}</p>`).join('')}
      </section>` : ''}
    `;
  }

  _renderSkills(context) {
    const skills = entries(context.actor?.skills);
    if (!skills.length) return this._emptyPartition(context, '尚未掌握联机技能');
    return `<div class="collection-heading"><h3>已掌握技能</h3><span>${skills.length} 项</span></div><div class="card-list">${skills.map(skill => `
      <article class="list-card">
        <div class="card-title"><strong>${escaped(itemTitle(skill, '未命名技能'))}</strong><span>${escaped(CATEGORY_LABELS[skill.category] ?? skill.category)}</span></div>
        <div class="card-metrics"><span>等级 <b class="grade-badge" ${gradeAttributes(skill.rank)}>${escaped(skill.rank, '无等级')}</b></span><span>熟练度 <b>${escaped(skill.mastery, '0')}%</b></span></div>
      </article>`).join('')}</div>`;
  }

  _renderEquipment(context) {
    const equipment = entries(context.actor?.equipment);
    if (!equipment.length) return this._emptyPartition(context, '行囊中暂无物品');
    return `<div class="collection-heading"><h3>随身装备</h3><span>${equipment.length} 项</span></div><div class="card-list">${equipment.map(item => `
      <article class="list-card">
        <div class="card-title"><strong>${escaped(itemTitle(item, '未命名物品'))}</strong><span>${escaped(CATEGORY_LABELS[item.category] ?? item.category)}</span></div>
        <div class="card-metrics"><span>数量 <b>${escaped(item.quantity, '1')}</b></span>${item.equipped_slot ? `<span class="equipped-label">已装备于 ${escaped(item.equipped_slot)}</span>` : ''}</div>
      </article>`).join('')}</div>`;
  }

  _renderMissions(context) {
    const byId = new Map();
    for (const mission of [
      ...entries(context.projection?.shared_world?.shared_missions),
      ...entries(context.actor?.missions)
    ]) {
      byId.set(mission?.mission_id ?? `${byId.size}`, mission);
    }
    const missions = [...byId.values()];
    if (!missions.length) return this._emptyPartition(context, '当前没有任务');
    return `<div class="collection-heading"><h3>当前任务</h3><span>${missions.length} 项</span></div><div class="card-list">${missions.map(mission => {
      const current = finiteNumber(mission.progress_current);
      const total = Math.max(1, finiteNumber(mission.progress_total, 1));
      const width = Math.max(0, Math.min(100, (current / total) * 100));
      return `<article class="list-card">
        <div class="card-title"><strong>${escaped(itemTitle(mission, '未命名任务'))}</strong><span>${escaped(CATEGORY_LABELS[mission.status] ?? mission.status)}</span></div>
        <div class="card-metrics"><span>任务进度</span><b>${escaped(current)} / ${escaped(total)}</b></div>
        <i class="mission-progress"><b style="width:${width}%"></b></i>
      </article>`;
    }).join('')}</div>`;
  }

  _renderRelations(context) {
    const current = Array.isArray(context.projection?.relationships)
      ? context.projection.relationships
      : [];
    const knownNames = new Set(current.map(edge => edge?.data?.target_display_name));
    const imported = context.actor?.private_knowledge?.imported_relationships?.entries ?? [];
    const relationships = [...current, ...imported.filter(item => !knownNames.has(item.display_name)).map(item => ({
      data: { target_display_name: item.display_name, label: item.directed_relationship?.label,
        score: item.directed_relationship?.score }
    }))];
    if (!relationships.length) return this._emptyPartition(context, '尚无本人关系记录');
    return `<div class="collection-heading"><h3>人物关系</h3><span>${relationships.length} 位</span></div><div class="card-list">${relationships.map(edge => `
      <article class="list-card">
        <div class="card-title"><strong>${escaped(edge?.data?.target_display_name, '未知对象')}</strong><span>${escaped(edge?.data?.label, '关系')}</span></div>
        <div class="card-metrics"><span>关系值</span><b>${escaped(edge?.data?.score, '0')}</b></div>
      </article>`).join('')}</div>
      <p class="privacy-note">显示开局档案和已结算剧情中，你有权查看的关系。</p>`;
  }

  _emptyPartition(context, message) {
    const detail = context.projection
      ? message
      : '首回合尚未完成，结算后会从服务端同步到这里。';
    return `<div class="empty-state"><span aria-hidden="true">忍</span><strong>${escaped(detail)}</strong></div>`;
  }

  _renderTab(context) {
    if (this._tab === 'skills') return this._renderSkills(context);
    if (this._tab === 'equipment') return this._renderEquipment(context);
    if (this._tab === 'missions') return this._renderMissions(context);
    if (this._tab === 'relations') return this._renderRelations(context);
    return this._renderAttributes(context);
  }

  render() {
    if (!this.shadowRoot) return;
    const context = this._context();
    const revision = context.projection?.state_revision;
    const syncText = revision
      ? `服务端状态 · 修订 ${revision}`
      : '开局已确认 · 等待首次结算';
    this.shadowRoot.innerHTML = `
      <style>${this._styles()}</style>
      <div class="panel">
        <header class="header">
          <div class="header-copy"><span class="header-eyebrow"><i aria-hidden="true"></i> 双人联机</span><strong>我的角色</strong></div>
          <button type="button" data-close-panel aria-label="关闭角色面板">×</button>
        </header>
        <nav class="tabs" aria-label="联机角色信息">
          ${TABS.map(tab => `<button type="button" data-tab="${tab.id}" aria-selected="${this._tab === tab.id}" class="${this._tab === tab.id ? 'active' : ''}">${tab.label}</button>`).join('')}
        </nav>
        <main class="content">${context.state ? this._renderTab(context) : '<div class="empty-state"><strong>尚未进入联机对局</strong></div>'}</main>
        <footer><span class="live-dot ${revision ? 'is-synced' : ''}" aria-hidden="true"></span><span>${escaped(syncText)}</span></footer>
      </div>
    `;
  }

  _styles() {
    return multiplayerCharacterStyles;
  }
}

if (!customElements.get('multiplayer-character-panel')) {
  customElements.define('multiplayer-character-panel', MultiplayerCharacterPanel);
}

