import { projectedAuthoritativeState } from '../multiplayer/ui-projection.js';
import { escHtml } from '../utils/format.js';

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
  chakra: '#42a5f5',
  mental: '#ce93d8',
  stamina: '#f0a33a',
  vitality: '#66bb6a'
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
        <div>
          <span class="eyebrow">玩家 ${escaped(context.seat)}</span>
          <strong>${escaped(identityName, context.seat === 'A' ? '玩家一' : '玩家二')}</strong>
          <span>${escaped(rank, '下忍')} · ${escaped(status)}</span>
        </div>
        <span class="readonly-badge">只读</span>
      </section>
      <section class="quick-grid" aria-label="角色当前信息">
        <article><span>所在位置</span><strong>${escaped(location)}</strong></article>
        <article><span>当前时间</span><strong>${escaped(timeLabel(opening, projection))}</strong></article>
        <article><span>等级</span><strong>${escaped(progression?.level, '1')}</strong></article>
        <article><span>资金</span><strong>${escaped(money?.current, '0')}</strong></article>
      </section>
      <section class="section">
        <h3>状态</h3>
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
    return `<div class="card-list">${skills.map(skill => `
      <article class="list-card">
        <div class="card-title"><strong>${escaped(itemTitle(skill, '未命名技能'))}</strong><span>${escaped(CATEGORY_LABELS[skill.category] ?? skill.category)}</span></div>
        <p>${escaped(skill.rank, '无等级')} · 熟练度 ${escaped(skill.mastery, '0')}%</p>
      </article>`).join('')}</div>`;
  }

  _renderEquipment(context) {
    const equipment = entries(context.actor?.equipment);
    if (!equipment.length) return this._emptyPartition(context, '行囊中暂无物品');
    return `<div class="card-list">${equipment.map(item => `
      <article class="list-card">
        <div class="card-title"><strong>${escaped(itemTitle(item, '未命名物品'))}</strong><span>${escaped(CATEGORY_LABELS[item.category] ?? item.category)}</span></div>
        <p>数量 ${escaped(item.quantity, '1')}${item.equipped_slot ? ` · 已装备于 ${escaped(item.equipped_slot)}` : ''}</p>
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
    return `<div class="card-list">${missions.map(mission => {
      const current = finiteNumber(mission.progress_current);
      const total = Math.max(1, finiteNumber(mission.progress_total, 1));
      const width = Math.max(0, Math.min(100, (current / total) * 100));
      return `<article class="list-card">
        <div class="card-title"><strong>${escaped(itemTitle(mission, '未命名任务'))}</strong><span>${escaped(CATEGORY_LABELS[mission.status] ?? mission.status)}</span></div>
        <p>${escaped(current)} / ${escaped(total)}</p>
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
    return `<div class="card-list">${relationships.map(edge => `
      <article class="list-card">
        <div class="card-title"><strong>${escaped(edge?.data?.target_display_name, '未知对象')}</strong><span>${escaped(edge?.data?.label, '关系')}</span></div>
        <p>关系值 ${escaped(edge?.data?.score, '0')}</p>
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
          <div><span>双人联机</span><strong>我的角色</strong></div>
          <button type="button" data-close-panel aria-label="关闭角色面板">×</button>
        </header>
        <nav class="tabs" aria-label="联机角色信息">
          ${TABS.map(tab => `<button type="button" data-tab="${tab.id}" aria-selected="${this._tab === tab.id}" class="${this._tab === tab.id ? 'active' : ''}">${tab.label}</button>`).join('')}
        </nav>
        <main class="content">${context.state ? this._renderTab(context) : '<div class="empty-state"><strong>尚未进入联机对局</strong></div>'}</main>
        <footer><span class="live-dot"></span>${escaped(syncText)}</footer>
      </div>
    `;
  }

  _styles() {
    return `
      :host{display:block;height:100%;color:var(--text-primary)}
      *{box-sizing:border-box}
      button{font:inherit}
      .panel{height:100%;display:flex;flex-direction:column;overflow:hidden;background:linear-gradient(180deg,rgba(18,20,24,.72),rgba(9,10,12,.42))}
      .header{display:flex;align-items:center;justify-content:space-between;padding:20px 18px 14px;border-bottom:1px solid var(--border-hairline)}
      .header div{display:flex;flex-direction:column;gap:3px}
      .header span{font:700 9px/1 var(--font-title);letter-spacing:3px;color:var(--c-kin-bright);text-transform:uppercase}
      .header strong{font:800 18px/1.3 var(--font-title);letter-spacing:2px}
      .header button{display:none;width:34px;height:34px;border:0;border-radius:10px;background:rgba(255,255,255,.06);color:var(--text-secondary);font-size:22px;cursor:pointer}
      .tabs{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:2px;padding:0 10px;border-bottom:1px solid var(--border-hairline)}
      .tabs button{position:relative;padding:13px 1px 11px;border:0;background:transparent;color:var(--text-tertiary);font:700 10px/1 var(--font-title);letter-spacing:1px;cursor:pointer}
      .tabs button::after{content:'';position:absolute;left:18%;right:18%;bottom:-1px;height:2px;border-radius:2px;background:transparent}
      .tabs button:hover{color:var(--text-secondary)}
      .tabs button.active{color:var(--text-primary)}
      .tabs button.active::after{background:linear-gradient(90deg,#ff512f,#f0a33a)}
      .content{flex:1;min-height:0;overflow:auto;padding:18px 16px 28px;scrollbar-width:thin;scrollbar-color:rgba(198,156,109,.4) transparent}
      .identity-card{position:relative;display:flex;justify-content:space-between;gap:12px;padding:18px;margin-bottom:12px;border:1px solid rgba(240,163,58,.22);border-radius:16px;background:linear-gradient(135deg,rgba(240,163,58,.1),rgba(255,255,255,.025));overflow:hidden}
      .identity-card::after{content:'忍';position:absolute;right:8px;bottom:-23px;font:900 76px/1 var(--font-title);color:rgba(255,255,255,.025)}
      .identity-card>div{display:flex;flex-direction:column;gap:5px;min-width:0;z-index:1}
      .identity-card .eyebrow{font:700 9px/1 var(--font-title);letter-spacing:2px;color:var(--text-tertiary)}
      .identity-card strong{font:800 25px/1.25 var(--font-title);letter-spacing:1px;color:var(--c-kin-bright);overflow-wrap:anywhere}
      .identity-card div>span:last-child{font-size:11px;color:var(--text-secondary)}
      .readonly-badge{align-self:flex-start;padding:4px 7px;border-radius:999px;background:rgba(102,187,106,.12);color:#81c784;font-size:9px;letter-spacing:1px;z-index:1}
      .quick-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:22px}
      .quick-grid article{min-width:0;padding:12px;border-radius:12px;background:rgba(255,255,255,.035);box-shadow:inset 0 0 0 1px rgba(255,255,255,.035)}
      .quick-grid span,.subtle{display:block;margin-bottom:5px;font-size:9px;letter-spacing:1px;color:var(--text-tertiary)}
      .quick-grid strong{display:block;font-size:11px;line-height:1.45;color:var(--text-primary);overflow-wrap:anywhere}
      .section{margin:0 0 22px}
      .section h3{display:flex;align-items:center;gap:9px;margin:0 0 12px;font:800 10px/1 var(--font-title);letter-spacing:2px;color:var(--text-tertiary)}
      .section h3::after{content:'';flex:1;height:1px;background:var(--border-hairline)}
      .section.compact{padding:14px;border-radius:13px;background:rgba(255,255,255,.025)}
      .section.compact h3{margin-bottom:9px}
      .section p{margin:0 0 9px;font-size:12px;line-height:1.7;color:var(--text-secondary);overflow-wrap:anywhere}
      .section p:last-child{margin-bottom:0}
      .resource-list{display:grid;gap:13px}
      .resource>div{display:flex;justify-content:space-between;gap:12px;margin-bottom:7px;font-size:10px;color:var(--text-secondary)}
      .resource strong{font-family:var(--font-mono);font-weight:600;color:var(--text-primary)}
      .resource i,.mission-progress{display:block;height:3px;border-radius:999px;background:rgba(255,255,255,.06);overflow:hidden}
      .resource b,.mission-progress b{display:block;height:100%;border-radius:inherit;box-shadow:0 0 9px currentColor}
      .card-list{display:grid;gap:9px}
      .list-card{padding:14px;border-radius:13px;background:rgba(255,255,255,.035);box-shadow:inset 0 0 0 1px rgba(255,255,255,.035)}
      .card-title{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}
      .card-title strong{font:800 13px/1.45 var(--font-title);overflow-wrap:anywhere}
      .card-title span{flex-shrink:0;padding:3px 6px;border-radius:999px;background:rgba(240,163,58,.1);color:#e6b86e;font-size:9px}
      .list-card p{margin:7px 0 0;font-size:10px;color:var(--text-tertiary)}
      .mission-progress{margin-top:10px}
      .mission-progress b{background:linear-gradient(90deg,#ff512f,#f0a33a)}
      .empty-state{min-height:210px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;text-align:center;color:var(--text-tertiary)}
      .empty-state span{width:54px;height:54px;display:grid;place-items:center;border:1px solid rgba(198,156,109,.25);border-radius:50%;font:900 22px/1 var(--font-title);color:rgba(198,156,109,.65)}
      .empty-state strong{max-width:210px;font-size:12px;font-weight:500;line-height:1.7}
      .empty,.privacy-note{font-size:11px;line-height:1.7;color:var(--text-tertiary)}
      .privacy-note{margin:14px 3px 0}
      footer{display:flex;align-items:center;justify-content:center;gap:7px;padding:10px 12px;border-top:1px solid var(--border-hairline);font-size:9px;letter-spacing:1px;color:var(--text-tertiary)}
      .live-dot{width:6px;height:6px;border-radius:50%;background:#66bb6a;box-shadow:0 0 9px rgba(102,187,106,.7)}
      @media(max-width:768px){.header button{display:grid;place-items:center}.header{padding-top:15px}.content{padding-bottom:calc(28px + env(safe-area-inset-bottom,0px))}}
      @media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important;transition:none!important}}
    `;
  }
}

if (!customElements.get('multiplayer-character-panel')) {
  customElements.define('multiplayer-character-panel', MultiplayerCharacterPanel);
}

