import { stateManager } from '../core/state-manager.js';
import { eventBus } from '../core/event-bus.js';
import { formatPercentage, escHtml, escAttr } from '../utils/format.js';
import { equipmentSystem } from '../systems/equipment-system.js';
import { skillSystem } from '../systems/skill-system.js';
import { relationshipSystem } from '../systems/relationship-system.js';
import { CUSTOM_TALENT_PLACEHOLDER, parseCustomTalentDescription } from '../systems/opening-draft.js';
import { CANON_DATABASE } from '../data/canon-database.js';
import {
  calculateCombatAssessment,
  combatAttributesFromPlayerState,
  combatMasteriesFromPlayerState,
  combatAttributesFromNpcCard,
  combatMasteriesFromNpcCard
} from '../systems/combat-level.js';
import GameModal from './modal.js';
import { panelStyles, gradeEffectStyles } from '../../css/components/panel.css.js';
import { imageStudio } from '../core/image-studio/index.js';
import { mountPortraitImageControls } from './image-studio.js';

import { gradeAttributes } from './grade-effects.js';

const NPC_DOSSIER_ICONS = {
  chakra: `<svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm-1-13h2v6h-2zm0 8h2v2h-2z"/></svg>`,
  vitality: `<svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>`,
  speed: `<svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>`,
  spirit: `<svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none"><circle cx="12" cy="12" r="10"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>`,
  stamina: `<svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none"><path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/></svg>`
};

class InfoPanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._tab = 'attributes';
    this._renderPending = false;
    this._unsubs = [];
    this._skillSearch = '';
    this._skillTypeFilter = null;
    this._skillSort = 'default';
    this._skillCompact = false;
    this._collapsedSections = {};
    this._bondFilter = null;    // 温度等级 key 或 null
  }

  connectedCallback() {
    this.render();
    this._unsubs = [
      eventBus.on('state:changed', () => { if (this.isConnected) this._scheduleRender(); }),
      eventBus.on('state:restored', () => { if (this.isConnected) this._scheduleRender(); })
    ];
  }

  disconnectedCallback() {
    this._unsubs.forEach(fn => fn?.());
    this._unsubs = [];
    this._renderPending = false;
  }

  openTab(tab = 'attributes') {
    const allowed = new Set(['attributes', 'skills', 'equipment', 'missions', 'relations']);
    if (!allowed.has(tab)) throw new TypeError('不支持的角色面板分区');
    this._navigationTab = tab;
    this._tab = tab;
    if (this.isConnected) this.render();
    return { opened: true, area: 'info-panel', tab };
  }

  _scheduleRender() {
    if (this._renderPending) return;
    this._renderPending = true;
    requestAnimationFrame(() => {
      this._renderPending = false;
      if (this.isConnected) this.render();
    });
  }

  render() {
    // 保存滚动位置，避免展开/收起时跳回顶部
    const contentEl = this.shadowRoot?.querySelector('.content');
    const scrollTop = contentEl ? contentEl.scrollTop : 0;

    const s = stateManager.get();
    const tab = this._navigationTab || stateManager.getSub('_ui').panel_tab || this._tab;
    const appEl = document.getElementById('app') || document.body;
    const isMobile = (() => {
      try { return parent.window.innerWidth <= 768; } catch(e) { return window.innerWidth <= 768; }
    })() || appEl.classList.contains('is-mobile-forced') || appEl.classList.contains('is-mobile-view');
    this.shadowRoot.innerHTML = `
      <style>${panelStyles}</style>
      <div class="panel">
        ${isMobile ? `
        <div class="panel-header-mobile">
          <span class="panel-title-mobile">角色面板</span>
          <button class="panel-close-btn-mobile" id="panel-close-btn-mobile" title="关闭面板">✕</button>
        </div>
        ` : ''}
        <div class="tabs">
          <button class="tab${tab==='attributes'?' on':''}" data-t="attributes">属性</button>
          <button class="tab${tab==='skills'?' on':''}" data-t="skills">技能</button>
          <button class="tab${tab==='equipment'?' on':''}" data-t="equipment">装备</button>
          <button class="tab${tab==='missions'?' on':''}" data-t="missions">任务</button>
          <button class="tab${tab==='relations'?' on':''}" data-t="relations">关系</button>
        </div>
        <div class="content">${this._renderTab(tab,s)}</div>
      </div>
    `;
    // 恢复滚动位置
    const newContent = this.shadowRoot.querySelector('.content');
    if (newContent && scrollTop > 0) {
      requestAnimationFrame(() => { newContent.scrollTop = scrollTop; });
    }
    const closeBtn = this.shadowRoot.getElementById('panel-close-btn-mobile');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => {
        eventBus.emit('panel:close');
        this.dispatchEvent(new CustomEvent('panel:close', { bubbles: true, composed: true }));
      });
    }

    this.shadowRoot.querySelectorAll('.tab').forEach(t=>{
      t.addEventListener('click',()=>{
        this._navigationTab = null;
        this._tab=t.dataset.t;
        const updatedUi = { ...stateManager.getSub('_ui'), panel_tab: this._tab };
        stateManager.update([{ key: '_ui.panel_tab', op: '=', value: this._tab }]);
        this.render();
      });
    });

    if (this._tab === 'equipment') {
      this.shadowRoot.querySelectorAll('.eq-equip-btn').forEach(b => {
        b.addEventListener('click', () => {
          const name = b.dataset.name;
          const cat = b.dataset.cat;
          let slot = cat === 'weapons' ? 'weapon' : cat === 'armor' ? 'armor' : null;
          if (cat === 'tools') {
            const eq = stateManager.get('物品·已装备·饰品1')
              ? { accessory1: stateManager.get('物品·已装备·饰品1'), accessory2: stateManager.get('物品·已装备·饰品2') }
              : {};
            slot = !eq.accessory1 ? 'accessory1' : (!eq.accessory2 ? 'accessory2' : 'accessory1');
          }
          if (slot) { equipmentSystem.equip(slot, name, cat); this.render(); }
        });
      });
      this.shadowRoot.querySelectorAll('.eq-unequip-btn').forEach(b => {
        b.addEventListener('click', () => {
          let slot = b.dataset.slot;
          if (!slot && b.dataset.name) {
            const weapon = stateManager.get('物品·已装备·武器');
            const armor = stateManager.get('物品·已装备·防具');
            const acc1 = stateManager.get('物品·已装备·饰品1');
            const acc2 = stateManager.get('物品·已装备·饰品2');
            const eq = {};
            if (weapon) eq.weapon = weapon;
            if (armor) eq.armor = armor;
            if (acc1) eq.accessory1 = acc1;
            if (acc2) eq.accessory2 = acc2;
            for (const [k, v] of Object.entries(eq)) {
              if (v === b.dataset.name) slot = k;
            }
          }
          if (slot) { equipmentSystem.unequip(slot); this.render(); }
        });
      });
      this.shadowRoot.querySelectorAll('.eq-use-btn').forEach(b => {
        b.addEventListener('click', () => {
          const name = b.dataset.name;
          equipmentSystem.useItem(name);
          this.render();
        });
      });
      this.shadowRoot.querySelectorAll('.eq-discard-btn').forEach(b => {
        b.addEventListener('click', async (e) => {
          e.stopPropagation();
          const name = b.dataset.name;
          const cat = b.dataset.cat;
          const confirmed = await GameModal.confirm({
            title: '丢弃物品',
            message: `确定要丢弃所有的「${name}」吗？\n此操作不可撤回。`,
            okLabel: '丢弃',
            cancelLabel: '保留'
          });
          if (confirmed) {
            equipmentSystem.removeItem(cat, name, 999999);
            this.render();
          }
        });
      });
    }

    this.shadowRoot.querySelectorAll('.skill-forget-btn').forEach(b => {
      b.addEventListener('click', async (e) => {
        e.stopPropagation();
        const name = b.dataset.name;
        const type = b.dataset.type;
        const confirmed = await GameModal.confirm({
          title: '遗忘技能',
          message: `确定要遗忘「${name}」吗？\n此操作不可撤回，所有熟练度将被清除。`,
          okLabel: '遗忘',
          cancelLabel: '保留'
        });
        if (confirmed) {
          skillSystem.forgetSkill(type, name);
          this.render();
        }
      });
    });

    this.shadowRoot.querySelectorAll('[data-rel-name]').forEach(card => {
      card.addEventListener('click', () => {
        this.showRelModal(card.dataset.relName);
      });
    });

    this.shadowRoot.querySelectorAll('.rel-actions [data-action]').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const npc = btn.dataset.relNpc;
        if (!npc) return;
        if (btn.dataset.action === 'pin') {
          relationshipSystem.togglePin(npc);
          console.log('[Panel] pin clicked for', npc);
          this.render();
        } else if (btn.dataset.action === 'delete') {
          e.preventDefault();
          const confirmed = await GameModal.confirm({
            title: '解除羁绊',
            message: `确定要断开与「${npc}」的羁绊记录吗？<br><span style="font-size:11px;color:var(--text-tertiary);">此操作不可撤回，所有互动历史与好感度将被清除。</span>`,
            okLabel: '确认解除',
            cancelLabel: '保留羁绊'
          });
          if (!confirmed) return;
          relationshipSystem.deleteRelationship(npc);
          this.render();
        }
      });
    });

    /* ── 羁绊绘卷：星图弹窗 / 温度筛选 ── */
    this.shadowRoot.querySelectorAll('.bond-vt-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        if (btn.dataset.bv === 'chart') this._openBondChartModal();
      });
    });
    this.shadowRoot.querySelectorAll('.bond-pill[data-bf]').forEach(btn => {
      btn.addEventListener('click', () => {
        this._bondFilter = this._bondFilter === btn.dataset.bf ? null : btn.dataset.bf;
        this.render();
      });
    });

    if (this._tab === 'skills') {
      const search = this.shadowRoot.getElementById('skill-search');
      if (search) {
        search.addEventListener('input', () => { this._skillSearch = search.value; this.render(); });
      }
      this.shadowRoot.querySelectorAll('[data-action="skill-type"]').forEach(btn => {
        btn.addEventListener('click', () => { this._skillTypeFilter = btn.dataset.val || null; this.render(); });
      });
      this.shadowRoot.querySelectorAll('[data-action="skill-sort"]').forEach(btn => {
        btn.addEventListener('click', () => { this._skillSort = btn.dataset.val; this.render(); });
      });
      this.shadowRoot.querySelectorAll('[data-action="skill-compact"]').forEach(btn => {
        btn.addEventListener('click', () => { this._skillCompact = !this._skillCompact; this.render(); });
      });
      this.shadowRoot.querySelectorAll('[data-action="toggle-section"]').forEach(el => {
        el.addEventListener('click', () => {
          const key = el.dataset.section;
          this._collapsedSections[key] = !this._collapsedSections[key];
          this.render();
        });
      });
    }
  }

  _renderTab(t,s){
    switch(t){
      case 'attributes': return this._renderAttr(s);
      case 'skills': return this._renderSkills(s);
      case 'equipment': return this._renderEq(s);
      case 'missions': return this._renderMs(s);
      case 'relations': return this._renderRel(s);
      default: return '';
    }
  }

  _renderAttr(s){
    const a = s;
    const p = s;
    const pg = s;
    const threat = this._calcThreat(s);
    const tl = threat.label.split(' ');
    const tNum = tl.length > 1 ? tl[1] : '';
    const tTxt = tl[0];

    const chakra = s['属性·查克拉'];
    const chakraCur = s['属性·当前查克拉'];
    const vitality = s['属性·生命力'];
    const vitalityCur = s['属性·当前生命力'];
    const spirit = s['属性·精神力'];
    const spiritCur = s['属性·当前精神力'];
    const stamina = s['属性·体力'];
    const staminaCur = s['属性·当前体力'];
    const exp = s['进度·经验'];
    const expNext = s['进度·下一级经验'];
    const promotion = s['进度·突破待处理'] ? { track: s['进度·突破待处理'] } : {};
    const ryo = s['进度·金钱'] || 0;

    return `
      <div class="sec">
        <div class="sec-title">绝密卷宗 (Dossier)</div>
        <div class="attr-bento">
          <div class="attr-card full-span attr-id-badge">
            <div>
              <div class="attr-label">代号 / 姓名</div>
              <div class="attr-id-name">${this._esc(p['玩家·姓名']||'忍者')}</div>
            </div>
            <div style="text-align:right;">
              <div class="attr-label">荣誉忍阶</div>
              <div class="attr-id-rank grade-badge" ${gradeAttributes(p['玩家·忍阶'], 'ninja')}>${this._esc(p['玩家·忍阶'])}</div>
            </div>
          </div>

          <div class="attr-card" style="--threat-color: ${threat.color};">
            <div class="attr-threat"></div>
            <div class="attr-label">综合战力</div>
            <div class="attr-threat-val">${tTxt} <span style="font-size:12px;opacity:0.6;font-family:var(--font-body); font-weight:normal;">${tNum}</span></div>
          </div>

          <div class="attr-card">
            <div class="attr-label">查克拉属性</div>
            ${this._renderChakra(p['玩家·查克拉属性'])}
            <div style="font-size:10px; color:var(--text-tertiary); margin-top:auto;">${this._esc(p['玩家·出身']||'流浪')}</div>
          </div>
        </div>
      </div>

      <div class="sec">
        <div class="sec-title">能量与潜能 (Vitals)</div>
        <div class="attr-bento">
          <div class="attr-card full-span" style="padding: 24px;">
            ${this._newBar('查克拉', chakraCur, chakra, '#42A5F5')}
            ${this._newBar('生命力', vitalityCur, vitality, '#66BB6A')}
            <div class="attr-bars-pair">
              ${this._newBar('精神力', spiritCur, spirit, '#CE93D8')}
              ${this._newBar('体力', staminaCur, stamina, '#eb613f')}
            </div>
          </div>
        </div>
      </div>

      <div class="sec" style="display:grid; grid-template-columns: 1fr 1fr; gap: 16px;">
        <div>
          <div class="sec-title">实战造诣</div>
          <div class="attr-card" style="display:grid; grid-template-columns: 1fr 1fr; gap:16px;">
            ${this._derivedBento(s)}
          </div>
        </div>
        <div>
          <div class="sec-title">考核与资金</div>
          <div class="attr-card" style="display:flex; flex-direction:column; gap:12px; padding: 16px;">
            <div>
              <div class="attr-label">当前历练</div>
              <div class="attr-value" style="color:var(--c-kin-bright); font-family:var(--font-mono);">${exp} <span style="font-size:10px;color:var(--text-tertiary);">/ ${expNext}</span></div>
            </div>
            <div>
              <div class="attr-label">晋升路线</div>
              <div class="attr-value" style="font-size:12px;">${this._track(promotion?.track)}</div>
            </div>
            <div>
              <div class="attr-label">当前资金</div>
              <div class="attr-value" style="color:var(--c-kin-bright); font-family:var(--font-mono); display:flex; align-items:center; gap:6px;">
                ${this._svg('coin', 14, 14)}
                ${ryo}
              </div>
            </div>
          </div>
        </div>
      </div>`;
  }

  _renderChakra(natures) {
    if (!natures) return '<span style="color:var(--text-tertiary); font-size:12px; margin: 4px 0 8px;">未觉醒</span>';
    const list = Array.isArray(natures) ? natures : [natures];
    if (list.length === 0) return '<span style="color:var(--text-tertiary); font-size:12px; margin: 4px 0 8px;">未觉醒</span>';

    const colors = {
      '火': '#ef5350', '水': '#42A5F5', '风': '#81c784', '雷': '#ffd54f', '土': '#c69c6d',
      '阴': '#CE93D8', '阳': '#f4f1ea', '木': '#66BB6A', '冰': '#81d4fa', '熔': '#ff7043', '沸': '#ff8a65', '磁': '#90a4ae', '岚': '#b39ddb'
    };

    return `<div class="chakra-badges">` + list.map(n => {
      const c = colors[n] || 'var(--text-secondary)';
      return `<span class="chakra-badge" style="color:${c};">${this._esc(n)}</span>`;
    }).join('') + `</div>`;
  }

  _calcThreat(s) {
    const assessment = calculateCombatAssessment(
      combatAttributesFromPlayerState(s),
      combatMasteriesFromPlayerState(s)
    );
    const colors = {
      'E级': '#a39f98',
      'D级': '#81c784',
      'C级': '#42A5F5',
      'B级': '#c69c6d',
      'A级': '#eb613f',
      'S级': '#ef5350',
      '超S级': '#d50000'
    };
    return {
      ...assessment,
      label: `${assessment.level} (${assessment.roundedScore})`,
      color: colors[assessment.level] || colors['E级']
    };
  }

  _derivedBento(s){
    const chakra = s['属性·查克拉']||0;
    const spirit = s['属性·精神力']||0;
    const vitality = s['属性·生命力']||0;
    const speed = s['属性·速度']||0;
    const stamina = s['属性·体力']||0;
    const skJutsu = this._scanSkills(s, '忍术');
    const skTaijutsu = this._scanSkills(s, '体术');
    const skGenjutsu = this._scanSkills(s, '幻术');
    const best=g=>Math.max(0,...Object.values(g||{}).map(x=>Number(x?.mastery)||0));
    const nin=Math.round((chakra)*0.45+(spirit)*0.25+best(skJutsu)*0.7);
    const tai=Math.round((stamina)*0.45+(speed)*0.9+best(skTaijutsu)*0.9);
    const gen=Math.round((spirit)*0.75+(chakra)*0.2+best(skGenjutsu)*0.9);
    const def=Math.round((vitality)*0.18+(stamina)*0.25);

    const items = [['忍术',nin,'#42A5F5'], ['体术',tai,'#66BB6A'], ['幻术',gen,'#CE93D8'], ['防御',def,'var(--text-secondary)']];
    return items.map(([l,v,c])=>`
      <div>
        <div class="attr-label">${l}</div>
        <div class="attr-value" style="font-family:var(--font-mono); color:${c};">${v}</div>
      </div>`).join('');
  }

  _newBar(l,cur,max,color){
    const p = max>0?formatPercentage(cur,max):0;
    return `
      <div class="attr-bar-wrap">
        <div class="attr-bar-label">
          <span>${l}</span>
          <span style="font-family:var(--font-mono); color:${color};">${cur} <span style="color:var(--text-tertiary);">/ ${max}</span></span>
        </div>
        <div class="attr-bar-track"><div class="attr-bar-fill" style="width:${p}%; background:${color}; color:${color};"></div></div>
      </div>`;
  }

  _normalizeSkillGroup(g) {
    if (!g) return {};
    if (Array.isArray(g)) {
      const obj = {};
      g.forEach(item => {
        if (item && typeof item === 'object' && item.name) {
          obj[item.name] = item;
        }
      });
      return obj;
    }
    return g;
  }

  _scanSkills(s, type) {
    const prefix = `技能·${type}·`;
    const result = {};
    const subFields = {
      '名称': 'name', '等级': 'rank', '属性': 'element', '消耗': 'cost', '消耗资源': 'resource_type',
      '威力': 'power', '熟练度': 'mastery', '描述': 'description', '类型': 'type',
      '数据库ID': 'technique_id', '来源': 'source'
    };
    const subFieldKeys = new Set(Object.keys(subFields));
    for (const [k, v] of Object.entries(s)) {
      if (!k.startsWith(prefix)) continue;
      const rest = k.slice(prefix.length);
      // Check if it's a flat sub-field key like "变身术·消耗"
      const dotIdx = rest.lastIndexOf('·');

      let isCorrupted = false;
      if (dotIdx > 0) {
        const parts = rest.split('·');
        for (let i = 0; i < parts.length - 1; i++) {
          if (subFieldKeys.has(parts[i])) {
            isCorrupted = true;
            break;
          }
        }
      }
      if (isCorrupted) continue;

      if (dotIdx > 0) {
        const skillName = rest.slice(0, dotIdx);
        const fieldCN = rest.slice(dotIdx + 1);
        if (subFieldKeys.has(fieldCN)) {
          if (!result[skillName]) result[skillName] = {};
          const fieldEN = subFields[fieldCN];

          let finalV = v;
          if (typeof v === 'object' && v !== null) {
            const vals = Object.values(v);
            if (vals.length === 1) finalV = vals[0];
            else if (v[fieldCN] !== undefined) finalV = v[fieldCN];
            else if (v[fieldEN] !== undefined) finalV = v[fieldEN];
          }

          result[skillName][fieldEN] = finalV;
          continue;
        }
      }
      // Original logic: direct object or number value
      if (typeof v === 'object' && v !== null) {
        result[rest] = { ...(result[rest] || {}), ...v };
      } else if (typeof v === 'number') {
        if (!result[rest]) result[rest] = { name: rest, mastery: v };
      }
    }
    return result;
  }

  _bloodlineEntries(s) {
    const entries = new Map();
    const put = (rawName, data = null) => {
      const name = String(rawName || '').trim();
      if (!name || ['普通血脉', '无', '未知'].includes(name)) return;
      const entry = entries.get(name) || { name };
      if (data && typeof data === 'object' && !Array.isArray(data)) {
        const rank = data.rank ?? data['等级'];
        const mastery = Number(data.mastery ?? data['熟练度']);
        const description = data.description ?? data['描述'] ?? data['说明'];
        if (entry.rank == null && rank != null && String(rank).trim() !== '') entry.rank = String(rank).trim();
        if (entry.mastery == null && Number.isFinite(mastery)) entry.mastery = Math.round(mastery);
        if (!entry.description && description) entry.description = String(description).trim();
      }
      entries.set(name, entry);
    };
    const visit = input => {
      if (!input) return;
      if (typeof input === 'string' || typeof input === 'number') {
        put(input);
        return;
      }
      if (Array.isArray(input)) {
        input.forEach(visit);
        return;
      }
      if (typeof input !== 'object') return;
      if (input.name || input['名称']) {
        put(input.name || input['名称'], input);
        return;
      }
      for (const [key, entry] of Object.entries(input)) {
        if (entry && typeof entry === 'object' && !Array.isArray(entry)) put(entry.name || entry['名称'] || key, entry);
        else put(key);
      }
    };
    visit(this._scanSkills(s, '血继限界'));
    visit(s?.skills?.kekkei_genkai);
    visit(s['技能·血继限界']);
    return [...entries.values()];
  }

  // 每种血继有自己的查克拉底色与印记字；未收录的血继回退为「血」字绯红。
  static BLOODLINE_THEMES = [
    { match: ['轮回眼'], color: '#b388ff', rgb: '179,136,255', glyph: '瞳' },
    { match: ['写轮眼', '血轮眼'], color: '#ff5252', rgb: '255,82,82', glyph: '瞳' },
    { match: ['白眼', '净眼', '转生眼'], color: '#d6ccf0', rgb: '214,204,240', glyph: '瞳' },
    { match: ['血龙眼'], color: '#ff6e6e', rgb: '255,110,110', glyph: '瞳' },
    { match: ['冰遁'], color: '#80d8ff', rgb: '128,216,255', glyph: '冰' },
    { match: ['木遁'], color: '#81c784', rgb: '129,199,132', glyph: '木' },
    { match: ['熔遁', '溶遁'], color: '#ff8a65', rgb: '255,138,101', glyph: '熔' },
    { match: ['灼遁'], color: '#ff7043', rgb: '255,112,67', glyph: '灼' },
    { match: ['磁遁'], color: '#ffd740', rgb: '255,215,64', glyph: '磁' },
    { match: ['尘遁'], color: '#cfd8dc', rgb: '207,216,220', glyph: '尘' },
    { match: ['沸遁'], color: '#f48fb1', rgb: '244,143,177', glyph: '沸' },
    { match: ['岚遁'], color: '#82b1ff', rgb: '130,177,255', glyph: '岚' },
    { match: ['爆遁'], color: '#ffab40', rgb: '255,171,64', glyph: '爆' },
    { match: ['钢遁'], color: '#b0bec5', rgb: '176,190,197', glyph: '钢' },
    { match: ['影遁'], color: '#9575cd', rgb: '149,117,205', glyph: '影' },
    { match: ['尸骨脉', '骨脉', '尸骨'], color: '#eceff1', rgb: '236,239,241', glyph: '骨' }
  ];

  _bloodlineTheme(name) {
    const n = String(name || '');
    for (const theme of InfoPanel.BLOODLINE_THEMES) {
      if (theme.match.some(keyword => n.includes(keyword))) return theme;
    }
    // 未收录：瞳术统一用「瞳」印，其余取术名首字作为印记
    const glyph = n.endsWith('眼') ? '瞳' : (n[0] || '血');
    return { color: '#ef5350', rgb: '239,83,80', glyph };
  }

  _renderBloodlineCard(entry) {
    const mastery = Number.isFinite(entry.mastery) ? entry.mastery : null;
    const width = mastery === null ? 0 : Math.max(0, Math.min(100, mastery));
    const theme = this._bloodlineTheme(entry.name);
    return `
      <div class="skill-card bloodline" style="--bl:${theme.color};--bl-rgb:${theme.rgb};">
        <div class="bloodline-aura"></div>
        <span class="bloodline-glyph">${this._esc(theme.glyph)}</span>
        ${entry.rank ? `<span class="bloodline-rank">${this._esc(entry.rank)}</span>` : ''}
        <div class="skill-title">${this._esc(entry.name)}</div>
        <div class="bloodline-divider">◆</div>
        ${mastery === null ? '' : `
        <div class="bloodline-sync">
          <div class="bloodline-sync-label"><span>血脉同调</span><span>${mastery}%</span></div>
          <div class="bloodline-sync-track"><div class="bloodline-sync-fill" style="width:${width}%"></div></div>
        </div>`}
        ${entry.description ? `<div class="bloodline-desc">${this._esc(entry.description)}</div>` : ''}
      </div>`;
  }

  _techniqueDisplayData(input = {}, fallbackName = '', fallbackType = 'jutsu') {
    const source = input && typeof input === 'object' ? input : {};
    const first = (...keys) => {
      for (const key of keys) {
        if (source[key] !== undefined && source[key] !== null && source[key] !== '') return source[key];
      }
      return undefined;
    };
    const name = String(first('name', '名称') || fallbackName || '未命名招式').trim();
    const sourceType = String(first('type', '类型') || fallbackType || 'jutsu').trim().toLowerCase();
    const type = sourceType.includes('gen') || sourceType.includes('幻') ? 'genjutsu'
      : sourceType.includes('tai') || sourceType.includes('体') ? 'taijutsu'
        : sourceType.includes('support') || sourceType.includes('支') || sourceType.includes('辅') ? 'support' : 'jutsu';
    const typeLabel = { jutsu: '忍术', taijutsu: '体术', genjutsu: '幻术', support: '支援' }[type];
    const techniqueId = first('technique_id', '数据库ID');
    const authoredSource = String(first('source', '来源') || '').toLowerCase();
    const mayResolveCanon = techniqueId || (!source.custom && !['ai_original', 'original', 'custom'].includes(authoredSource));
    let canonRecord = techniqueId ? CANON_DATABASE.getRecord('techniques', String(techniqueId)) : null;
    if (!canonRecord && mayResolveCanon) canonRecord = CANON_DATABASE.resolveTechnique(name);
    const masteryValue = Number(first('mastery', '熟练度'));
    const canonical = canonRecord
      ? CANON_DATABASE.toStateSkill(canonRecord, { mastery: Number.isFinite(masteryValue) ? masteryValue : 0 })
      : null;
    const numberOrNull = (value) => {
      if (value === undefined || value === null || value === '') return null;
      const number = Number(value);
      return Number.isFinite(number) ? Math.max(0, Math.round(number)) : null;
    };
    const resourceFallback = type === 'genjutsu' ? '精神力' : type === 'taijutsu' ? '体力' : '查克拉';
    const rawResource = String(first('resource_type', 'resourceType', 'resource', '消耗资源') || canonical?.resource_type || resourceFallback).trim();
    const normalizedResource = rawResource.toLowerCase();
    const resource = normalizedResource.includes('spirit') || normalizedResource.includes('精神') ? '精神力'
      : normalizedResource.includes('stamina') || normalizedResource.includes('体力') ? '体力'
        : normalizedResource.includes('chakra') || normalizedResource.includes('查克拉') ? '查克拉' : rawResource;
    return {
      name,
      type,
      typeLabel,
      rank: String(first('rank', '等级') || canonical?.rank || 'D').toUpperCase(),
      element: String(first('element', '属性') || canonical?.element || '').trim(),
      resource,
      cost: numberOrNull(first('cost', '消耗') ?? canonical?.cost),
      power: numberOrNull(first('power', '威力') ?? canonical?.power),
      mastery: numberOrNull(first('mastery', '熟练度') ?? canonical?.mastery) ?? 0,
      description: String(first('description', '描述') || canonical?.description || '').trim()
    };
  }

  _renderTechniqueStats(input, fallbackName, fallbackType, { compact = false } = {}) {
    const technique = this._techniqueDisplayData(input, fallbackName, fallbackType);
    const metric = (kind, label, value) => `
      <span class="skill-technique-stat" data-stat="${kind}">
        <span class="skill-technique-stat-label">${this._esc(label)}</span>
        <strong>${value === null ? '未记录' : value}</strong>
      </span>`;
    return `<span class="skill-technique-stats${compact ? ' compact' : ''}">
      ${metric('power', '威力', technique.power)}
      ${metric('cost', `${technique.resource || ''}消耗`, technique.cost)}
    </span>`;
  }

  _normalizeNpcTechniques(combatStats) {
    if (!combatStats || typeof combatStats !== 'object') return [];
    const groups = [
      ['忍术', 'jutsu'], ['jutsu', 'jutsu'],
      ['体术', 'taijutsu'], ['taijutsu', 'taijutsu'],
      ['幻术', 'genjutsu'], ['genjutsu', 'genjutsu'],
      ['支援', 'support'], ['support', 'support']
    ];
    const normalized = [];
    const seen = new Set();
    for (const [key, fallbackType] of groups) {
      const group = combatStats[key];
      const entries = Array.isArray(group)
        ? group.map(item => [item?.name || item?.名称 || '', item])
        : group && typeof group === 'object' ? Object.entries(group) : [];
      for (const [fallbackName, rawValue] of entries) {
        const raw = rawValue && typeof rawValue === 'object'
          ? rawValue
          : { name: fallbackName, mastery: rawValue };
        const technique = this._techniqueDisplayData(raw, fallbackName, fallbackType);
        const identity = `${technique.type}:${technique.name.normalize('NFKC').toLowerCase()}`;
        if (!technique.name || seen.has(identity)) continue;
        seen.add(identity);
        normalized.push(technique);
      }
    }
    return normalized;
  }

  _renderSkills(s){
    const ju = this._scanSkills(s, '忍术');
    const tai = this._scanSkills(s, '体术');
    const gen = this._scanSkills(s, '幻术');
    const support = this._scanSkills(s, '支援');
    const talents = this._scanSkills(s, '天赋');
    const placeholder = talents[CUSTOM_TALENT_PLACEHOLDER];
    if (placeholder) {
      const parsed = parseCustomTalentDescription(placeholder.description);
      if (parsed.length || Object.keys(talents).some(name => name !== CUSTOM_TALENT_PLACEHOLDER)) {
        delete talents[CUSTOM_TALENT_PLACEHOLDER];
      }
      for (const item of parsed) {
        if (!talents[item.name]) talents[item.name] = { ...placeholder, ...item, custom: true };
      }
    }
    const extraNin = {};
    const auxiliary = {};
    const knowledge = {};
    Object.assign(ju, extraNin);
    Object.assign(support, auxiliary, knowledge);

    const bloodlines = this._bloodlineEntries(s);

    const cats = [['秘传忍术', ju, 'element', 'jutsu'], ['体术造诣', tai, null, 'taijutsu'], ['幻术解析', gen, null, 'genjutsu'], ['辅助技能', support, null, 'support']];
    const allSkills = [];
    cats.forEach(([, skills, , type]) => { Object.entries(skills).forEach(([n,d]) => { allSkills.push({ ...d, name: n, _type: type }); }); });

    const bar = `<div class="skill-bar">
      <input class="skill-search" id="skill-search" placeholder="搜索技能..." value="${this._escAttr(this._skillSearch)}" data-action="skill-search">
      <button class="skill-btn ${!this._skillTypeFilter?'active':''}" data-action="skill-type" data-val="">全部</button>
      <button class="skill-btn ${this._skillTypeFilter==='jutsu'?'active':''}" data-action="skill-type" data-val="jutsu">忍</button>
      <button class="skill-btn ${this._skillTypeFilter==='taijutsu'?'active':''}" data-action="skill-type" data-val="taijutsu">体</button>
      <button class="skill-btn ${this._skillTypeFilter==='genjutsu'?'active':''}" data-action="skill-type" data-val="genjutsu">幻</button>
      <button class="skill-btn ${this._skillTypeFilter==='support'?'active':''}" data-action="skill-type" data-val="support">辅</button>
      <button class="skill-btn ${this._skillSort==='mastery'?'active':''}" data-action="skill-sort" data-val="mastery">熟练度↓</button>
      <button class="skill-btn ${this._skillSort==='default'?'active':''}" data-action="skill-sort" data-val="default">默认</button>
      <button class="skill-btn ${this._skillCompact?'active':''}" data-action="skill-compact">紧凑</button>
    </div>`;

    const visible = this._getFilteredSortedSkills(allSkills);
    const totalStr = allSkills.length !== visible.length
      ? `显示 ${visible.length} / 总计 ${allSkills.length} 个技能`
      : `总计 ${allSkills.length} 个技能`;

    return `<div class="sec">
        <div class="sec-title" style="cursor:default;">血继限界</div>
        ${bloodlines.length ? `<div class="bloodline-list">${bloodlines.map(entry => this._renderBloodlineCard(entry)).join('')}</div>` : `
        <div class="skill-card bloodline normal">
          <span class="bloodline-glyph">脉</span>
          <div class="skill-title">普通血脉</div>
          <div class="bloodline-desc">未觉醒血继之力，忍道仍由自身开拓。</div>
        </div>`}
      </div>
      <div class="sec">
        <div class="sec-title" style="cursor:default;">特殊天赋</div>
        <div class="grid-list">
          ${Object.entries(talents).length?Object.entries(talents).map(([n,d])=>`
            <div class="skill-card">
              <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
                <div class="skill-title">${this._esc(n)}</div>
                <span class="glass-pill" style="padding:2px 8px; font-size:9px;">${d.custom?'自创':'先天'}</span>
              </div>
              <div style="font-size:11px; color:var(--text-secondary); line-height:1.5;">${this._esc(d.description||'效果未知')}</div>
            </div>`).join(''):`
            <div class="skill-empty">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><circle cx="12" cy="12" r="3"/></svg>
              <span>尚未获得特殊天赋，<em>修行与经历</em> 或可带来新的成长</span>
            </div>`}
        </div>
      </div>`
      + bar + `<div class="skill-summary">${totalStr}</div>`
      + this._skillSection('秘传忍术', ju, 'element', 'jutsu')
      + this._skillSection('体术造诣', tai, null, 'taijutsu')
      + this._skillSection('幻术解析', gen, null, 'genjutsu')
      + this._skillSection('辅助技能', support, null, 'support');
  }

  _getFilteredSortedSkills(all) {
    let list = all;
    if (this._skillSearch) {
      const q = this._skillSearch.toLowerCase();
      list = list.filter(s => (s.name||'').toLowerCase().includes(q));
    }
    if (this._skillTypeFilter) {
      list = list.filter(s => s._type === this._skillTypeFilter);
    }
    if (this._skillSort === 'mastery') {
      list = [...list].sort((a, b) => (b.mastery||0) - (a.mastery||0));
    }
    return list;
  }

  _skillSection(title, skills, metaKey, type) {
    const normalized = this._normalizeSkillGroup(skills);
    const entries = Object.entries(normalized);
    let list = entries.map(([n,d]) => ({ ...d, name: n }));
    list = list.filter(s => s.name && s.name.trim());
    if (this._skillSearch) {
      const q = this._skillSearch.toLowerCase();
      list = list.filter(s => (s.name||'').toLowerCase().includes(q));
    }
    if (this._skillTypeFilter && this._skillTypeFilter !== type) list = [];
    if (this._skillSort === 'mastery') list.sort((a, b) => (b.mastery||0) - (a.mastery||0));

    const getThemeColor = (t) => {
      if(t==='jutsu') return '#42A5F5';
      if(t==='taijutsu') return '#66BB6A';
      if(t==='genjutsu') return '#CE93D8';
      return 'var(--text-primary)';
    };
    const color = getThemeColor(type);

    const sectionKey = type;
    const isCollapsed = this._collapsedSections[sectionKey] || false;

    const bodyHtml = !list.length ? `
      <div class="skill-empty">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect width="14" height="18" x="5" y="3" rx="2"/><path d="M9 7h6"/><path d="M9 11h6"/><path d="M9 15h4"/></svg>
        <span>尚未习得任何术，<em>修行或拜师</em> 方能掌握</span>
      </div>` : (this._skillCompact
        ? list.map(d => this._compactSkillRow(d, color, metaKey, type)).join('')
        : `<div class="grid-list">${list.map(d => {
            const mColor = (m) => { if(m>=80) return '#ef5350'; if(m>=60) return '#eb613f'; if(m>=40) return '#c69c6d'; if(m>=20) return '#e8c87a'; return '#a39f98'; };
            return `<div class="skill-card" style="border-left-color: ${color};">
              <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:8px;">
                <div class="skill-title">${this._esc(d.name)}</div>
                <div class="skill-mastery-tag">${this._mt(d?.mastery||0)}</div>
              </div>
              ${d.description ? `<div style="font-size:11px; color:var(--text-secondary); line-height:1.5; margin-bottom:12px;">${this._esc(d.description)}</div>` : ''}
              ${this._renderTechniqueStats(d, d.name, type)}
              <div style="display:flex; justify-content:space-between; align-items:center; border-top: 1px solid var(--border-subtle); padding-top: 8px;">
                <div style="font-size:10px; color:var(--text-tertiary); display:flex; gap:8px;">
                  ${d[metaKey] ? `<span style="color:${color}; font-weight:bold;">${this._esc(d[metaKey])}</span>` : ''}
                  <span class="grade-badge" ${gradeAttributes(d.rank || 'E')}>${this._esc(d.rank||'E')} 级</span>
                </div>
                <div style="display:flex; align-items:center; gap:8px;">
                  <div style="font-size:10px; color:var(--text-secondary); font-family:var(--font-mono);">造诣 ${d.mastery||0}</div>
                  <button class="btn-sleek skill-forget-btn" data-name="${this._escAttr(d.name)}" data-type="${this._escAttr(type)}" style="padding:2px 6px; font-size:9px; border-color:rgba(239,83,80,0.3); color:#ef5350;" onclick="event.stopPropagation();">遗忘</button>
                </div>
              </div>
            </div>`;
          }).join('')}</div>`);

    return `
      <div class="sec">
        <div class="sec-title skill-collapse-title" data-action="toggle-section" data-section="${sectionKey}">
          <span class="arrow${isCollapsed?'':' open'}">▶</span>
          ${title}<span class="skill-collapse-badge">(${list.length})</span>
        </div>
        <div class="skill-section-body${isCollapsed?' collapsed':''}">
          ${bodyHtml}
        </div>
      </div>`;
  }

  _compactSkillRow(d, color, metaKey, type) {
    const el = d[metaKey] ? `<span style="color:${color};font-weight:bold;font-size:10px;">${this._esc(d[metaKey])}</span>` : '';
    const rank = `<span class="grade-badge" ${gradeAttributes(d.rank || 'E')} style="font-size:10px;">${this._esc(d.rank||'E')}</span>`;
    const resolvedType = d._type || type || '';
    return `<div class="skill-compact-row" data-action="expand-skill" data-skill="${this._escAttr(d.name)}" data-type="${this._escAttr(resolvedType)}">
      <span class="skill-name" title="${this._escAttr(d.name)}">${this._esc(d.name)}</span>
      <span class="skill-meta">${el}${rank}<span style="font-size:10px;color:var(--text-secondary);">${this._mt(d.mastery||0)}</span></span>
      ${this._renderTechniqueStats(d, d.name, resolvedType, { compact: true })}
      <span class="skill-mastery-num" style="display:flex; align-items:center;">
        造诣 ${d.mastery||0}
        <button class="btn-sleek skill-forget-btn" data-name="${this._escAttr(d.name)}" data-type="${this._escAttr(resolvedType)}" style="padding:2px 6px; font-size:9px; margin-left:6px; border-color:rgba(239,83,80,0.3); color:#ef5350;" onclick="event.stopPropagation();">遗忘</button>
      </span>
    </div>`;
  }

  _mt(v){ return v>=100?'极意':v>=80?'精纯':v>=60?'老练':v>=40?'熟稔':v>=20?'初成':'入门'; }

  _renderEq(s){
    // Equipped slots store item names as plain strings (e.g. '草薙剑'); _eqSlots/_eqSection handle string-or-object.
    const equipped = {
      weapon: s['物品·已装备·武器'] || null,
      armor: s['物品·已装备·防具'] || null,
      accessory1: s['物品·已装备·饰品1'] || null,
      accessory2: s['物品·已装备·饰品2'] || null
    };
    for (const k of Object.keys(equipped)) { if (!equipped[k]) delete equipped[k]; }

    // Scan flat state keys and reassemble into item objects
    const weapons = {};
    const armor = {};
    const tools = {};
    const consumables = {};
    const catMap = { '武器': weapons, '防具': armor, '道具': tools, '消耗品': consumables };
    const fieldMap = { '数量': 'quantity', '品质': 'quality', '描述': 'description', '说明': 'description', '名称': 'name', '类型': 'type', '威力': 'power', '消耗': 'cost', '属性': 'element' };
    const fieldMapKeys = new Set(Object.keys(fieldMap));
    for (const [k, v] of Object.entries(s)) {
      if (!k.startsWith('物品·')) continue;
      if (k.startsWith('物品·已装备·')) continue;
      // Try matching flat sub-field: 物品·消耗品·兵粮丸·数量
      const parts = k.split('·');
      if (parts.length >= 4) {
        const catCN = parts[1];
        const bucket = catMap[catCN];
        if (!bucket) continue;
        const itemName = parts.slice(2, -1).join('·');
        const fieldCN = parts[parts.length - 1];

        // Sanitize: If the itemName contains any known subfield keywords, it's a corrupted key from past bugs
        let isCorrupted = false;
        const itemNameParts = parts.slice(2, -1);
        for (const p of itemNameParts) {
          if (fieldMapKeys.has(p)) {
            isCorrupted = true;
            break;
          }
        }
        if (isCorrupted) continue;

        if (fieldMapKeys.has(fieldCN)) {
          if (!bucket[itemName]) bucket[itemName] = {};

          let finalV = v;
          if (typeof v === 'object' && v !== null) {
            const vals = Object.values(v);
            if (vals.length === 1) finalV = vals[0];
            else if (v[fieldCN] !== undefined) finalV = v[fieldCN];
            else if (v[fieldMap[fieldCN]] !== undefined) finalV = v[fieldMap[fieldCN]];
          }

          bucket[itemName][fieldMap[fieldCN]] = finalV;
          continue;
        }
      }
      // Direct object: 物品·消耗品·兵粮丸 = {quantity:3, quality:'普通'}
      if (parts.length === 3) {
        const catCN = parts[1];
        const bucket = catMap[catCN];
        if (!bucket) continue;
        const itemName = parts[2];
        if (!bucket[itemName]) bucket[itemName] = {};
        if (typeof v === 'object' && v !== null) {
          // Merge only fields that don't already exist (flat keys take precedence)
          for (const [vk, vv] of Object.entries(v)) {
            if (bucket[itemName][vk] === undefined) {
              bucket[itemName][vk] = vv;
            }
          }
        }
      }
    }
    // Also merge from nested s.equipment if it exists (legacy support)
    if (s.equipment && typeof s.equipment === 'object') {
      for (const [cat, items] of Object.entries(s.equipment)) {
        const bucket = { weapons, armor, tools, consumables }[cat];
        if (bucket && typeof items === 'object') {
          for (const [n, item] of Object.entries(items)) {
            bucket[n] = { ...(bucket[n] || {}), ...item };
          }
        }
      }
    }
    const ryo = s['进度·金钱'] || 0;
    const bonus = this._equipBonusSummary({ equipped, weapons, armor, tools, consumables });
    return `
      <div class="sec" style="margin-bottom: 16px;">
        <div class="eq-topbar">
          <div class="sec-title" style="margin:0;">忍具与行囊</div>
          <div class="eq-ryo" title="当前资金">${this._svg('coin')} ${ryo} 两</div>
        </div>
      </div>
      ${this._eqSlots(equipped, bonus, { weapons, armor, tools })}
      <div style="margin-top: 24px;">
        ${this._eqSection('兵器', weapons, 'weapons', equipped, 'weapon')}
        ${this._eqSection('防具', armor, 'armor', equipped, 'armor')}
        ${this._eqSection('刃具', tools, 'tools', equipped, 'tools')}
        ${this._eqSection('物资', consumables, 'consumables', equipped, 'consumable')}
      </div>`;
  }

  _equipBonusSummary(equipment) {
    const bonus = {};
    const Q = { '破烂':0,'普通':3,'精良':8,'优秀':15,'史诗':25,'传说':40 };
    const QD = { '破烂':0,'普通':1,'精良':3,'优秀':6,'史诗':10,'传说':18 };
    const QL = { '破烂':0,'普通':0,'精良':1,'优秀':2,'史诗':4,'传说':7 };
    const equipped = equipment.equipped || {};
    for (const [slot, entry] of Object.entries(equipped)) {
      if (!entry) continue;
      let item = equipment.weapons?.[entry.name] || equipment.armor?.[entry.name] || equipment.tools?.[entry.name];
      if (!item) item = stateManager.get(`物品·武器·${entry.name}`) || stateManager.get(`物品·防具·${entry.name}`) || stateManager.get(`物品·道具·${entry.name}`) || { name: entry.name, quality: '普通' };
      if (!item) continue;

      if (item.stats && typeof item.stats === 'object') {
        for (const [k, v] of Object.entries(item.stats)) {
          if (typeof v === 'number') {
            bonus[k] = (bonus[k] || 0) + v;
          }
        }
      } else {
        const q = item.quality || '普通';
        if (entry.category === 'weapons') bonus.speed = (bonus.speed || 0) + Math.floor((Q[q]||0) * 0.3);
        if (entry.category === 'armor') bonus.vitality = (bonus.vitality || 0) + (QD[q]||0);
        if (entry.category === 'tools') bonus.luck = (bonus.luck || 0) + (QL[q]||0);
      }
    }
    return bonus;
  }

  _getQualityColor(q) {
    const colors = { '破烂':'#a39f98', '普通':'#e8e4d9', '精良':'#66BB6A', '优秀':'#42A5F5', '稀有':'#42A5F5', '史诗':'#c69c6d', '传说':'#ef5350' };
    return colors[q] || '#e8e4d9';
  }

  _svg(type) {
    const paths = {
      'weapon': '<path d="M14.5 17.5L3 6V3h3l11.5 11.5"/><path d="M13 19l6-6"/><path d="M16 16l4 4"/><path d="M19 21l2-2"/>', // Sword/Blade
      'armor': '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>', // Shield
      'accessory': '<path d="M12 22A10 10 0 0 1 12 2a10 10 0 0 1 0 20z"/><circle cx="12" cy="12" r="3"/><path d="M12 5v2"/><path d="M12 17v2"/>', // Jade Pendant
      'tools': '<path d="M14.5 17.5L3 6V3h3l11.5 11.5"/><path d="M13 19l6-6"/>', // Kunai
      'consumable': '<rect width="14" height="14" x="5" y="5" rx="7" ry="7"/><path d="M5 12h14"/>', // Pill
      'coin': '<circle cx="12" cy="12" r="10"/><path d="M12 6v12"/><path d="M9.5 9.5h5"/><path d="M9.5 14.5h5"/>' // Coin / Ryo
    };
    return `<svg class="eq-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${paths[type]||paths['weapon']}</svg>`;
  }

  _eqSlots(equipped, bonus, buckets = {}) {
    const slots = [
      { key: 'weapon', label: '主武器', type: 'weapon' },
      { key: 'armor', label: '战斗服', type: 'armor' },
      { key: 'accessory1', label: '挂饰一', type: 'accessory' },
      { key: 'accessory2', label: '挂饰二', type: 'accessory' }
    ];

    const lblMap = {'chakra':'查克拉上限','vitality':'生命力上限','stamina':'体力上限','spirit':'精神上限','strength':'综合实力','speed':'速度','ninjutsu':'忍术','taijutsu':'体术','genjutsu':'幻术','luck':'气运', 'attack':'攻击力', 'defense':'防御力'};
    const bonusPills = Object.entries(bonus)
      .filter(([, v]) => v !== 0)
      .map(([k, v]) => `<span class="eq-bonus-pill">${lblMap[k] || k} ${v > 0 ? '+' + v : v}</span>`)
      .join('');

    let html = `<div class="sec eq-loadout">
      <div class="eq-loadout-head">
        <span class="eq-loadout-title">战斗武装</span>
        ${bonusPills}
      </div>
      <div class="eq-slot-grid">`;

    for (const slot of slots) {
      const entry = equipped[slot.key];
      if (entry) {
        // entry 在新扁平state中是字符串(物品名)；兼容旧的对象格式 { name, category }
        const itemName = typeof entry === 'string' ? entry : (entry?.name || '');
        const entryCat = typeof entry === 'object' ? entry.category : null;
        let item = null;
        // 优先从 _renderEq 组装好的分类桶查找(扁平键已还原成对象)，再回退整键查询
        const tryCats = entryCat ? [entryCat] : ['weapons', 'armor', 'tools'];
        const catMap = { weapons: '武器', armor: '防具', tools: '道具' };
        for (const cat of tryCats) {
          const found = buckets[cat]?.[itemName] || stateManager.get(`物品·${catMap[cat] || cat}·${itemName}`);
          if (found) { item = found; break; }
        }
        if (!item) item = { name: itemName, quality: '普通' };
        const q = (item && item.quality) || '普通';
        const qColor = this._getQualityColor(q);
        const wmark = q === '传说' ? '極' : q === '史诗' ? '稀' : '';
        html += `<div class="eq-slot filled grade-surface" ${gradeAttributes(q, 'quality')} data-quality="${this._escAttr(q)}" data-slot="${slot.key}" style="--qc:${qColor};">
          <div class="eq-watermark">${wmark}</div>
          <span class="eq-slot-tag">${this._svg(slot.type)} ${slot.label}</span>
          <span class="eq-slot-name">${this._esc(itemName)}</span>
          <span class="eq-slot-quality">${this._esc(q)}</span>
          <button class="eq-op eq-slot-unequip eq-unequip-btn" data-slot="${slot.key}" title="卸下">✕</button>
        </div>`;
      } else {
        html += `<div class="eq-slot empty" data-slot="${slot.key}">
          <span class="eq-slot-tag">${this._svg(slot.type)} ${slot.label}</span>
          <div class="eq-slot-void">
            ${this._svg(slot.type)}
            <span>未装备</span>
          </div>
        </div>`;
      }
    }
    html += `</div></div>`;
    return html;
  }

  _eqSection(title, items, category, equipped, svgType) {
    let list = [];
    if (Array.isArray(items)) {
      list = items.map(i => [i.name || '未知装备', i]);
    } else {
      list = Object.entries(items || {});
    }
    list = list.filter(([n, i]) => {
      if (!n) return false;
      const qty = typeof i.quantity === 'object' ? (i.quantity?.value || i.quantity?.amount || i.quantity?.count || i.quantity?.quantity || 0) : (i.quantity ?? -1);
      if (qty === 0) return false;
      return true;
    });
    let content = '';
    if (!list.length) {
      content = `
        <div class="eq-cat-empty">
          ${this._svg(svgType)}
          <span>行囊空空如也，尚未获得此类武装</span>
        </div>`;
    } else {
      content = `
        <div class="eq-item-list">
          ${list.map(([n,i])=> {
            const isEquipped = Object.values(equipped).some(e => {
              if (!e) return false;
              const nm = typeof e === 'string' ? e : e.name;
              return nm === n;
            });
            const q = i.quality || '普通';
            const qColor = this._getQualityColor(q);
            const wmark = q === '传说' ? '極' : q === '史诗' ? '稀' : '';
            const qty = typeof i.quantity === 'object' ? (i.quantity?.value || i.quantity?.amount || i.quantity?.count || i.quantity?.quantity || 1) : (i.quantity || 1);
            return `
            <div class="eq-item grade-surface" ${gradeAttributes(q, 'quality')} data-quality="${this._escAttr(q)}" style="--qc:${qColor};">
              <div class="eq-watermark">${wmark}</div>
              <div class="eq-item-badge">${this._svg(svgType)}</div>
              <div class="eq-item-main">
                <div class="eq-item-name">
                  ${this._esc(n)}
                  ${isEquipped ? `<span class="eq-item-on">装备中</span>` : ''}
                </div>
                <div class="eq-item-meta">
                  <span class="q">${this._esc(q)}</span>
                  <span>持有 × ${qty}</span>
                </div>
                ${i.description ? `<div class="eq-item-desc">${this._esc(i.description)}</div>` : ''}
              </div>
              <div class="eq-item-ops">
                ${category === 'weapons' || category === 'armor' || category === 'tools' ?
                  (isEquipped ? `<button class="eq-op primary eq-unequip-btn" data-name="${this._escAttr(n)}" data-cat="${category}">卸下</button>`
                  : `<button class="eq-op eq-equip-btn" data-name="${this._escAttr(n)}" data-cat="${category}">装备</button>`) : ''}
                ${category === 'consumables' ? `<button class="eq-op primary eq-use-btn" data-name="${this._escAttr(n)}">使用</button>` : ''}
                <button class="eq-op danger eq-discard-btn" data-name="${this._escAttr(n)}" data-cat="${category}" onclick="event.stopPropagation();">丢弃</button>
              </div>
            </div>`;
          }).join('')}
        </div>`;
    }

    return `
      <div class="sec" style="margin-bottom:24px;">
        <div class="eq-cat-head">
          ${this._svg(svgType)}
          <span class="eq-cat-title">${title}</span>
          <span class="eq-cat-count">${list.length}</span>
        </div>
        ${content}
      </div>`;
  }

  _renderMs(s){
    const m = stateManager.getSub('_missions') || {};
    const activeList = (m.active && typeof m.active === 'object') ? Object.values(m.active) : [];
    const completedList = (m.completed && typeof m.completed === 'object') ? Object.values(m.completed) : [];
    return `
      <div class="sec">
        <div class="sec-title">悬赏令 (进行中)</div>
        ${activeList.length > 0 ? activeList.map(x=>`
          <div class="item-card mission-seal ${this._escAttr(x.rank||'D')}">
            <div class="rank-badge grade-badge" ${gradeAttributes(x.rank || 'D')}>${this._esc(x.rank||'D')}</div>
            <div>
              <div class="item-header" style="margin-bottom: 4px;">
                <div class="item-name">${this._esc(x.title || x.name || x.id || '未命名任务')}</div>
              </div>
              <div class="item-desc" style="color:var(--text-secondary);">${this._esc(x.objective||'')}</div>
              <div class="rel-stats" style="margin-top:12px; border-top: none; padding-top: 0;">
                <span class="tag">${this._esc(x.location||'?')}</span>
                <span class="tag" style="color:var(--text-primary); border-bottom-color:var(--text-primary);">风险 // ${this._esc(x.risk||'?')}</span>
              </div>
            </div>
          </div>`).join(''):'<div class="empty">尚无委托送达<br><em>前往忍者学校</em>，或可接取任务</div>'}
      </div>
      <div class="sec">
        <div class="sec-title">完成记录</div>
        ${completedList.slice(-3).reverse().map(x=>`
          <div class="row" style="opacity:0.5; padding: 8px 0;">
            <span class="row-l" style="font-size:12px; text-transform:none; letter-spacing:0;">${this._esc(x.title||'?')}</span>
            <span class="row-v grade-badge" ${gradeAttributes(x.rank)} style="font-size:10px;">${this._esc(x.rank||'?')}</span>
          </div>`).join('') || '<div class="empty" style="opacity:0.4;">暂无记录</div>'}
      </div>`;
  }

  _renderNpcCombatDetails(cs) {
    // ── 渲染 NPC 战斗属性卡片 ──
    const icons = NPC_DOSSIER_ICONS;
    let combatStatsHtml = '';
    if (cs) {
      const statDefs = [
        { key: '查克拉', icon: icons.chakra, color: '#00E5FF', maxKey: '查克拉上限', fmt: (v,mx) => `${v}/${mx}` },
        { key: '生命力', icon: icons.vitality, color: '#FF4D4D', maxKey: '生命力上限', fmt: (v,mx) => `${v}/${mx}` },
        { key: '速度', icon: icons.speed, color: '#81C784', fmt: (v) => v },
        { key: '精神力', icon: icons.spirit, color: '#CE93D8', maxKey: '精神力上限', fmt: (v,mx) => `${v}/${mx}` },
        { key: '体力', icon: icons.stamina, color: '#FFB74D', maxKey: '体力上限', fmt: (v,mx) => `${v}/${mx}` },
      ];
      const masteryDefs = [
        { key: '忍术造诣', color: '#00E5FF' },
        { key: '体术造诣', color: '#81C784' },
        { key: '幻术造诣', color: '#CE93D8' },
      ];
      let statCards = '';
      for (const sd of statDefs) {
        const val = cs[sd.key];
        if (val === undefined) continue;
        const maxV = sd.maxKey ? cs[sd.maxKey] : null;
        const pct = maxV ? Math.min(100, Math.round((val / Math.max(1, maxV)) * 100)) : 50;
        statCards += `<div class="npc-stat-card">
          <div class="npc-stat-head">
            <span class="npc-stat-icon" style="color:${sd.color}">${sd.icon}</span>
            <span class="npc-stat-label">${sd.key}</span>
          </div>
          <div class="npc-stat-val">${sd.fmt(val, maxV)}</div>
          <div class="npc-stat-bar"><div class="npc-stat-fill" style="width:${pct}%;background:${sd.color}"></div></div>
        </div>`;
      }
      let masteryCards = '';
      for (const md of masteryDefs) {
        const val = cs[md.key];
        if (val === undefined) continue;
        masteryCards += `<div class="npc-stat-card npc-mastery">
          <div class="npc-stat-label">${md.key}</div>
          <div class="npc-stat-val">${val}</div>
          <div class="npc-stat-bar"><div class="npc-stat-fill" style="width:${val}%;background:${md.color}"></div></div>
        </div>`;
      }
      const nature = cs.查克拉属性;
      const rank = cs.忍阶;
      const assessment = calculateCombatAssessment(combatAttributesFromNpcCard(cs), combatMasteriesFromNpcCard(cs));
      let metaRow = '';
      if (nature || rank) {
        metaRow = `<div class="npc-meta-row">${
          rank ? `<span class="npc-rank-badge grade-badge" ${gradeAttributes(rank, 'ninja')}>${this._esc(rank)}</span>` : ''
        }<span class="npc-nature-tag" data-npc-combat-rating>综合战力 ${assessment.level} · ${assessment.roundedScore}</span>${
          Array.isArray(nature) ? nature.map(n => `<span class="npc-nature-tag">${this._esc(n)}</span>`).join('') : ''
        }</div>`;
      }
      combatStatsHtml = `
        <div class="npc-section">
          <div class="npc-section-title"><span>战斗图谱</span><div class="line"></div></div>
          ${metaRow}
          <div class="npc-stat-grid">${statCards}</div>
          <div class="npc-mastery-grid">${masteryCards}</div>
        </div>`;
    }

    // ── 渲染忍术列表 ──
    let jutsuHtml = '';
    const jutsus = this._normalizeNpcTechniques(cs);
    if (jutsus.length > 0) {
      const rankColors = { S:'#ef7770', A:'#e2bd79', B:'#c5a2ec', C:'#42A5F5', D:'#81C784', E:'#e8e4d9' };
      const typeLabels = { jutsu:'NIN', taijutsu:'TAI', genjutsu:'GEN', support:'SUP' };
      const cards = jutsus.map(j => {
        const jName = j.name || '?';
        const jRank = j.rank || 'D';
        const jElem = j.element || '';
        const jCost = j.cost;
        const jPower = j.power;
        const jMast = j.mastery || 0;
        const jDesc = j.description || '';
        const jType = j.type || 'jutsu';
        const costLabel = `${j.resource || ''}消耗`;
        const rc = rankColors[jRank] || '#a39f98';
        return `<div class="npc-jutsu-card" style="--jc:${rc}">
          <div class="jutsu-bg-glow" style="background:${rc}"></div>
          <div class="jutsu-head">
            <span class="jutsu-rank grade-badge" ${gradeAttributes(jRank)}>${this._esc(jRank)}</span>
            <span class="jutsu-type">${typeLabels[jType] || this._esc(j.typeLabel)}</span>
            ${jElem ? `<span class="jutsu-elem">${this._esc(jElem)}</span>` : ''}
            <span class="jutsu-name">${this._esc(jName)}</span>
          </div>
          ${jDesc ? `<div class="jutsu-desc">${this._esc(jDesc)}</div>` : ''}
          <div class="jutsu-stats">
            <span class="jutsu-stat" data-stat="power"><span class="jutsu-stat-label">威力</span><strong>${jPower === null ? '未记录' : jPower}</strong></span>
            <span class="jutsu-stat" data-stat="cost"><span class="jutsu-stat-label">${this._esc(costLabel)}</span><strong>${jCost === null ? '未记录' : jCost}</strong></span>
            <span class="jutsu-stat" data-stat="mastery"><span class="jutsu-stat-label">熟练度</span><strong>${jMast}</strong></span>
          </div>
        </div>`;
      }).join('');
      jutsuHtml = `
        <div class="npc-section">
          <div class="npc-section-title"><span>忍术档案 · ${jutsus.length}</span><div class="line"></div></div>
          <div class="npc-jutsu-list">${cards}</div>
        </div>`;
    }

    return combatStatsHtml + jutsuHtml;
  }

  _watchNpcCombatDetails(modal, name) {
    let signature = JSON.stringify(stateManager.getSub('_relationships')?.[name]?.combat_stats);
    const refresh = ({ key } = {}) => {
      if (key !== '_relationships' || !modal.isConnected) return;
      const relationship = stateManager.getSub('_relationships')?.[name];
      if (!relationship) { modal.close(); return; }
      const nextSignature = JSON.stringify(relationship.combat_stats);
      if (signature === nextSignature) return;
      signature = nextSignature;
      const container = modal.shadowRoot?.querySelector('#npc-combat-details');
      const scroller = modal.shadowRoot?.querySelector('.modal');
      const scrollTop = scroller?.scrollTop || 0;
      if (container) container.innerHTML = this._renderNpcCombatDetails(relationshipSystem.getRelationship(name).combat_stats);
      if (scroller) scroller.scrollTop = scrollTop;
    };
    const unsubs = [
      eventBus.on('state:changed', refresh),
      eventBus.on('state:restored', () => modal.close()),
      eventBus.on('state:reset', () => modal.close())
    ];
    const cleanup = () => { unsubs.splice(0).forEach(unsub => unsub()); observer.disconnect(); };
    const observer = new MutationObserver(() => { if (!modal.isConnected) cleanup(); });
    observer.observe(document.body, { childList: true, subtree: true });
    return cleanup;
  }

  showRelModal(name) {
    const r = stateManager.getSub('_relationships') || {};
    if (!r[name]) return;
    // Normalize old save shapes (English keys, object maps, missing canon
    // metadata) before building the NPC dossier.
    const d = relationshipSystem.getRelationship(name);

    const Modal = customElements.get('game-modal');
    if (!Modal) return;
    const modal = new Modal();
    (document.getElementById('app') || document.body).appendChild(modal);

    const t = this._tempOf(d.affection); // 情感温度（头像环/印章用色）
    // 社交三维双向迷你条（中轴向两侧，值域 ±100）
    const socialBar = (v, posColor, negColor = '#ef5350') => {
      const val = Math.max(-100, Math.min(100, Number(v) || 0));
      const w = Math.abs(val) / 2;
      const side = val >= 0 ? 'left:50%' : 'right:50%';
      const c = val >= 0 ? posColor : negColor;
      return `<div class="social-bar"><div class="social-bar-fill" style="${side};width:${w}%;background:${c};box-shadow:0 0 6px ${c};"></div></div>`;
    };

    const icons = NPC_DOSSIER_ICONS;

    const combatDetailsHtml = this._renderNpcCombatDetails(d.combat_stats);

    const css = `
      <style>
      .modal { width: min(94vw, 760px); }
      .npc-modal { display: flex; flex-direction: column; gap: 24px; padding: 10px; color: var(--text-primary); }
      .npc-header {
        display: flex; gap: 20px; align-items: center; position: relative; overflow: hidden;
        padding: 20px 20px 18px; border-radius: 14px;
        background:
          radial-gradient(circle at 18% 0%, color-mix(in srgb, var(--tc, #c69c6d) 10%, transparent), transparent 55%),
          repeating-linear-gradient(-45deg, rgba(var(--paper-rgb), 0.012) 0 1px, transparent 1px 9px),
          rgba(var(--paper-rgb), 0.02);
        border: 1px solid rgba(var(--paper-rgb), 0.05);
        box-shadow: inset 3px 0 0 -1px color-mix(in srgb, var(--tc, #c69c6d) 60%, transparent);
      }
      .npc-header::after {
        content: ''; position: absolute; top: 0; left: 8%; right: 8%; height: 1px;
        background: linear-gradient(to right, transparent, rgba(var(--paper-rgb), 0.14), transparent);
      }
      .npc-stamp {
        position: absolute; top: 14px; right: 18px; transform: rotate(-12deg);
        font-family: var(--font-brush, cursive); font-size: 17px; font-weight: 900; letter-spacing: 5px;
        color: var(--c-kokihi, #c9171e);
        border: 2px solid currentColor; outline: 1px solid color-mix(in srgb, currentColor 35%, transparent); outline-offset: 2px;
        border-radius: 4px;
        padding: 3px 8px 3px 12px; opacity: 0.5; pointer-events: none; line-height: 1.2;
      }
      .npc-avatar-ring { width: 76px; height: 76px; position: relative; display: flex; align-items: center; justify-content: center; filter: drop-shadow(0 4px 14px color-mix(in srgb, var(--tc, #c69c6d) 35%, transparent)); flex-shrink: 0; }
      .npc-avatar-ring::before { content: ''; position: absolute; inset: 0; background: conic-gradient(from 0deg, transparent, var(--tc, #c69c6d), transparent); clip-path: polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%); animation: spin 8s linear infinite; }
      @keyframes spin { to { transform: rotate(360deg); } }
      .npc-avatar { width: 70px; height: 70px; background: rgba(var(--ink-deep-rgb), 0.92); clip-path: polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%); display: flex; align-items: center; justify-content: center; font-family: var(--font-brush, serif); color: var(--tc, #c69c6d); font-size: 34px; font-weight: bold; }
      .npc-avatar img { width:100%; height:100%; object-fit:cover; }

      .npc-id { flex: 1; display: flex; flex-direction: column; gap: 4px; min-width: 0; }
      .npc-name-row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
      .npc-name {
        font-size: 24px; font-weight: 900; letter-spacing: 3px;
        font-family: var(--font-title, serif);
        background: linear-gradient(90deg, var(--c-kin-bright) 0%, #fff 50%, var(--c-kin-bright) 100%);
        background-size: 200% auto;
        -webkit-background-clip: text; background-clip: text;
        color: transparent; -webkit-text-fill-color: transparent;
        animation: npc-shine 5s linear infinite;
      }
      @keyframes npc-shine { to { background-position: 200% center; } }
      .npc-temp {
        flex-shrink: 0; font-size: 10px; font-weight: 700; letter-spacing: 2px;
        font-family: var(--font-title, serif); color: var(--tc, #a39f98);
        padding: 3px 10px; border-radius: 100px;
        border: 1px solid var(--tc, #a39f98);
        border-color: color-mix(in srgb, var(--tc, #a39f98) 45%, transparent);
        background: color-mix(in srgb, var(--tc, #a39f98) 12%, transparent);
        text-shadow: 0 0 8px var(--tc, transparent);
      }
      .npc-sub { font-size: 11px; color: var(--text-tertiary); letter-spacing: 1px; display: flex; gap: 8px; margin-top: 6px; flex-wrap: wrap; }
      .npc-sub span {
        padding: 2px 10px; border-radius: 100px; font-size: 10px;
        border: 1px solid rgba(var(--paper-rgb), 0.1); background: rgba(var(--paper-rgb), 0.03);
        color: var(--text-secondary);
      }

      .npc-social-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
      .npc-social-item {
        position: relative; overflow: hidden;
        background: rgba(var(--paper-rgb), 0.02); padding: 14px 16px; border-radius: 10px;
        box-shadow: inset 0 1px 0 rgba(var(--paper-rgb), 0.05);
        display: flex; flex-direction: column; gap: 9px;
        transition: transform 0.25s var(--ease-out, ease), background 0.25s;
      }
      .npc-social-item::before {
        content: ''; position: absolute; inset: 0; pointer-events: none; opacity: 0.09;
        background: radial-gradient(ellipse 110% 90% at 50% -35%, var(--sc, transparent), transparent 62%);
      }
      .npc-social-item:hover { background: rgba(var(--paper-rgb), 0.045); transform: translateY(-1px); }
      .npc-social-head { display: flex; align-items: center; gap: 7px; }
      .npc-social-head svg { width: 13px; height: 13px; color: var(--sc, var(--text-tertiary)); flex-shrink: 0; }
      .npc-social-item .social-label { font-size: 10px; color: var(--text-tertiary); text-transform: uppercase; letter-spacing: 2px; }
      .npc-social-item .social-val { font-size: 22px; font-weight: 700; font-family: var(--font-mono, monospace); line-height: 1; color: var(--sc, var(--text-primary)); text-shadow: 0 0 14px color-mix(in srgb, var(--sc, transparent) 35%, transparent); }
      .social-bar { margin-top: 2px; height: 3px; border-radius: 2px; background: rgba(0,0,0,0.45); box-shadow: inset 0 1px 1px rgba(0,0,0,0.5); position: relative; overflow: hidden; }
      .social-bar::before { content: ''; position: absolute; left: 50%; top: -1px; bottom: -1px; width: 1px; background: rgba(var(--paper-rgb), 0.14); }
      .social-bar-fill { position: absolute; top: 0; height: 100%; border-radius: 2px; }

      .npc-section-title { font-size: 10px; font-weight: 800; letter-spacing: 4px; display: flex; align-items: center; gap: 16px; margin-bottom: 14px; text-transform: uppercase; color: rgba(198,156,109,0.55); color: color-mix(in srgb, var(--c-kin) 65%, transparent); font-family: var(--font-title, serif); }
      .npc-section-title::before { content: ''; width: 3px; height: 11px; border-radius: 2px; background: linear-gradient(180deg, var(--c-shuiro), color-mix(in srgb, var(--c-shuiro) 30%, transparent)); flex-shrink: 0; }
      .npc-section-title .line { flex: 1; height: 1px; background: linear-gradient(90deg, rgba(var(--paper-rgb), 0.08), transparent); }

      .npc-meta-row { display: flex; gap: 8px; margin-bottom: 16px; flex-wrap: wrap; }
      .npc-rank-badge { background: rgba(198,156,109,0.1); color: var(--c-kin-bright); padding: 4px 12px; border-radius: 100px; font-size: 10px; font-weight: bold; letter-spacing: 2px; border: 1px solid rgba(198,156,109,0.28); box-shadow: 0 0 12px -4px rgba(198,156,109,0.5); }
      .npc-nature-tag { background: rgba(var(--paper-rgb), 0.03); color: var(--text-secondary); padding: 4px 12px; border-radius: 100px; font-size: 10px; letter-spacing: 1px; border: 1px solid rgba(var(--paper-rgb), 0.08); }

      .npc-stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)); gap: 12px; margin-bottom: 12px; }
      .npc-stat-card {
        position: relative; overflow: hidden;
        background: rgba(var(--paper-rgb), 0.015);
        border-radius: 10px; padding: 13px;
        box-shadow: inset 0 1px 0 rgba(var(--paper-rgb), 0.05);
        display: flex; flex-direction: column; gap: 8px;
        transition: transform 0.25s var(--ease-out, ease), background 0.25s;
      }
      .npc-stat-card:hover { transform: translateY(-1px); background: rgba(var(--paper-rgb), 0.035); }
      .npc-stat-head { display: flex; align-items: center; gap: 8px; }
      .npc-stat-label { font-size: 10px; color: var(--text-tertiary); font-weight: 600; text-transform: uppercase; letter-spacing: 1px; }
      .npc-stat-val { font-size: 15px; font-weight: 700; color: var(--text-primary); font-family: var(--font-mono, monospace); }
      .npc-stat-bar { width: 100%; height: 3px; background: rgba(0,0,0,0.55); overflow: hidden; border-radius: 2px; box-shadow: inset 0 1px 1px rgba(0,0,0,0.5); }
      .npc-stat-fill { height: 100%; border-radius: 2px; box-shadow: 0 0 8px currentColor; position: relative; overflow: hidden; }
      .npc-stat-fill::after { content: ''; position: absolute; inset: 0; pointer-events: none; background: linear-gradient(90deg, transparent, rgba(255,255,255,0.35), transparent); background-size: 200% 100%; background-repeat: no-repeat; animation: npc-sheen 3.2s linear infinite; }
      @keyframes npc-sheen { from { background-position: 150% 0; } to { background-position: -150% 0; } }

      .npc-mastery-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
      .npc-stat-card.npc-mastery { padding: 13px; }

      .npc-jutsu-list { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); }
      .npc-jutsu-card {
        background:
          linear-gradient(120deg, color-mix(in srgb, var(--jc, transparent) 5%, transparent), transparent 45%),
          rgba(var(--paper-rgb), 0.015);
        border-radius: 10px; padding: 16px 16px 16px 20px; position: relative; overflow: hidden;
        box-shadow: inset 0 1px 0 rgba(var(--paper-rgb), 0.04); transition: all 0.25s var(--ease-out, ease);
      }
      .npc-jutsu-card::before { content: ''; position: absolute; left: 0; top: 22%; bottom: 22%; width: 2.5px; border-radius: 2px; background: var(--jc, transparent); opacity: 0.85; transition: all 0.25s; }
      .npc-jutsu-card:hover { background: linear-gradient(120deg, color-mix(in srgb, var(--jc, transparent) 9%, transparent), transparent 50%), rgba(var(--paper-rgb), 0.04); transform: translateY(-2px); box-shadow: inset 0 1px 0 rgba(var(--paper-rgb), 0.08), 0 10px 26px -12px color-mix(in srgb, var(--jc, transparent) 45%, transparent); }
      .npc-jutsu-card:hover::before { top: 10%; bottom: 10%; box-shadow: 0 0 10px var(--jc, transparent); }
      .jutsu-bg-glow { position: absolute; top: 0; left: 0; width: 100%; height: 100%; opacity: 0.03; filter: blur(20px); pointer-events: none; }
      .jutsu-head { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
      .jutsu-rank {
        flex-shrink: 0; width: 26px; height: 26px; border-radius: 8px;
        display: inline-flex; align-items: center; justify-content: center;
        font-size: 14px; font-family: var(--font-brush, serif); font-weight: bold; line-height: 1;
        background: color-mix(in srgb, currentColor 10%, transparent);
        border: 1px solid color-mix(in srgb, currentColor 35%, transparent);
        text-shadow: 0 0 8px currentColor;
      }
      .jutsu-type { font-size: 9px; border: 1px solid rgba(var(--paper-rgb), 0.1); padding: 2px 7px; border-radius: 100px; color: var(--text-tertiary); letter-spacing: 1px; }
      .jutsu-elem { font-size: 9px; background: rgba(0,0,0,0.4); padding: 2px 7px; border-radius: 100px; color: var(--text-secondary); border: 1px solid rgba(var(--paper-rgb), 0.05); }
      .jutsu-name { font-size: 14px; font-weight: 700; color: var(--text-primary); letter-spacing: 1px; flex: 1; text-align: right; font-family: var(--font-title, serif); }
      .jutsu-desc { font-size: 11px; color: var(--text-tertiary); line-height: 1.6; margin-bottom: 16px; }
      .jutsu-stats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
      .jutsu-stat { display: flex; flex-direction: column; gap: 3px; min-width: 0; padding: 7px 8px; border-radius: 7px; background: rgba(var(--paper-rgb), 0.025); border: 1px solid rgba(var(--paper-rgb), 0.05); }
      .jutsu-stat-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 9px; color: var(--text-tertiary); letter-spacing: 0.5px; }
      .jutsu-stat strong { color: var(--text-primary); font: 700 12px/1 var(--font-mono, monospace); }
      .jutsu-stat[data-stat="power"] strong { color: #FF8A80; }
      .jutsu-stat[data-stat="cost"] strong { color: #80DEEA; }

      .npc-tags { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px; }
      .npc-tag { font-size: 10px; color: var(--text-secondary); background: rgba(var(--paper-rgb), 0.03); border: 1px solid rgba(var(--paper-rgb), 0.07); padding: 4px 12px; border-radius: 100px; letter-spacing: 1px; }

      .timeline-wrap { display: flex; flex-direction: column; gap: 4px; }
      .timeline-node { position: relative; padding: 6px 0 14px 20px; border-left: 1px solid rgba(var(--paper-rgb), 0.07); }
      .timeline-node:last-child { border-left-color: transparent; }
      .timeline-node::before {
        content: ''; position: absolute; left: -4px; top: 10px; width: 7px; height: 7px; border-radius: 50%;
        background: var(--c-kin); box-shadow: 0 0 8px color-mix(in srgb, var(--c-kin) 60%, transparent);
      }
      .timeline-node:first-child::before { background: var(--c-shuiro); box-shadow: 0 0 10px color-mix(in srgb, var(--c-shuiro) 70%, transparent); }
      .timeline-node:not(:first-child)::before { opacity: 0.45; box-shadow: none; }
      .tl-time { display: inline-block; font-size: 9px; color: var(--text-tertiary); margin-bottom: 6px; letter-spacing: 1.5px; font-family: var(--font-mono, monospace); padding: 1px 8px; border-radius: 100px; background: rgba(var(--paper-rgb), 0.035); }
      .tl-action { font-size: 13px; color: var(--text-secondary); line-height: 1.7; margin-bottom: 8px; }
      .tl-thought { font-size: 12px; color: rgba(198,156,109,0.85); line-height: 1.7; font-family: 'Georgia', 'Songti SC', serif; font-style: italic; background: linear-gradient(90deg, rgba(198,156,109,0.06), transparent); padding: 10px 14px; border-left: 2px solid rgba(198,156,109,0.35); border-radius: 0 8px 8px 0; }

      .npc-grand-summary { background: linear-gradient(135deg, rgba(198,156,109,0.07), rgba(66,165,245,0.04)); border: 1px solid rgba(198,156,109,0.14); border-radius: 12px; padding: 18px; position: relative; overflow: hidden; }
      .npc-grand-summary::before { content: '编年'; position: absolute; top: 4px; right: 12px; font-size: 52px; font-weight: 900; opacity: 0.04; font-family: var(--font-brush, serif); letter-spacing: 8px; pointer-events: none; }
      .npc-grand-summary .gs-label { font-size: 9px; font-weight: 800; color: rgba(198,156,109,0.65); letter-spacing: 3px; margin-bottom: 10px; text-transform: uppercase; }
      .npc-grand-summary .gs-text { font-size: 12px; color: var(--text-secondary); line-height: 1.9; }

      .npc-summary-list { display: flex; flex-direction: column; gap: 10px; }
      .npc-summary-card { background: rgba(66,165,245,0.035); border-left: 2px solid rgba(66,165,245,0.25); border-radius: 0 10px 10px 0; padding: 11px 15px; transition: all 0.2s; }
      .npc-summary-card:hover { background: rgba(66,165,245,0.07); transform: translateX(2px); }
      .npc-summary-card .sc-time { font-size: 9px; color: rgba(66,165,245,0.6); letter-spacing: 1px; margin-bottom: 4px; font-family: var(--font-mono, monospace); }
      .npc-summary-card .sc-text { font-size: 12px; color: var(--text-secondary); line-height: 1.7; }

      @media (prefers-reduced-motion: reduce) {
        .npc-name, .npc-stat-fill::after, .npc-avatar-ring::before { animation: none; }
      }
      @media (max-width: 640px) {
        .npc-header { padding: 16px; gap: 12px; }
        .npc-stamp { top: 8px; right: 12px; opacity: 0.14; }
        .npc-avatar-ring { width: 52px; height: 52px; }
        .npc-avatar { width: 48px; height: 48px; font-size: 26px; }
        .npc-name { font-size: 20px; letter-spacing: 1px; line-height: 1.5; overflow-wrap: anywhere; }
        .npc-social-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
        .npc-social-item { padding: 12px 10px; }
        .npc-social-head { gap: 4px; }
        .npc-social-item .social-label { letter-spacing: 0; white-space: nowrap; }
        .npc-social-item .social-val { font-size: 20px; }
      }
      ${gradeEffectStyles}
      </style>
    `;

    const html = `
      ${css}
      <div class="npc-modal">
        <div class="npc-header">
          <div class="npc-stamp">绝密</div>
          <div class="npc-avatar-ring" style="--tc:${t.color}">
            <div class="npc-avatar">${name[0]}</div>
          </div>
          <div class="npc-id">
            <div class="npc-name-row">
              <div class="npc-name">${this._esc(name)}</div>
              <span class="npc-temp" style="--tc:${t.color}">${t.label}</span>
            </div>
            <div class="npc-sub">
              ${d.faction ? `<span>${this._esc(d.faction)}</span>` : ''}
              ${d.role ? `<span>${this._esc(d.role)}</span>` : ''}
            </div>
          </div>
        </div>

        <div class="npc-social-grid">
          <div class="npc-social-item affection" style="--sc:${(d.affection||0)>=0?'#81C784':'#ef5350'};">
            <div class="npc-social-head">${icons.vitality}<span class="social-label">好感度</span></div>
            <div class="social-val">${d.affection||0}</div>
            ${socialBar(d.affection, '#81C784')}
          </div>
          <div class="npc-social-item trust" style="--sc:#42A5F5;">
            <div class="npc-social-head">${icons.spirit}<span class="social-label">信任度</span></div>
            <div class="social-val">${d.trust||0}</div>
            ${socialBar(d.trust, '#42A5F5')}
          </div>
          <div class="npc-social-item respect" style="--sc:var(--c-kin-bright);">
            <div class="npc-social-head">${icons.chakra}<span class="social-label">敬畏度</span></div>
            <div class="social-val">${d.respect||0}</div>
            ${socialBar(d.respect, 'var(--c-kin)')}
          </div>
        </div>

        <div id="npc-portrait-controls"></div>

        <div id="npc-combat-details" style="display:contents">${combatDetailsHtml}</div>
        ${this._renderGrandSummary(d.grand_summary)}
        ${this._renderSummaries(d.summaries)}
        ${this._renderInteractionLog(d.history, d.inner_thoughts)}
        ${(d.tags||[]).length ? `<div class="npc-tags">${d.tags.map(t=>`<span class="npc-tag">${this._esc(t)}</span>`).join('')}</div>` : ''}
      </div>
    `;
    let stopWatching = () => {};
    modal.show({ title: '绝密情报档案', content: html, onDismiss: () => stopWatching(),
      buttons: [{ label: '关闭', primary: true, onClick: () => modal.close() }] });
    stopWatching = this._watchNpcCombatDetails(modal, name);
    try {
      const visual = relationshipSystem.ensureVisualProfile(name);
      const subjectId = visual.visual_subject_id;
      const target = { kind: 'portrait', subjectId };
      const profile = visual.visual_profile || {};
      const controlsHost = modal.shadowRoot?.querySelector('#npc-portrait-controls');
      if (controlsHost) {
        mountPortraitImageControls(controlsHost, {
          imageStudio, subjectId, name,
          profile: {
            displayName: name,
            identitySeed: profile.identity_seed,
            appearance: profile.canonical_description || '',
            outfit: profile.current_appearance || '',
            style: profile.preferred_style || '',
            negativePrompt: profile.negative_prompt || '',
            lockedTraits: profile.locked_traits || []
          },
          onProfileChange: next => relationshipSystem.updateVisualProfile(name, {
            canonical_description: next.appearance || '',
            current_appearance: next.outfit || '',
            preferred_style: next.style || '',
            negative_prompt: next.negativePrompt || '',
            locked_traits: next.lockedTraits || []
          })
        });
      }

      let avatarUrl = '';
      let avatarRefreshGeneration = 0;
      const refreshAvatar = async () => {
        const generation = ++avatarRefreshGeneration;
        const state = await imageStudio.read({ type: 'target', target });
        if (generation !== avatarRefreshGeneration || !modal.isConnected) return;
        const selectedId = state.binding?.assetId;
        const avatar = modal.shadowRoot?.querySelector('.npc-avatar');
        if (!selectedId) {
          if (avatarUrl) {
            URL.revokeObjectURL(avatarUrl);
            avatarUrl = '';
          }
          if (avatar) avatar.textContent = name.slice(0, 1) || '?';
          return;
        }
        const blob = await imageStudio.read({ type: 'asset-content', assetId: selectedId, variant: 'thumbnail' });
        if (generation !== avatarRefreshGeneration || !modal.isConnected) return;
        if (!(blob instanceof Blob)) return;
        if (avatarUrl) URL.revokeObjectURL(avatarUrl);
        avatarUrl = URL.createObjectURL(blob);
        if (avatar) avatar.innerHTML = `<img src="${avatarUrl}" alt="${this._esc(name)}的肖像">`;
      };
      void refreshAvatar().catch(() => {});
      const unsubscribe = imageStudio.subscribe(event => {
        const changed = event?.target || event?.binding?.target;
        if (changed?.kind === 'portrait' && changed.subjectId === subjectId) void refreshAvatar().catch(() => {});
      });
      const observer = new MutationObserver(() => {
        if (modal.isConnected) return;
        avatarRefreshGeneration++;
        observer.disconnect(); unsubscribe();
        if (avatarUrl) URL.revokeObjectURL(avatarUrl);
      });
      observer.observe(document.body, { childList: true, subtree: true });
    } catch (error) {
      console.warn('[InfoPanel] Unable to mount portrait controls:', error.message);
    }
  }

  _renderGrandSummary(grandSummary) {
    if (!grandSummary || typeof grandSummary !== 'string' || !grandSummary.trim()) return '';
    return `
      <div class="npc-section">
        <div class="npc-section-title"><span>\u5173\u7cfb\u7f16\u5e74\u53f2</span><div class="line"></div></div>
        <div class="npc-grand-summary">
          <div class="gs-label">\u5386\u53f2\u603b\u7ed3 \u00b7 GRAND SUMMARY</div>
          <div class="gs-text">${this._esc(grandSummary)}</div>
        </div>
      </div>`;
  }

  _renderSummaries(summaries) {
    if (!Array.isArray(summaries) || summaries.length === 0) return '';
    const cards = summaries.map((s, i) => {
      const timeStr = s.time || `\u7b2c${s.turn || '?'}\u56de\u5408`;
      return `
        <div class="npc-summary-card">
          <div class="sc-time">\u9636\u6bb5 ${i + 1} \u00b7 ${this._esc(typeof timeStr === 'string' ? timeStr : '')}</div>
          <div class="sc-text">${this._esc(s.content || '')}</div>
        </div>`;
    }).join('');
    return `
      <div class="npc-section">
        <div class="npc-section-title"><span>\u8fd1\u671f\u5fc3\u7406\u6863\u6848 \u00b7 ${summaries.length}</span><div class="line"></div></div>
        <div class="npc-summary-list">${cards}</div>
      </div>`;
  }

  _renderInteractionLog(historyArray, thoughtArray = []) {
    const history = Array.isArray(historyArray) ? historyArray : [];
    const thoughts = Array.isArray(thoughtArray) ? thoughtArray : [];
    if (!history.length && !thoughts.length) return '';
    const rows = [];
    const keyedRows = new Map();
    const rowKey = entry => (entry?.turn !== undefined || entry?.time)
      ? `${entry?.turn ?? ''}|${entry?.time || ''}` : '';

    history.forEach((entry, index) => {
      const summary = String(entry?.summary || '');
      const thoughtMatch = summary.match(/\[心声\]\s*([^\[]+)/);
      const thought = thoughtMatch?.[1]?.trim() || '';
      const historyMatch = summary.match(/\[历史\]\s*([^\[]+)/)?.[1]?.trim() || '';
      const actionPrefix = thoughtMatch
        ? summary.slice(0, thoughtMatch.index).replace(/^\[历史\]\s*/, '').trim()
        : summary.trim();
      const action = historyMatch || actionPrefix;
      const row = { entry, action, thoughts: thought ? [thought] : [], order: index };
      rows.push(row);
      const key = rowKey(entry);
      if (key && !keyedRows.has(key)) keyedRows.set(key, row);
    });
    thoughts.forEach((entry, index) => {
      const thought = String(entry?.summary ?? entry?.content ?? '').replace(/^\[心声\]\s*/, '').trim();
      if (!thought) return;
      const key = rowKey(entry);
      const existing = key ? keyedRows.get(key) : null;
      if (existing) {
        if (!existing.thoughts.includes(thought)) existing.thoughts.push(thought);
        return;
      }
      const row = { entry, action: '', thoughts: [thought], order: history.length + index };
      rows.push(row);
      if (key) keyedRows.set(key, row);
    });
    rows.sort((left, right) => {
      const leftTurn = Number(left.entry?.turn);
      const rightTurn = Number(right.entry?.turn);
      if (Number.isFinite(leftTurn) && Number.isFinite(rightTurn) && leftTurn !== rightTurn) return rightTurn - leftTurn;
      return left.order - right.order;
    });

    const nodes = rows.slice(0, 10).map(({ entry, action, thoughts: rowThoughts }) => `
        <div class="timeline-node">
          ${entry?.time ? `<div class="tl-time">${this._esc(entry.time)}</div>` : ''}
          ${action ? `<div class="tl-action">${this._esc(action)}</div>` : ''}
          ${rowThoughts.map(thought => `<div class="tl-thought">" ${this._esc(thought)} "</div>`).join('')}
        </div>
      `).join('');

    return `
      <div class="npc-section">
        <div class="npc-section-title"><span>羁绊追溯</span><div class="line"></div></div>
        <div class="timeline-wrap">${nodes}</div>
      </div>
    `;
  }

  /* ── 情感温度等级 ── */
  _tempOf(affection) {
    const a = Number(affection) || 0;
    if (a >= 80)  return { key: 'soul',    label: '挚友', color: 'var(--tmp-soul)' };
    if (a >= 60)  return { key: 'friend',  label: '好友', color: 'var(--tmp-friend)' };
    if (a >= 30)  return { key: 'warm',    label: '友好', color: 'var(--tmp-warm)' };
    if (a >= 0)   return { key: 'neutral', label: '中立', color: 'var(--tmp-neutral)' };
    if (a >= -30) return { key: 'cold',    label: '冷淡', color: 'var(--tmp-cold)' };
    if (a >= -60) return { key: 'hostile', label: '敌意', color: 'var(--tmp-hostile)' };
    return { key: 'hatred', label: '仇恨', color: 'var(--tmp-hatred)' };
  }

  /* ── 单条温度计（双向刻度条，值域 -50..50 映射为半宽百分比） ── */
  _thermoRow(label, value, color) {
    const v = Math.max(-50, Math.min(50, Number(value) || 0));
    const pct = Math.abs(v) * 2; // 0..100 半宽
    const dir = v >= 0 ? 'pos' : 'neg';
    return `
      <div class="thermo-row">
        <span class="thermo-label">${label}</span>
        <div class="thermo-track">
          <div class="thermo-fill ${dir}" style="--fc:${color}; width:${pct / 2}%;"></div>
        </div>
        <span class="thermo-val">${v > 0 ? '+' : ''}${v}</span>
      </div>`;
  }

  _renderRel(s) {
    const r = stateManager.getSub('_relationships') || {};
    const all = Object.entries(r).sort((a, b) => {
      const p1 = !!a[1]?.pinned, p2 = !!b[1]?.pinned;
      if (p1 !== p2) return p1 ? -1 : 1;
      return (b[1]?.affection || 0) - (a[1]?.affection || 0);
    });

    /* 七级温度统计 */
    const ORDER = ['soul', 'friend', 'warm', 'neutral', 'cold', 'hostile', 'hatred'];
    const stats = Object.fromEntries(ORDER.map(k => [k, 0]));
    all.forEach(([, d]) => { stats[this._tempOf(d.affection).key]++; });
    const shown = this._bondFilter
      ? all.filter(([, d]) => this._tempOf(d.affection).key === this._bondFilter)
      : all;

    const pills = ORDER.map(k => {
      const t = this._tempOf(k === 'soul' ? 80 : k === 'friend' ? 60 : k === 'warm' ? 30 : k === 'neutral' ? 0 : k === 'cold' ? -30 : k === 'hostile' ? -60 : -100);
      if (!stats[k]) return '';
      const on = this._bondFilter === k;
      return `<button class="bond-pill${on ? ' on' : ''}" style="--pc:${t.color};" data-bf="${k}" title="${on ? '取消筛选' : `只看${t.label}`}">
        <span class="dot"></span>${t.label}<b>${stats[k]}</b>
      </button>`;
    }).join('');

    return `
      <div class="sec bond-wrap">
        <div class="bond-overview">
          <span class="bond-ov-title">羁绊绘卷</span>
          ${pills || '<span style="font-size:10px;color:var(--text-tertiary);letter-spacing:1px;">暂无羁绊</span>'}
          <div class="bond-view-toggle">
            <button class="bond-vt-btn bond-chart-open" data-bv="chart" title="展开情感星图">✦ 星图</button>
          </div>
        </div>
        ${this._renderEmaGrid(shown)}
      </div>`;
  }

  /* ── 绘马卡片网格 ── */
  _renderEmaGrid(entries) {
    if (!entries.length) {
      return `<div class="empty">${this._bondFilter ? '该温度带暂无羁绊' : '形单影只<br><em>结印发起遭遇</em>，结识同伴'}</div>`;
    }
    return `<div class="ema-grid">${entries.map(([n, d]) => {
      const t = this._tempOf(d.affection);
      const aff = Number(d.affection) || 0;
      const hist = Array.isArray(d.history) ? d.history : [];
      const tags = (Array.isArray(d.tags) ? d.tags : []).slice(0, 3);
      return `
        <div class="ema-card${d.pinned ? ' pinned' : ''}" style="--tc:${t.color};" data-rel-name="${escAttr(n)}">
          <div class="rel-actions">
            <button class="rel-action-btn pin-btn ${d.pinned ? 'pin-active' : ''}" data-action="pin" data-rel-npc="${escAttr(n)}" title="${d.pinned ? '取消置顶' : '置顶'}">📌</button>
            <button class="rel-action-btn pin-btn del-hover" data-action="delete" data-rel-npc="${escAttr(n)}" title="删除羁绊">✖</button>
          </div>
          <div class="ema-head">
            <div class="ema-avatar" aria-hidden="true">${this._esc((n || '?').slice(0, 1))}</div>
            <div class="ema-head-main">
              <div class="ema-name">${this._esc(n)}${d.pinned ? '<span class="ema-pin-mark">📌</span>' : ''}</div>
              <div class="ema-meta">
                ${d.faction ? `<span class="ema-faction">${this._esc(d.faction)}</span>` : ''}
                ${d.role ? `<span>${this._esc(d.role)}</span>` : ''}
              </div>
            </div>
            <div class="ema-seal" title="${t.label} · 好感 ${aff}">
              <span class="ema-seal-lv">${t.label}</span>
              <span class="ema-seal-val">${aff > 0 ? '+' : ''}${aff}</span>
            </div>
          </div>
          <div class="ema-thermo">
            ${this._thermoRow('好感', d.affection, t.color)}
            ${this._thermoRow('信任', d.trust, '#42A5F5')}
            ${this._thermoRow('敬畏', d.respect, 'var(--c-kin)')}
          </div>
          <div class="ema-foot">
            ${tags.map(tg => `<span class="ema-tag">${this._esc(tg)}</span>`).join('')}
            ${hist.length ? `<span class="ema-trend flat" title="共 ${hist.length} 次羁绊记录">∞ ${hist.length}</span>` : ''}
          </div>
        </div>`;
    }).join('')}</div>`;
  }

  /* ── 情感星图（大弹窗版 · 920×650，多环分层） ── */
  _openBondChartModal() {
    const r = stateManager.getSub('_relationships') || {};
    const all = Object.entries(r);
    const shown = this._bondFilter ? all.filter(([, d]) => this._tempOf(d.affection).key === this._bondFilter) : all;

    const Modal = customElements.get('game-modal');
    if (!Modal) return;
    const modal = new Modal();
    (document.getElementById('app') || document.body).appendChild(modal);
    modal.show({
      title: '情感星图',
      content: this._renderBondChart(shown),
      buttons: [{ label: '关闭', primary: true, close: true }]
    });

    /* 节点点击开档案（弹窗叠层）+ 悬停联线高亮 */
    modal.shadowRoot.querySelectorAll('.chart-node[data-rel-name]').forEach(node => {
      node.addEventListener('click', () => this.showRelModal(node.dataset.relName));
      if (node.dataset.lk !== undefined) {
        node.addEventListener('mouseenter', () => {
          modal.shadowRoot.querySelector(`.chart-link[data-lk="${node.dataset.lk}"]`)?.classList.add('on');
        });
        node.addEventListener('mouseleave', () => {
          modal.shadowRoot.querySelector(`.chart-link[data-lk="${node.dataset.lk}"]`)?.classList.remove('on');
        });
      }
    });
  }

  _renderBondChart(entries) {
    const css = `
      <style>
      .modal { width: min(94vw, 860px); max-height: 92vh; }
      .bc { display: flex; flex-direction: column; gap: 12px; }
      .bc-wrap {
        position: relative; width: 100%; border-radius: 12px;
        background:
          radial-gradient(circle at 50% 45%, rgba(var(--paper-rgb),0.03), transparent 55%),
          rgba(0,0,0,0.25);
        border: 1px solid rgba(var(--paper-rgb),0.05);
        overflow: hidden;
      }
      .bc-wrap svg { display: block; width: 100%; height: auto; }
      .bc-empty { padding: 80px 20px; text-align: center; color: var(--text-tertiary); font-size: 13px; letter-spacing: 2px; }
      .chart-guide { fill: none; stroke: rgba(var(--paper-rgb), 0.06); stroke-dasharray: 2 5; }
      .chart-guide-label {
        font-size: 11px; fill: var(--text-tertiary); letter-spacing: 3px;
        text-anchor: end; opacity: 0.7; font-family: var(--font-title, serif);
      }
      .chart-core-ring {
        fill: none; stroke: var(--c-shuiro); stroke-width: 1.2;
        stroke-dasharray: 3 7; opacity: 0.5;
        animation: bc-core-spin 26s linear infinite;
      }
      @keyframes bc-core-spin { to { stroke-dashoffset: -400; } }
      .chart-node { cursor: pointer; transition: opacity 0.2s; }
      .chart-node .halo { transition: opacity 0.25s; }
      .chart-node:hover .halo { opacity: 0.3; }
      .chart-node circle.core { transition: stroke-width 0.25s ease; }
      .chart-node:hover circle.core { stroke-width: 3; }
      .chart-node text {
        font-family: var(--font-title, serif); fill: var(--text-secondary);
        text-anchor: middle; pointer-events: none;
        paint-order: stroke; stroke: rgba(3,4,6,0.9); stroke-width: 3.5px; stroke-linejoin: round;
      }
      .chart-node .n-val { font-family: var(--font-mono, monospace); fill: var(--text-tertiary); transition: opacity 0.2s; }
      .bc-wrap.dense .chart-node .n-val { opacity: 0; }
      .bc-wrap.dense .chart-node:hover .n-val { opacity: 1; }
      .chart-link { transition: stroke-width 0.3s, opacity 0.3s; }
      .chart-link.on { stroke-width: 5; opacity: 0.95; }
      .bc-hint {
        position: absolute; bottom: 10px; right: 14px; font-size: 10px;
        color: var(--text-tertiary); letter-spacing: 1px; opacity: 0.65;
      }
      /* 七级温度图例 */
      .bc-legend {
        display: flex; flex-wrap: wrap; justify-content: center; gap: 6px 14px;
        font-size: 10px; color: var(--text-tertiary); letter-spacing: 1px;
      }
      .bc-lg-item { display: inline-flex; align-items: center; gap: 5px; }
      .bc-lg-item i {
        width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0;
        box-shadow: 0 0 6px currentColor;
      }
      @media (prefers-reduced-motion: reduce) { .chart-core-ring { animation: none; } }
      @media (max-width: 768px) {
        .bc-legend { gap: 4px 10px; font-size: 9px; }
        .bc-hint { display: none; }
      }
      </style>`;

    if (!entries.length) {
      return `${css}<div class="bc"><div class="bc-wrap"><div class="bc-empty">星图暂无星宿 —— 结识同伴后点亮</div></div></div>`;
    }

    const W = 920, H = 650, cx = W / 2, cy = 322, ELLIPSE = 0.85;
    const n = entries.length;
    const player = stateManager.get('玩家·姓名') || '我';

    /* 多环分层：好感越高越靠内；环数随人数自适应 */
    const RING_RADII = n <= 7 ? [290] : n <= 16 ? [165, 295] : [110, 220, 300];
    const RING_LABELS = RING_RADII.length === 3 ? ['亲密', '熟识', '泛泛'] : (RING_RADII.length === 2 ? ['亲近', '泛泛'] : []);
    const sorted = [...entries].sort((a, b) => (b[1].affection || 0) - (a[1].affection || 0));

    /* 按周长比例分配每环节点（内少外多），相邻环错开半格角度 */
    const totalR = RING_RADII.reduce((s, r) => s + r, 0);
    const counts = RING_RADII.map(r => Math.max(1, Math.round(n * r / totalR)));
    while (counts.reduce((s, c) => s + c, 0) > n) counts[counts.length - 1]--;
    while (counts.reduce((s, c) => s + c, 0) < n) counts[counts.length - 1]++;

    const nodes = [];
    let idx = 0;
    for (let k = 0; k < RING_RADII.length; k++) {
      const m = counts[k], radius = RING_RADII[k];
      const offset = -Math.PI / 2 + (k % 2 ? Math.PI / m : 0);
      for (let j = 0; j < m && idx < n; j++, idx++) {
        const [name, d] = sorted[idx];
        const aff = Number(d.affection) || 0;
        const t = this._tempOf(aff);
        const angle = offset + (j / m) * Math.PI * 2;
        nodes.push({
          name, d, t, aff,
          x: cx + Math.cos(angle) * radius,
          y: cy + Math.sin(angle) * radius * ELLIPSE
        });
      }
    }

    const links = nodes.map((nd, i) => {
      const w = 1.2 + Math.min(100, Math.abs(nd.aff)) / 18;
      const op = 0.16 + Math.min(100, Math.abs(nd.aff)) / 100 * 0.5;
      return `<line class="chart-link" data-lk="${i}" x1="${cx}" y1="${cy}" x2="${nd.x.toFixed(1)}" y2="${nd.y.toFixed(1)}"
        stroke="${nd.t.color}" stroke-width="${w.toFixed(1)}" opacity="${op.toFixed(2)}" />`;
    }).join('');

    const circles = nodes.map((nd, i) => {
      const r = 20 + Math.min(100, Math.abs(nd.aff)) / 100 * 8; // 20..28
      return `
        <g class="chart-node" data-rel-name="${escAttr(nd.name)}" data-lk="${i}" transform="translate(${nd.x.toFixed(1)},${nd.y.toFixed(1)})">
          <circle class="halo" r="${(r + 7).toFixed(1)}" fill="${nd.t.color}" opacity="0.10" />
          <circle class="core" r="${r.toFixed(1)}" fill="rgba(10,12,16,0.92)" stroke="${nd.t.color}" stroke-width="1.8" />
          <text y="4.5" font-size="12" font-weight="700" fill="${nd.t.color}" stroke="none">${this._esc(nd.name.slice(0, 2))}</text>
          <text y="${(r + 15).toFixed(1)}" font-size="12">${this._esc(nd.name.length > 5 ? nd.name.slice(0, 5) + '…' : nd.name)}</text>
          <text class="n-val" y="${(r + 28).toFixed(1)}" font-size="10">${nd.t.label} ${nd.aff > 0 ? '+' : ''}${nd.aff}</text>
        </g>`;
    }).join('');

    const guides = RING_RADII.map((r, k) => `
      <ellipse class="chart-guide" cx="${cx}" cy="${cy}" rx="${r}" ry="${(r * ELLIPSE).toFixed(1)}" />
      ${RING_LABELS[k] ? `<text class="chart-guide-label" x="${cx + r - 10}" y="${cy - 10}">${RING_LABELS[k]}</text>` : ''}
    `).join('');

    const legend = [
      ['挚友', 'var(--tmp-soul)'], ['好友', 'var(--tmp-friend)'], ['友好', 'var(--tmp-warm)'],
      ['中立', 'var(--tmp-neutral)'], ['冷淡', 'var(--tmp-cold)'], ['敌意', 'var(--tmp-hostile)'], ['仇恨', 'var(--tmp-hatred)']
    ].map(([label, color]) => `<span class="bc-lg-item" style="color:${color}"><i style="background:${color}"></i><span style="color:var(--text-tertiary)">${label}</span></span>`).join('');

    return `
      ${css}
      <div class="bc">
        <div class="bc-wrap${n > 30 ? ' dense' : ''}">
          <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="情感星图">
            <defs>
              <radialGradient id="bondCore" cx="50%" cy="50%" r="50%">
                <stop offset="0%" stop-color="rgba(235,97,63,0.35)" />
                <stop offset="100%" stop-color="rgba(235,97,63,0)" />
              </radialGradient>
            </defs>
            ${guides}
            ${links}
            <circle cx="${cx}" cy="${cy}" r="70" fill="url(#bondCore)" />
            <g class="chart-node" transform="translate(${cx},${cy})">
              <circle class="chart-core-ring" r="44" />
              <circle r="34" fill="rgba(14,18,24,0.95)" stroke="var(--c-shuiro)" stroke-width="2.4" />
              <text y="5" font-size="14" font-weight="800" fill="var(--c-shuiro)" stroke="none">${this._esc(String(player).slice(0, 2))}</text>
              <text y="56" font-size="13" font-weight="700">${this._esc(player)}</text>
            </g>
            ${circles}
          </svg>
          <div class="bc-hint">内环 = 情感更深 · 线宽 = 羁绊强度 · 点按星宿查看档案${n > 30 ? ' · 悬停查看数值' : ''}</div>
        </div>
        <div class="bc-legend">${legend}</div>
      </div>`;
  }

  _track(v){
    return ({balanced:'均衡',ninjutsu:'忍术领域',taijutsu:'体术修行',genjutsu:'幻术造诣',medical:'医疗支援',sensory:'情报感知',command:'指挥调度',infiltration:'潜入暗杀'}[v]) || '未定';
  }

  _esc(value) {
    return escHtml(value);
  }
  _escAttr(value) { return escAttr(value); }

  _renderTimeline(data, title, accentColor) {
    let entries = Array.isArray(data) ? data : (typeof data === 'string' && data.trim() ? [{ turn: 0, time: '', summary: data }] : []);
    // Normalize: if entries are plain strings, wrap them into objects
    entries = entries.map(e => {
      if (typeof e === 'string') return { turn: 0, time: '', summary: e };
      return e;
    }).filter(e => e && (e.summary || '').toString().trim());
    if (!entries.length) return '';
    const html = entries.slice(0, 10).map((e, i) => {
      const isLatest = i === 0;
      const timeStr = e.time ? `<span style="font-size:10px;color:rgba(255,255,255,0.25);margin-right:8px;">${this._esc(e.time)}</span>` : '';
      return `<div style="display:flex;align-items:flex-start;padding:${isLatest ? '10px 0' : '6px 0'};${!isLatest ? 'border-bottom:1px solid rgba(255,255,255,0.03);' : ''}">
        <div style="flex-shrink:0;width:8px;height:8px;border-radius:50%;background:#${accentColor};margin:5px 10px 0 0;opacity:${isLatest ? '1' : '0.4'};${isLatest ? 'box-shadow:0 0 6px #' + accentColor : ''};"></div>
        <div style="flex:1;min-width:0;">
          ${timeStr}
          <span style="font-size:${isLatest ? '13' : '12'}px;color:${isLatest ? '#e8e4d9' : '#a39f98'};line-height:1.6;${isLatest ? 'font-weight:500' : ''};">${this._esc(e.summary)}</span>
        </div>
      </div>`;
    }).join('');
    return `<div style="margin-bottom:24px;">
      <div style="font-size:11px;font-weight:700;color:rgba(255,255,255,0.4);text-transform:uppercase;letter-spacing:1px;margin-bottom:12px;">${title}</div>
      <div style="background:rgba(0,0,0,0.25);border-radius:8px;padding:8px 16px;border:1px solid rgba(255,255,255,0.04);">${html}</div>
    </div>`;
  }
}

customElements.define('info-panel', InfoPanel);
export default InfoPanel;


